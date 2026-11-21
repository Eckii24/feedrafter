import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { PgBoss } from 'pg-boss';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { provisionScoreQueue, SCORE_QUEUE, ScoreAdmission } from '../../src/server/adapters/postgres/score-admission.js';
import { ScoreStore } from '../../src/server/adapters/postgres/score-store.js';
import { ScoreTaskInputStore } from '../../src/server/adapters/postgres/score-task-input-store.js';
import { startScoreWorker } from '../../src/server/adapters/postgres/score-worker.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { UsageAttemptError } from '../../src/server/application/usage.js';
import type { AiPort } from '../../src/server/ports/ai.js';
import { buildHttpApp } from '../../src/server/http/app.js';
import { buildApplication } from '../../src/server/composition-root.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();
const score = '10000000-0000-4000-8000-000000000001';
const classifier = { model: { provider: 'fake', model: 'classifier' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: () => 1 };
const models = { classifier, generator: { ...classifier, model: { provider: 'fake', model: 'generator' } } };
let container = '';
let database: ReturnType<typeof createDatabase>;
let boss: PgBoss;
let context: string;
let databaseUrl: string;

async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(50); }
  throw new Error('Timed out');
}

beforeAll(async () => {
  container = docker('run', '--detach', '--rm', '--pull=never', '--name', `feedrafter-score-worker-${randomUUID()}`,
    '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
  const port = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'));
  if (!port) throw new Error('Unexpected PostgreSQL port');
  const url = `postgresql://postgres:disposable-test-only@127.0.0.1:${port[1]}/feedrafter_test`;
  databaseUrl = url;
  database = createDatabase(url);
  await eventually(async () => { try { await database.pool.query('select 1'); return true; } catch { return false; } });
  const version = Number((await database.pool.query('show server_version_num')).rows[0].server_version_num);
  expect(version).toBeGreaterThanOrEqual(180000); expect(version).toBeLessThan(190000);
  await migrateDatabase(database.pool);
  boss = new PgBoss({ connectionString: url }); boss.on('error', () => {}); await boss.start();
  await provisionScoreQueue(boss);
  await database.pool.query("update model_roles set provider='fake', model=case role when 'scores' then 'classifier' else 'generator' end where role in ('scores','context_reduction')");
  await database.pool.query('update score_definitions set active=(id=$1), deleted_at=null, include_title=true, include_content=true, include_category=false, include_tag_weights=false, include_source_weight=false', [score]);
  context = (await database.pool.query("insert into import_contexts(instance,account) values ('score-worker','test') returning id")).rows[0].id;
}, 30000);

afterAll(async () => {
  try { if (boss) await boss.stop(); if (database) await database.close(); }
  finally { if (container) docker('rm', '--force', container); }
});

async function fixture() {
  const article = (await database.pool.query("insert into articles(context_id,freshrss_id,title,imported_at) values ($1,$2,'Title',now()) returning id", [context, randomUUID()])).rows[0].id as string;
  await new ContentStore(database.db).saveSuccessful(article, { text: 'Body', quality: 'usable', capturedAt: new Date() });
  const scores = new ScoreStore(database.db);
  await scores.saveSuccessful({ articleId: article, scoreId: score, value: 25, calculatedAt: new Date(), contentRevision: 1, assignmentRevision: 0 });
  const admit = async () => {
    const result = await new ScoreAdmission(database.db, boss).admit(article);
    if (result.result !== 'ok' || result.tasks.length !== 1) throw new Error('Expected one score task');
    return result.tasks[0]!;
  };
  return { article, scores, admit };
}

async function job(id: string) {
  return (await database.pool.query('select state,retry_count,retry_limit from pgboss.job where id=$1', [id])).rows[0];
}
async function completed(id: string) { await eventually(async () => (await job(id))?.state === 'completed'); }
async function bounded(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('close timed out')), 5000); })]);
  } finally { clearTimeout(timer); }
}
function fakeAi() {
  return {
    classify: vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'completed', value: { answers: { score: { type: 'score', score: 3, confidence: 1, criteria: [] } }, usage: null } }),
    generate: vi.fn<AiPort['generate']>(), createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>(),
  };
}

it('provisions the static score queue through the explicit migrate command', async () => {
  await database.pool.query('create database feedrafter_score_migrate_test');
  const url = new URL(databaseUrl); url.pathname = '/feedrafter_score_migrate_test';
  execFileSync(process.execPath, ['--import', 'tsx', 'src/server/main.ts', 'migrate'], { cwd: process.cwd(), timeout: 30000, env: { ...process.env, DATABASE_URL: url.toString(), APP_ORIGIN: 'http://localhost:3000', FRESHRSS_ENABLED: 'false', KARAKEEP_ENABLED: 'false' } });
  const migrated = createDatabase(url.toString());
  try {
    const rows = (await migrated.pool.query('select name from pgboss.queue where name=$1', [SCORE_QUEUE])).rows;
    expect(rows).toEqual([{ name: SCORE_QUEUE }]);
  } finally { await migrated.close(); }
}, 45000);

it('admits through HTTP and completes only active targets; normal composition stays dormant', async () => {
  const headers = { host: 'localhost:3000' };
  const f = await fixture();
  await database.pool.query("insert into score_definitions(name,description,prompt,active,deleted_at) values ('inactive','','p',false,null),('deleted','','p',true,now())");
  const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [], scoreAdmission: new ScoreAdmission(database.db, boss) });
  const post = (id: string, payload: object = {}) => app.inject({ method: 'POST', url: `/api/v1/articles/${id}/reevaluations`, headers, payload });
  const ai = fakeAi();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const stream = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => get({ host: '127.0.0.1', port: address.port, path: '/api/v1/events', headers }, resolve).on('error', reject));
  let events = ''; stream.on('data', chunk => { events += chunk.toString(); });
  try {
    expect((await post(randomUUID())).statusCode).toBe(404);
    expect((await post(f.article, { extra: true })).statusCode).toBe(400);
    const first = await post(f.article); expect(first.statusCode).toBe(202);
    expect(first.json().tasks).toEqual([{ taskId: expect.any(String), scoreTargetId: score, generation: 1, state: 'queued' }]);
    const second = await post(f.article); expect(second.statusCode).toBe(202);
    const task = second.json().tasks[0];
    expect(task).toEqual({ taskId: expect.any(String), scoreTargetId: score, generation: 2, state: 'queued' });
    expect((await new TaskStore(database.db).getTask(first.json().tasks[0].taskId))?.state).toBe('superseded');
    const rows = (await database.pool.query("select j.retry_limit, j.data from pgboss.job j join processing_tasks t on j.id=t.job_id where t.article_id=$1", [f.article])).rows;
    expect(rows).toHaveLength(2); expect(rows.every(row => row.retry_limit === 0)).toBe(true);
    const worker = await startScoreWorker({ ...database, boss, ai, resolveModels: async () => models });
    try {
      await eventually(async () => (await new TaskStore(database.db).getTask(task.taskId))?.state === 'succeeded');
      const status = await app.inject({ url: `/api/v1/processing-tasks/${task.taskId}`, headers });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({ id: task.taskId, articleId: f.article, action: 'scores', scoreTargetId: score, generation: 2, state: 'succeeded', errorCode: null, createdAt: expect.any(String), updatedAt: expect.any(String), endedAt: expect.any(String) });
      expect(ai.classify).toHaveBeenCalledOnce();
      await eventually(async () => events.split('\n').filter(line => line.includes(`"entityId":"${task.taskId}"`)).length >= 2);
    } finally { await worker.close(); }
    const unknown = (await database.pool.query("insert into processing_tasks(article_id,action,state,created_at,updated_at) values ($1,'unknown','queued',now(),now()) returning id", [f.article])).rows[0].id;
    expect((await app.inject({ url: `/api/v1/processing-tasks/${unknown}`, headers })).statusCode).toBe(404);
    await database.pool.query('update score_definitions set active=false');
    expect((await post(f.article)).json()).toEqual({ tasks: [] });
    await database.pool.query('update score_definitions set active=true where id=$1', [score]);
    const unavailable = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [] });
    try { expect((await unavailable.inject({ method: 'POST', url: `/api/v1/articles/${f.article}/reevaluations`, headers, payload: {} })).statusCode).toBe(503); } finally { await unavailable.close(); }
  } finally { stream.destroy(); await app.close(); }
  const articleQueues = ['category', 'tags'];
  const queues = async () => (await database.pool.query('select name from pgboss.queue where name = any($1::text[])', [articleQueues])).rows;
  expect(await queues()).toEqual([]);
  const runtime = vi.spyOn(ModelRuntime, 'create');
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const createQueue = vi.spyOn(PgBoss.prototype, 'createQueue');
  const work = vi.spyOn(PgBoss.prototype, 'work');
  let application: Awaited<ReturnType<typeof buildApplication>> | undefined;
  try {
    application = await buildApplication({ databaseUrl, origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, trustedProxies: [] });
    expect(await queues()).toEqual([]);
    for (const name of articleQueues) {
      expect(createQueue.mock.calls.map(([queue]) => queue)).not.toContain(name);
      expect(work.mock.calls.map(([queue]) => queue)).not.toContain(name);
    }
    expect(createQueue.mock.calls.map(([name]) => name)).not.toContain(SCORE_QUEUE);
    expect(work.mock.calls.map(([name]) => name)).not.toContain(SCORE_QUEUE);
    const result = await application.app.inject({ method: 'POST', url: `/api/v1/articles/${f.article}/reevaluations`, headers, payload: {} });
    expect(result.statusCode).toBe(503);
    expect(runtime).not.toHaveBeenCalled(); expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    try { await application?.close(); }
    finally { runtime.mockRestore(); fetchSpy.mockRestore(); createQueue.mockRestore(); work.mockRestore(); }
  }
}, 30000);

it('completes misrouted category and tags jobs without claiming either task', async () => {
  await database.pool.query("delete from pgboss.job where name=$1 and state='created'", [SCORE_QUEUE]);
  const f = await fixture();
  const tasks = new TaskStore(database.db);
  const at = new Date();
  const rows = await Promise.all((['category', 'tags'] as const).map(action => tasks.createTask({ articleId: f.article, action, generation: 1, state: 'queued', createdAt: at, updatedAt: at })));
  const jobs = await Promise.all(rows.map(row => boss.send(SCORE_QUEUE, { taskId: row.id }, { retryLimit: 0 })));
  expect(jobs.every(Boolean)).toBe(true);
  const ai = fakeAi();
  const resolveModels = vi.fn(async () => models);
  const worker = await startScoreWorker({ ...database, boss, ai, resolveModels });
  try {
    for (const id of jobs) await completed(id!);
    for (const row of rows) expect(await tasks.getTask(row.id)).toMatchObject({ state: 'queued', executionToken: null, attemptCount: 0 });
    expect(resolveModels).not.toHaveBeenCalled();
    expect(ai.classify).not.toHaveBeenCalled(); expect(ai.generate).not.toHaveBeenCalled();
  } finally { await worker.close(); }
}, 30000);

it('delivers admitted jobs once, honors task fences and drains only its worker', async () => {
  const ai = fakeAi();
  const resolveModels = vi.fn(async () => models as typeof models | null);
  const tasks = new TaskStore(database.db);
  const load = vi.spyOn(ScoreTaskInputStore.prototype, 'loadResult');
  const f = await fixture();
  ai.classify.mockImplementation(async () => {
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      await client.query("set local lock_timeout='1s'");
      await client.query('select id from articles where id=$1 for update', [f.article]);
      await client.query('rollback');
    } finally { client.release(); }
    return { kind: 'completed', value: { answers: { score: { type: 'score', score: 3, confidence: 1, criteria: [] } }, usage: null } };
  });
  const old = await f.admit();
  const current = await f.admit();
  expect(resolveModels).not.toHaveBeenCalled();
  const worker = await startScoreWorker({ ...database, boss, ai, resolveModels });
  try {
    await completed(old.jobId!); await completed(current.jobId!);
    expect(await tasks.getTask(old.id)).toMatchObject({ state: 'superseded', attemptCount: 0 });
    expect(await tasks.getTask(current.id)).toMatchObject({ state: 'succeeded', attemptCount: 1 });
    expect(await f.scores.get(f.article, score)).toMatchObject({ value: 75, contentRevision: 1 });
    expect(resolveModels).toHaveBeenCalledOnce();
    expect(ai.classify).toHaveBeenCalledOnce();
    expect(ai.classify.mock.calls[0]![0].state).toEqual({ title: 'Title', content: 'Body' });
    const signal = load.mock.calls[0]![3];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(ai.classify.mock.calls[0]![1]).toMatchObject({ taskId: current.id, signal });
    expect(await job(old.jobId!)).toMatchObject({ state: 'completed', retry_count: 0, retry_limit: 0 });
    expect(await job(current.jobId!)).toMatchObject({ state: 'completed', retry_count: 0, retry_limit: 0 });

    resolveModels.mockResolvedValue(null);
    const missing = await fixture(); const missingTask = await missing.admit();
    await completed(missingTask.jobId!);
    expect(await tasks.getTask(missingTask.id)).toMatchObject({ state: 'needs_input', errorCode: 'configuration_required', attemptCount: 1 });
    expect((await missing.scores.get(missing.article, score))?.value).toBe(25);
    expect(ai.classify).toHaveBeenCalledOnce(); expect(ai.generate).not.toHaveBeenCalled(); expect(ai.createRestrictedSession).not.toHaveBeenCalled();

    resolveModels.mockResolvedValue(models);
    ai.classify.mockRejectedValue(new UsageAttemptError('fixture', 'uncertain'));
    const failed = await fixture(); const failedTask = await failed.admit();
    await completed(failedTask.jobId!);
    expect(await tasks.getTask(failedTask.id)).toMatchObject({ state: 'failed', errorCode: 'dispatch_uncertain', attemptCount: 1 });
    expect((await failed.scores.get(failed.article, score))?.value).toBe(25);
    expect(await job(failedTask.jobId!)).toMatchObject({ state: 'completed', retry_count: 0, retry_limit: 0 });
    expect(ai.classify).toHaveBeenCalledTimes(2);

    // Supersede a running delivery while inference is outside the input transaction.
    const racing = await fixture();
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    ai.classify.mockImplementation(async () => {
      entered = true; await gate;
      return { kind: 'completed', value: { answers: { score: { type: 'score', score: 4, confidence: 1, criteria: [] } }, usage: null } };
    });
    const racingTask = await racing.admit();
    try {
      await eventually(async () => entered);
      const successor = await racing.admit();
      let closed = false;
      const closing = worker.close().then(() => { closed = true; });
      await delay(100);
      expect(closed).toBe(false);
      release();
      await bounded(closing);
      expect(await tasks.getTask(racingTask.id)).toMatchObject({ state: 'superseded', attemptCount: 1 });
      expect((await racing.scores.get(racing.article, score))?.value).toBe(25);
      expect(await job(racingTask.jobId!)).toMatchObject({ state: 'completed', retry_count: 0 });
      expect(await tasks.getTask(successor.id)).toMatchObject({ state: 'queued', attemptCount: 0 });
    } finally { release(); }
    const afterClose = await fixture(); const queued = await afterClose.admit();
    await delay(2500);
    expect(await tasks.getTask(queued.id)).toMatchObject({ state: 'queued', attemptCount: 0 });
    expect((await job(queued.jobId!)).state).toBe('created');
    expect(boss.getWipData().filter(w => w.name === SCORE_QUEUE)).toHaveLength(0);
  } finally { await worker.close(); load.mockRestore(); }
}, 60000);

it('settles resolver failure once and respects ownership loss while resolving', async () => {
  await database.pool.query("delete from pgboss.job where name=$1 and state='created'", [SCORE_QUEUE]);
  const f = await fixture(); const task = await f.admit();
  const previous = await f.scores.get(f.article, score);
  const ai = fakeAi();
  const resolveModels = vi.fn(async (): Promise<typeof models | null> => { throw new Error('secret configuration detail'); });
  const load = vi.spyOn(ScoreTaskInputStore.prototype, 'loadResult');
  const publish = vi.spyOn(ScoreStore.prototype, 'publishCandidate');
  const update = vi.spyOn(TaskStore.prototype, 'updateOwnedTask');
  const worker = await startScoreWorker({ ...database, boss, ai, resolveModels });
  try {
    await completed(task.jobId!);
    const record = await new TaskStore(database.db).getTask(task.id);
    expect(record).toMatchObject({ state: 'failed', errorCode: 'score_configuration_failure', attemptCount: 1 });
    expect(record!.endedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(record)).not.toContain('secret configuration detail');
    expect(await f.scores.get(f.article, score)).toEqual(previous);
    expect(update.mock.calls.filter(([id]) => id === task.id)).toHaveLength(1);
    expect(resolveModels).toHaveBeenCalledOnce();
    expect(await job(task.jobId!)).toMatchObject({ state: 'completed', retry_count: 0, retry_limit: 0 });

    const racing = await fixture();
    const before = await racing.scores.get(racing.article, score);
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    resolveModels.mockImplementation(async () => { entered = true; await gate; throw new Error('secret configuration detail'); });
    const racingTask = await racing.admit();
    try {
      await eventually(async () => entered);
      const newOwner = randomUUID();
      await database.pool.query('update processing_tasks set execution_token=$2 where id=$1', [racingTask.id, newOwner]);
      release();
      await completed(racingTask.jobId!);
      expect(await new TaskStore(database.db).getTask(racingTask.id)).toMatchObject({ state: 'running', executionToken: newOwner, errorCode: null, attemptCount: 1, endedAt: null });
      expect(await racing.scores.get(racing.article, score)).toEqual(before);
      expect(update.mock.calls.filter(([id]) => id === racingTask.id)).toHaveLength(1);
      expect(await job(racingTask.jobId!)).toMatchObject({ state: 'completed', retry_count: 0, retry_limit: 0 });
    } finally { release(); }
    expect(load).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
    expect(ai.classify).not.toHaveBeenCalled(); expect(ai.generate).not.toHaveBeenCalled(); expect(ai.createRestrictedSession).not.toHaveBeenCalled();
  } finally { await worker.close(); load.mockRestore(); publish.mockRestore(); update.mockRestore(); }
}, 30000);

it('propagates pg-boss shutdown cancellation to in-flight inference', async () => {
  await database.pool.query("delete from pgboss.job where name=$1 and state='created'", [SCORE_QUEUE]);
  const f = await fixture(); const task = await f.admit();
  const ai = fakeAi();
  let received: AbortSignal | undefined;
  let aborted = false;
  ai.classify.mockImplementation(async (_request, options) => {
    received = options.signal;
    await new Promise<void>(resolve => {
      if (received!.aborted) { resolve(); return; }
      received!.addEventListener('abort', () => resolve(), { once: true });
    });
    aborted = true;
    throw new UsageAttemptError('fixture', 'aborted');
  });
  const load = vi.spyOn(ScoreTaskInputStore.prototype, 'loadResult');
  const worker = await startScoreWorker({ ...database, boss, ai, resolveModels: async () => models });
  try {
    await eventually(async () => received !== undefined);
    expect(received).toBe(load.mock.calls[0]![3]);
    expect(received!.aborted).toBe(false);
    await boss.stop({ graceful: false });
    await eventually(async () => aborted);
    await eventually(async () => (await new TaskStore(database.db).getTask(task.id))?.state === 'failed');
    expect(received!.aborted).toBe(true);
    expect(await new TaskStore(database.db).getTask(task.id)).toMatchObject({ state: 'failed', errorCode: 'cancelled_before_dispatch', attemptCount: 1 });
    expect((await f.scores.get(f.article, score))?.value).toBe(25);
    expect(ai.classify).toHaveBeenCalledOnce();
  } finally { await worker.close(); load.mockRestore(); }
}, 30000);
