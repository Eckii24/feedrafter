import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { enqueueScoreTask, provisionScoreQueue, SCORE_QUEUE, ScoreAdmission } from '../../src/server/adapters/postgres/score-admission.js';
import { processingTasks } from '../../src/server/adapters/postgres/schema/index.js';
import { ScoreStore } from '../../src/server/adapters/postgres/score-store.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();
let container = '';
let database: ReturnType<typeof createDatabase>;
let boss: PgBoss;
let admission: ScoreAdmission;
let article: string;
let targets: string[];
const now = new Date('2026-01-01T00:00:00Z');
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(50); }
  throw new Error('Timed out');
}
async function admitted(id = article) {
  const result = await admission.admit(id, now);
  if (result.result !== 'ok') throw new Error('missing article');
  return result.tasks;
}
async function jobs(id = article) {
  return (await database.pool.query("select j.id, j.data, j.state, j.retry_limit from pgboss.job j join processing_tasks t on t.id::text=j.data->>'taskId' where j.name=$1 and t.article_id=$2 order by j.id", [SCORE_QUEUE, id])).rows;
}

beforeAll(async () => {
  container = docker('run', '--detach', '--rm', '--pull=never', '--name', `feedrafter-score-admission-${randomUUID()}`,
    '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
  const match = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'));
  if (!match) throw new Error('Unexpected PostgreSQL port');
  const url = `postgresql://postgres:disposable-test-only@127.0.0.1:${match[1]}/feedrafter_test`;
  database = createDatabase(url);
  await eventually(async () => { try { await database.pool.query('select 1'); return true; } catch { return false; } });
  const version = Number((await database.pool.query('show server_version_num')).rows[0].server_version_num);
  expect(version).toBeGreaterThanOrEqual(180000); expect(version).toBeLessThan(190000);
  await migrateDatabase(database.pool);
  boss = new PgBoss({ connectionString: url }); boss.on('error', () => {}); await boss.start();
  await provisionScoreQueue(boss);
  admission = new ScoreAdmission(database.db, boss);
}, 30000);

afterAll(async () => {
  try { if (boss) await boss.stop(); if (database) await database.close(); }
  finally { if (container) docker('rm', '--force', container); }
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await database.pool.query('delete from pgboss.job');
  await database.pool.query('update score_definitions set active=false');
  const context = (await database.pool.query("insert into import_contexts(instance,account) values ($1,'account') returning id", [randomUUID()])).rows[0].id;
  article = (await database.pool.query("insert into articles(context_id,freshrss_id,imported_at) values ($1,'item',now()) returning id", [context])).rows[0].id;
  targets = (await database.pool.query("insert into score_definitions(name,description,prompt) values ('one','','prompt'),('two','','prompt') returning id")).rows.map(r => r.id as string).sort();
});

it('snapshots only active nondeleted targets, persists ordinary jobs before any consumer, and handles empty and missing', async () => {
  await database.pool.query("insert into score_definitions(name,description,prompt,active,deleted_at) values ('inactive','','p',false,null),('deleted','','p',true,now())");
  const tasks = await admitted();
  expect(tasks.map(t => t.scoreTargetId)).toEqual(targets);
  expect(tasks.every(t => t.generation === 1 && t.state === 'queued' && t.prerequisiteId === null && t.jobId)).toBe(true);
  expect(await jobs()).toEqual(expect.arrayContaining(tasks.map(t => ({ id: t.jobId, data: { taskId: t.id }, state: 'created', retry_limit: 0 }))));
  const send = vi.spyOn(boss, 'send');
  expect(await admission.admit(randomUUID())).toEqual({ result: 'not_found' });
  await database.pool.query('update score_definitions set active=false');
  expect(await admission.admit(article)).toEqual({ result: 'ok', tasks: [] });
  expect(await admission.admit(randomUUID())).toEqual({ result: 'not_found' });
  expect(send).not.toHaveBeenCalled();
  expect(await jobs()).toHaveLength(2);
});

it('increments over all history, supersedes every unfinished state, and preserves published scores and terminal rows', async () => {
  const states = ['waiting_dependency', 'queued', 'running', 'retry_wait', 'paused_budget', 'paused_auth', 'needs_input', 'failed', 'succeeded', 'superseded'];
  for (const [i, state] of states.entries()) await database.pool.query('insert into processing_tasks(article_id,action,score_target_id,generation,state,created_at,updated_at) values ($1,\'scores\',$2,$3,$4,$5,$5)', [article, targets[0], i, state, now]);
  await database.pool.query('insert into article_scores(article_id,score_id,value,calculated_at,content_revision,assignment_revision) values ($1,$2,42,$3,0,0)', [article, targets[0], now]);
  const before = (await database.pool.query('select * from article_scores where article_id=$1', [article])).rows;
  const tasks = await admitted();
  expect(tasks.find(t => t.scoreTargetId === targets[0])?.generation).toBe(10);
  expect(tasks.find(t => t.scoreTargetId === targets[1])?.generation).toBe(1);
  const old = (await database.pool.query('select state,ended_at from processing_tasks where article_id=$1 and score_target_id=$2 and generation<10 order by generation', [article, targets[0]])).rows;
  expect(old.slice(0, 7)).toEqual(states.slice(0, 7).map(() => ({ state: 'superseded', ended_at: now })));
  expect(old.slice(7).map(r => r.state)).toEqual(states.slice(7));
  expect((await database.pool.query('select * from article_scores where article_id=$1', [article])).rows).toEqual(before);
  await new TaskStore(database.db).claimTask(tasks[0]!.id, randomUUID(), now);
  const again = await admitted();
  for (const t of tasks) expect((await new TaskStore(database.db).getTask(t.id))?.state).toBe('superseded');
  expect(again.map(t => t.generation)).toEqual(tasks.map(t => t.generation + 1));
});

it('honors removed and added definitions between calls and retains removed tasks', async () => {
  const first = await admitted();
  await database.pool.query('update score_definitions set active=false where id=$1', [targets[0]]);
  const added = (await database.pool.query("insert into score_definitions(name,description,prompt) values ('new','','p') returning id")).rows[0].id;
  const second = await admitted();
  expect(second.map(t => t.scoreTargetId).sort()).toEqual([targets[1], added].sort());
  expect(second.find(t => t.scoreTargetId === targets[1])?.generation).toBe(2);
  expect(second.find(t => t.scoreTargetId === added)?.generation).toBe(1);
  expect((await new TaskStore(database.db).getTask(first.find(t => t.scoreTargetId === targets[0])!.id))?.state).toBe('queued');
});

it('serializes concurrent admissions and never duplicates a generation', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => admitted()));
  for (const target of targets) expect(results.map(rows => rows.find(t => t.scoreTargetId === target)!.generation).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect((await database.pool.query("select count(*)::int n from processing_tasks where article_id=$1 and state='queued'", [article])).rows[0].n).toBe(2);
});

it('enqueues in a caller-owned transaction and rolls back task, job ID and real job together', async () => {
  let taskId: string | undefined;
  let jobId: string | null = null;
  await expect(database.db.transaction(async tx => {
    const [task] = await tx.insert(processingTasks).values({ articleId: article, action: 'scores', scoreTargetId: targets[0],
      generation: 1, state: 'queued', createdAt: now, updatedAt: now }).returning();
    taskId = task!.id;
    const saved = await enqueueScoreTask(tx, boss, taskId);
    jobId = saved.jobId;
    expect(jobId).toBeTruthy();
    throw new Error('caller rollback');
  })).rejects.toThrow('caller rollback');
  expect(taskId).toBeTruthy();
  expect(jobId).toBeTruthy();
  expect((await database.pool.query('select id from processing_tasks where id=$1', [taskId])).rows).toHaveLength(0);
  expect((await database.pool.query('select id from pgboss.job where id=$1', [jobId])).rows).toHaveLength(0);
});

it('rolls back supersession, tasks and first real job when the second send fails', async () => {
  const first = await admitted();
  const send = boss.send.bind(boss);
  let count = 0;
  let sentId: string | null = null;
  vi.spyOn(boss, 'send').mockImplementation(async (...args) => { if (++count === 2) throw new Error('second send'); sentId = await send(...args); return sentId; });
  await expect(admitted()).rejects.toThrow('second send');
  expect(sentId).toBeTruthy();
  expect((await database.pool.query('select id from pgboss.job where id=$1', [sentId])).rows).toHaveLength(0);
  expect(await jobs()).toHaveLength(2);
  expect((await database.pool.query('select id,state from processing_tasks where article_id=$1 order by id', [article])).rows).toEqual(first.map(t => ({ id: t.id, state: 'queued' })).sort((a, b) => a.id.localeCompare(b.id)));
});

it.each([null, 'not-a-uuid'])('rejects an invalid send result and rolls back its real job: %s', async result => {
  const send = boss.send.bind(boss);
  let sentId: string | null = null;
  vi.spyOn(boss, 'send').mockImplementation(async (...args) => { sentId = await send(...args); return result; });
  await expect(admitted()).rejects.toThrow('Score job was not enqueued');
  expect(sentId).toBeTruthy();
  expect((await database.pool.query('select id from pgboss.job where id=$1', [sentId])).rows).toHaveLength(0);
  expect((await database.pool.query('select id from processing_tasks where article_id=$1', [article])).rows).toHaveLength(0);
});

it('rejects a different valid persisted job ID and rolls back the real job and supersession', async () => {
  const previous = await admitted();
  const before = (await database.pool.query('select * from processing_tasks where article_id=$1 order by id', [article])).rows;
  const beforeJobs = await jobs();
  const wrongId = randomUUID();
  await database.pool.query(`create function substitute_score_job_id() returns trigger language plpgsql as $$ begin
    if new.article_id = '${article}'::uuid and new.job_id is not null then new.job_id := '${wrongId}'::uuid; end if;
    return new; end $$`);
  await database.pool.query('create trigger substitute_score_job_id before update of job_id on processing_tasks for each row execute function substitute_score_job_id()');
  const send = vi.spyOn(boss, 'send');
  try {
    await expect(admitted()).rejects.toThrow('Score job ID update failed');
    expect(send).toHaveBeenCalledTimes(1);
    expect((await database.pool.query('select * from processing_tasks where article_id=$1 order by id', [article])).rows).toEqual(before);
    expect(await jobs()).toEqual(beforeJobs);
    expect(previous).toHaveLength(2);
  } finally { await database.pool.query('drop trigger substitute_score_job_id on processing_tasks; drop function substitute_score_job_id()'); }
});

it('rolls back jobs on post-send commit failure', async () => {
  await database.pool.query(`create function fail_score_commit() returns trigger language plpgsql as $$ begin if new.article_id = '${article}'::uuid then raise exception 'commit failure'; end if; return null; end $$`);
  await database.pool.query('create constraint trigger fail_score_commit after insert on processing_tasks deferrable initially deferred for each row execute function fail_score_commit()');
  const send = vi.spyOn(boss, 'send');
  try {
    await expect(admitted()).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(2);
    expect((await database.pool.query('select * from processing_tasks where article_id=$1', [article])).rows).toHaveLength(0);
    for (const call of send.mock.calls) expect((await database.pool.query('select * from pgboss.job where data->>\'taskId\'=$1', [(call[1] as { taskId: string }).taskId])).rows).toHaveLength(0);
  } finally { await database.pool.query('drop trigger fail_score_commit on processing_tasks; drop function fail_score_commit()'); }
});

it('rejects generation overflow without changing history or creating jobs', async () => {
  await database.pool.query("insert into processing_tasks(article_id,action,score_target_id,generation,state,created_at,updated_at) values ($1,'scores',$2,2147483647,'failed',now(),now())", [article, targets[0]]);
  await expect(admitted()).rejects.toThrow('overflow');
  expect(await jobs()).toHaveLength(0);
  expect((await database.pool.query('select count(*)::int n from processing_tasks where article_id=$1', [article])).rows[0].n).toBe(1);
});

it('fences a real worker claim after supersession and blocks old publication', async () => {
  await database.pool.query('update score_definitions set active=false where id=$1', [targets[1]]);
  const [old] = await admitted();
  const token = randomUUID();
  const epoch = (await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision;
  const store = new TaskStore(database.db);
  expect(await store.claimTask(old!.id, token, now)).not.toBeNull();
  const candidate = { value: 99, coverage: [] as never, basis: { taskId: old!.id, executionToken: token, scoreId: targets[0]!, articleId: article, contentRevision: 0, assignmentRevision: 0, catalogEpoch: epoch, generation: old!.generation, condensed: false as const, limited: false as const } };
  await database.pool.query('insert into article_scores(article_id,score_id,value,calculated_at,content_revision,assignment_revision) values ($1,$2,42,$3,0,0)', [article, targets[0], now]);
  // Simulate a retry delivery while retaining the earlier execution token.
  await database.pool.query("update processing_tasks set state='retry_wait' where id=$1", [old!.id]);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sent = new Promise<void>(resolve => { entered = resolve; });
  const send = boss.send.bind(boss);
  vi.spyOn(boss, 'send').mockImplementation(async (...args) => { const id = await send(...args); entered(); await gate; return id; });
  const pending = admitted();
  let observed: unknown = undefined;
  try {
    await sent; // Supersession is uncommitted and holds the old task lock.
    await boss.work<{ taskId: string }>(SCORE_QUEUE, { pollingIntervalSeconds: 0.5 }, async jobs => {
      for (const job of jobs) if (job.data.taskId === old!.id) observed = await store.claimTask(job.data.taskId, randomUUID(), new Date());
    });
    await eventually(async () => (await database.pool.query("select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and query like 'update %processing_tasks%'")).rows[0].n > 0);
    release();
    await pending;
    await eventually(async () => observed !== undefined);
    expect(observed).toBeNull();
    expect(await new ScoreStore(database.db).publishCandidate(candidate, now)).toBe(false);
    expect((await new ScoreStore(database.db).get(article, targets[0]!))?.value).toBe(42);
  } finally { release(); await pending; await boss.offWork(SCORE_QUEUE); }
}, 30000);

it.each(['admission', 'publication'] as const)('serializes %s first against score publication without an old overwrite', async first => {
  await database.pool.query('update score_definitions set active=false where id=$1', [targets[1]]);
  const [old] = await admitted();
  const token = randomUUID();
  await new TaskStore(database.db).claimTask(old!.id, token, now);
  const epoch = (await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision;
  const candidate = { value: 99, coverage: [] as never, basis: { taskId: old!.id, executionToken: token, scoreId: targets[0]!, articleId: article, contentRevision: 0, assignmentRevision: 0, catalogEpoch: epoch, generation: old!.generation, condensed: false as const, limited: false as const } };
  await database.pool.query('insert into article_scores(article_id,score_id,value,calculated_at,content_revision,assignment_revision) values ($1,$2,42,$3,0,0)', [article, targets[0], now]);
  const blocker = await database.pool.connect();
  let committed = false;
  try {
    await blocker.query('begin');
    if (first === 'admission') await blocker.query('select id from articles where id=$1 for update', [article]);
    else await blocker.query('select article_id from article_scores where article_id=$1 and score_id=$2 for update', [article, targets[0]]);
    const waiting = async (n: number) => eventually(async () => (await database.pool.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'")).rows[0].n >= n);
    const scores = new ScoreStore(database.db);
    const earlier = first === 'admission' ? admitted() : scores.publishCandidate(candidate, now);
    await waiting(1);
    const later = first === 'admission' ? scores.publishCandidate(candidate, now) : admitted();
    await waiting(2);
    await blocker.query('commit'); committed = true;
    const [a, b] = await Promise.all([earlier, later]);
    expect(first === 'admission' ? b : a).toBe(first === 'publication');
    expect((await scores.get(article, targets[0]!))?.value).toBe(first === 'admission' ? 42 : 99);
    expect((await new TaskStore(database.db).getTask(old!.id))?.state).toBe(first === 'admission' ? 'superseded' : 'succeeded');
    expect(await scores.publishCandidate(candidate, now)).toBe(false);
  } finally { if (!committed) await blocker.query('rollback'); blocker.release(); }
}, 30000);
