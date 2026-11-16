import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PgBoss } from 'pg-boss';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ArticleJobs } from '../../src/server/adapters/postgres/article-jobs.js';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { CategoryTaskInputStore } from '../../src/server/adapters/postgres/category-task-input-store.js';
import { CatalogStore } from '../../src/server/adapters/postgres/catalog-store.js';
import { ScoreStore } from '../../src/server/adapters/postgres/score-store.js';
import { categorize } from '../../src/server/application/categorize.js';
import type { AiPort } from '../../src/server/ports/ai.js';
import { articleFingerprint, readChainMetadata, readHandoffReceipt } from '../../src/server/domain/article-handoff.js';
import { fallbackCategoryId } from '../../src/shared/taxonomy.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();
const at = new Date('2026-01-01T00:00:00Z');
let container = '';
let database: ReturnType<typeof createDatabase>;
let boss: PgBoss;
let admission: ArticleJobs;
let article: string;
let prepare: string;
let targets: string[];

beforeAll(async () => {
  container = docker('run', '--detach', '--rm', '--pull=never', '--name', `feedrafter-article-jobs-${randomUUID()}`, '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
  const port = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'));
  if (!port) throw new Error('Unexpected PostgreSQL port');
  const url = `postgresql://postgres:disposable-test-only@127.0.0.1:${port[1]}/feedrafter_test`;
  database = createDatabase(url);
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await database.pool.query('select 1'); ready = true; break; } catch { await delay(200); } }
  if (!ready) throw new Error('PostgreSQL not ready');
  const version = Number((await database.pool.query('show server_version_num')).rows[0].server_version_num);
  expect(version).toBeGreaterThanOrEqual(180000); expect(version).toBeLessThan(190000);
  await migrateDatabase(database.pool);
  boss = new PgBoss({ connectionString: url }); boss.on('error', () => {}); await boss.start();
  await boss.createQueue('category');
  await boss.createQueue('tags');
  admission = new ArticleJobs(database.db, boss);
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
  article = (await database.pool.query("insert into articles(context_id,freshrss_id,imported_at,title) values ($1,'item',now(),'title') returning id", [context])).rows[0].id;
  targets = (await database.pool.query("insert into score_definitions(name,description,prompt) values ('one','','prompt'),('two','','prompt') returning id")).rows.map(r => r.id as string).sort();
  const store = new TaskStore(database.db);
  const task = await store.createTask({ articleId: article, action: 'prepare', generation: 1, createdAt: at, updatedAt: at });
  prepare = task.id;
  const token = randomUUID();
  await store.claimTask(prepare, token, at);
  expect(await new ContentStore(database.db).publishTask({ taskId: prepare, articleId: article, action: 'prepare', generation: 1, executionToken: token, expectedContentRevision: 0 }, { kind: 'success', content: { text: 'prepared', quality: 'usable', capturedAt: at }, at })).toBe(1);
});

it.each([['catalog', 0], ['catalog', 1], ['article jobs', 0], ['article jobs', 1]] as const)('persists and returns standalone category receipts through %s at generation %i', async (publisher, generation) => {
  for (const changed of [true, false]) {
    const id = (await database.pool.query("insert into articles(context_id,freshrss_id,imported_at,title) select context_id,$2,now(),'standalone' from articles where id=$1 returning id", [article, randomUUID()])).rows[0].id as string;
    await new ContentStore(database.db).saveSuccessful(id, { text: 'prepared', quality: 'usable', capturedAt: at });
    const tasks = new TaskStore(database.db);
    const task = await tasks.createTask({ articleId: id, action: 'category', generation, createdAt: at, updatedAt: at });
    const token = randomUUID();
    await tasks.claimTask(task.id, token, at);
    await database.pool.query('update processing_tasks set result=$2 where id=$1', [task.id, { other: { preserved: true } }]);
    const catalog = new CatalogStore(database.db);
    const categoryId = changed ? (await catalog.createCategory(`standalone-${randomUUID()}`)).id : fallbackCategoryId;
    const catalogEpoch = (await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision as number;
    const candidate = { taskId: task.id, executionToken: token, articleId: id, generation, prerequisiteId: null, contentRevision: 1, contentText: 'prepared', assignmentRevision: 0, catalogEpoch, categoryId };
    // Standalone has no captured fingerprint; the receipt records the locked row.
    await database.pool.query("update articles set title='current standalone' where id=$1", [id]);
    const published = await (publisher === 'catalog' ? catalog : admission).publishCategoryCandidate(candidate, at);
    const receipt = { version: 1, taskId: task.id, generation, action: 'category', articleId: id, prerequisiteId: null, categoryId,
      basis: { contentRevision: 1, assignmentRevision: changed ? 1 : 0, articleInputHash: articleFingerprint('current standalone', null) }, catalogEpoch };
    expect(published).toEqual({ assignmentRevision: changed ? 1 : 0, receipt });
    const stored = await tasks.getTask(task.id);
    expect(stored).toMatchObject({ state: 'succeeded' });
    expect(stored!.result).toEqual({ other: { preserved: true }, handoffReceipt: receipt });
    expect(readHandoffReceipt(stored!.result)).toEqual(receipt);
    expect(Object.hasOwn(stored!.result!, 'articleChain')).toBe(false);
    expect((await database.pool.query("select id from processing_tasks where article_id=$1 and action='tags'", [id])).rows).toEqual([]);
    expect((await database.pool.query("select id from pgboss.job where name='tags'")).rows).toEqual([]);
    expect((await database.pool.query('select category_id,assignment_revision from articles where id=$1', [id])).rows[0]).toEqual({ category_id: categoryId, assignment_revision: changed ? 1 : 0 });
  }
});

it('publishes a standalone category task at the permitted generation zero', async () => {
  const tasks = new TaskStore(database.db);
  const task = await tasks.createTask({ articleId: article, action: 'category', generation: 0, createdAt: at, updatedAt: at });
  const token = randomUUID();
  await tasks.claimTask(task.id, token, at);
  const epoch = (await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision as number;
  const candidate = { taskId: task.id, executionToken: token, articleId: article, generation: 0, prerequisiteId: null, contentRevision: 1, contentText: 'prepared', assignmentRevision: 0, catalogEpoch: epoch, categoryId: fallbackCategoryId };
  expect(await new CatalogStore(database.db).publishCategoryCandidate(candidate, at)).not.toBeNull();
});

it.each([['catalog', 0], ['catalog', 1], ['article jobs', 0], ['article jobs', 1]] as const)('rolls back standalone publication when receipt persistence fails through %s at generation %i', async (publisher, generation) => {
  const tasks = new TaskStore(database.db);
  const task = await tasks.createTask({ articleId: article, action: 'category', generation, createdAt: at, updatedAt: at });
  const token = randomUUID();
  await tasks.claimTask(task.id, token, at);
  await database.pool.query('update processing_tasks set result=$2 where id=$1', [task.id, { other: 'preserved' }]);
  const catalog = new CatalogStore(database.db);
  const categoryId = (await catalog.createCategory(`rollback-${randomUUID()}`)).id;
  const catalogEpoch = (await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision as number;
  const candidate = { taskId: task.id, executionToken: token, articleId: article, generation, prerequisiteId: null, contentRevision: 1, contentText: 'prepared', assignmentRevision: 0, catalogEpoch, categoryId };
  const beforeTask = await tasks.getTask(task.id);
  const beforeArticle = (await database.pool.query('select category_id,assignment_revision from articles where id=$1', [article])).rows[0];
  await database.pool.query(`create function strip_standalone_receipt() returns trigger language plpgsql as $$ begin if new.id = '${task.id}'::uuid then new.result = new.result - 'handoffReceipt'; end if; return new; end $$`);
  await database.pool.query('create trigger strip_standalone_receipt before update on processing_tasks for each row execute function strip_standalone_receipt()');
  try {
    await expect((publisher === 'catalog' ? catalog : admission).publishCategoryCandidate(candidate, at)).rejects.toThrow('Category task success update failed');
    expect(await tasks.getTask(task.id)).toEqual(beforeTask);
    expect((await database.pool.query('select category_id,assignment_revision from articles where id=$1', [article])).rows[0]).toEqual(beforeArticle);
  } finally {
    await database.pool.query('drop trigger strip_standalone_receipt on processing_tasks; drop function strip_standalone_receipt()');
  }
});

it.each(['catalog', 'article jobs'] as const)('rolls back a written generation-zero receipt at commit through %s', async publisher => {
  const tasks = new TaskStore(database.db);
  const task = await tasks.createTask({ articleId: article, action: 'category', generation: 0, createdAt: at, updatedAt: at });
  const token = randomUUID();
  await tasks.claimTask(task.id, token, at);
  await database.pool.query('update processing_tasks set result=$2 where id=$1', [task.id, { other: 'preserved' }]);
  const catalog = new CatalogStore(database.db);
  const categoryId = (await catalog.createCategory(`commit-rollback-${randomUUID()}`)).id;
  const catalogEpoch = (await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision as number;
  const candidate = { taskId: task.id, executionToken: token, articleId: article, generation: 0, prerequisiteId: null, contentRevision: 1, contentText: 'prepared', assignmentRevision: 0, catalogEpoch, categoryId };
  const beforeTask = await tasks.getTask(task.id);
  const beforeArticle = (await database.pool.query('select category_id,assignment_revision from articles where id=$1', [article])).rows[0];
  await database.pool.query(`create function fail_standalone_commit() returns trigger language plpgsql as $$ begin if new.id = '${task.id}'::uuid and new.result ? 'handoffReceipt' then raise exception 'receipt written before commit failure'; end if; return new; end $$`);
  await database.pool.query('create constraint trigger fail_standalone_commit after update on processing_tasks deferrable initially deferred for each row execute function fail_standalone_commit()');
  try {
    await expect((publisher === 'catalog' ? catalog : admission).publishCategoryCandidate(candidate, at)).rejects.toMatchObject({ cause: { message: 'receipt written before commit failure' } });
    expect(await tasks.getTask(task.id)).toEqual(beforeTask);
    expect((await database.pool.query('select category_id,assignment_revision from articles where id=$1', [article])).rows[0]).toEqual(beforeArticle);
    expect((await database.pool.query("select id from processing_tasks where article_id=$1 and action='tags'", [article])).rows).toEqual([]);
    expect((await database.pool.query("select id from pgboss.job where name='tags'")).rows).toEqual([]);
  } finally {
    await database.pool.query('drop trigger fail_standalone_commit on processing_tasks; drop function fail_standalone_commit()');
  }
});

async function admit() {
  const result = await admission.admitPreparedArticle(article, prepare, at);
  if (result.kind !== 'admitted') throw new Error(`unexpected ${result.kind}`);
  return result;
}
async function rows() { return (await database.pool.query('select * from processing_tasks where article_id=$1 order by id', [article])).rows; }
async function jobs() { return (await database.pool.query("select id,data,retry_limit from pgboss.job where name='category' order by id")).rows; }

it('admits one immutable snapshot with strict handoff metadata and only a category job', async () => {
  await database.pool.query("insert into score_definitions(name,description,prompt,active,deleted_at) values ('inactive','','p',false,null),('deleted','','p',true,now())");
  const result = await admit();
  const tasks = await rows();
  const root = tasks.find(t => t.id === result.categoryTaskId);
  const tags = tasks.find(t => t.id === result.tagsTaskId);
  const scores = tasks.filter(t => result.scoreTaskIds.includes(t.id));
  expect(root).toMatchObject({ action: 'category', state: 'queued', prerequisite_id: prepare, generation: 1 });
  expect(readChainMetadata(root.result, 'category')).toEqual({ version: 1, rootTaskId: root.id, prepareTaskId: prepare, tagsTaskId: result.tagsTaskId, requiredHandoff: null, requiredBasis: { contentRevision: 1, assignmentRevision: 0, articleInputHash: articleFingerprint('title', null) }, targetCount: 2 });
  expect(root.result.articleChain.tagsTaskId).toBe(tags.id);
  expect(Object.hasOwn(tags.result.articleChain, 'tagsTaskId')).toBe(false);
  expect(tags).toMatchObject({ action: 'tags', state: 'waiting_dependency', prerequisite_id: root.id, generation: 1, job_id: null });
  expect(readChainMetadata(tags.result, 'tags')).toEqual({ version: 1, rootTaskId: root.id, prepareTaskId: prepare, requiredHandoff: { taskId: root.id, generation: 1, action: 'category' }, requiredBasis: null });
  expect(scores.map(t => t.score_target_id).sort()).toEqual(targets);
  for (const score of scores) {
    expect(score).toMatchObject({ action: 'scores', state: 'waiting_dependency', prerequisite_id: tags.id, generation: 1, job_id: null });
    expect(Object.hasOwn(score.result.articleChain, 'tagsTaskId')).toBe(false);
    expect(readChainMetadata(score.result, 'scores')).toEqual({ version: 1, rootTaskId: root.id, prepareTaskId: prepare, requiredHandoff: { taskId: tags.id, generation: 1, action: 'tags' }, requiredBasis: null });
  }
  expect(await jobs()).toEqual([{ id: root.job_id, data: { taskId: root.id }, retry_limit: 0 }]);
  await database.pool.query("insert into score_definitions(name,description,prompt) values ('later','','p')");
  expect((await rows()).filter(t => t.action === 'scores')).toHaveLength(2);
  expect((await rows()).find(t => t.id === root.id).result).toEqual(root.result);
});

it('keeps a zero-target snapshot even after a later definition', async () => {
  await database.pool.query('update score_definitions set active=false');
  const result = await admit();
  const tasks = await rows();
  const root = tasks.find(t => t.id === result.categoryTaskId);
  const tags = tasks.find(t => t.id === result.tagsTaskId);
  expect(readChainMetadata(root.result, 'category')).toMatchObject({ targetCount: 0, tagsTaskId: result.tagsTaskId });
  expect(root.result.articleChain.tagsTaskId).toBe(tags.id);
  expect(tags).toMatchObject({ action: 'tags', state: 'waiting_dependency', prerequisite_id: root.id, job_id: null });
  expect(readChainMetadata(tags.result, 'tags')).toEqual({ version: 1, rootTaskId: root.id, prepareTaskId: prepare, requiredHandoff: { taskId: root.id, generation: 1, action: 'category' }, requiredBasis: null });
  expect(Object.hasOwn(tags.result.articleChain, 'tagsTaskId')).toBe(false);
  expect(result.scoreTaskIds).toEqual([]);
  await database.pool.query("insert into score_definitions(name,description,prompt) values ('later','','p')");
  expect((await rows()).filter(t => t.action === 'scores')).toHaveLength(0);
  expect((await rows()).find(t => t.id === root.id).result).toEqual(root.result);
  expect(await jobs()).toHaveLength(1);
});

it('reads an old-shaped root as invalid without changing its persisted row', async () => {
  const result = await admit();
  await database.pool.query("update processing_tasks set result=jsonb_set(result, '{articleChain}', (result->'articleChain') - 'tagsTaskId') where id=$1", [result.categoryTaskId]);
  const before = (await rows()).find(t => t.id === result.categoryTaskId);
  expect(Object.hasOwn(before.result.articleChain, 'tagsTaskId')).toBe(false);
  expect(readChainMetadata(before.result, 'category')).toBeNull();
  expect((await rows()).find(t => t.id === result.categoryTaskId)).toEqual(before);
});

it.each(['missing receipt', 'malformed receipt', 'wrong task', 'wrong article', 'wrong action', 'wrong generation', 'wrong revision', 'extra field', 'legacy', 'unusable', 'blank', 'missing content', 'content revision', 'newer failed', 'wrong state', 'task action'])(
  'rejects %s without writes', async reason => {
    const receipt = (await rows()).find(t => t.id === prepare).result.preparationReceipt;
    if (reason === 'missing receipt') await database.pool.query("update processing_tasks set result='{}' where id=$1", [prepare]);
    if (reason === 'malformed receipt') await database.pool.query("update processing_tasks set result='{\"preparationReceipt\":null}' where id=$1", [prepare]);
    if (reason === 'legacy') await database.pool.query('update processing_tasks set result=null where id=$1', [prepare]);
    const changes: Record<string, unknown> = { 'wrong task': { taskId: randomUUID() }, 'wrong article': { articleId: randomUUID() },
      'wrong action': { action: 'category' }, 'wrong generation': { generation: 2 }, 'wrong revision': { contentRevision: 2 }, 'extra field': { extra: true } };
    if (changes[reason]) await database.pool.query('update processing_tasks set result=$2 where id=$1', [prepare, { preparationReceipt: { ...receipt, ...changes[reason] as object } }]);
    if (reason === 'wrong state') await database.pool.query("update processing_tasks set state='failed' where id=$1", [prepare]);
    if (reason === 'task action') await database.pool.query("update processing_tasks set action='category' where id=$1", [prepare]);
    if (reason === 'missing content') await database.pool.query('delete from article_contents where article_id=$1', [article]);
    if (reason === 'unusable') await database.pool.query("update article_contents set quality='uncertain' where article_id=$1", [article]);
    if (reason === 'blank') await database.pool.query("update article_contents set text='  ' where article_id=$1", [article]);
    if (reason === 'content revision') await database.pool.query('update articles set content_revision=2 where id=$1', [article]);
    if (reason === 'newer failed') await database.pool.query("insert into processing_tasks(article_id,action,generation,state,created_at,updated_at) values ($1,'prepare',2,'failed',$2,$2)", [article, at]);
    const before = await rows();
    expect(await admission.admitPreparedArticle(article, prepare, at)).toEqual({ kind: 'needs_input' });
    expect(await rows()).toEqual(before);
    expect(await jobs()).toEqual([]);
  });

it('rejects absent or foreign article and preparation without writes', async () => {
  const before = await rows();
  expect(await admission.admitPreparedArticle(randomUUID(), prepare, at)).toEqual({ kind: 'not_found' });
  expect(await admission.admitPreparedArticle(article, randomUUID(), at)).toEqual({ kind: 'needs_input' });
  const other = (await database.pool.query("insert into articles(context_id,freshrss_id,imported_at) select context_id,'other',now() from articles where id=$1 returning id", [article])).rows[0].id;
  expect(await admission.admitPreparedArticle(other, prepare, at)).toEqual({ kind: 'needs_input' });
  expect(await rows()).toEqual(before);
  expect(await jobs()).toEqual([]);
});

it('applies the global generation and root-aware supersession matrix without touching saved values or terminal rows', async () => {
  const outside = (await database.pool.query("insert into score_definitions(name,description,prompt,active) values ('outside','','p',false) returning id")).rows[0].id;
  const states = ['waiting_dependency', 'queued', 'running', 'retry_wait', 'paused_budget', 'paused_auth', 'needs_input'];
  const expected: { id: string; state: string }[] = [];
  let generation = 1;
  async function add(action: string, state: string, target: string | null, prerequisite: string | null, result: object | null, supersede: boolean) {
    const id = (await database.pool.query('insert into processing_tasks(article_id,action,score_target_id,generation,state,prerequisite_id,result,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$8) returning id', [article, action, target, generation++, state, prerequisite, result, at])).rows[0].id;
    expected.push({ id, state: supersede ? 'superseded' : state });
  }
  for (const state of states) {
    await add('category', state, null, null, null, true);
    await add('category', state, null, prepare, { articleChain: 'bad' }, true);
    await add('tags', state, null, prepare, null, true);
    await add('tags', state, null, null, { articleChain: null }, true);
    await add('scores', state, targets[0]!, null, null, true);
    await add('scores', state, outside, null, null, false);
    await add('scores', state, outside, null, { other: 'preserved' }, false);
    await add('scores', state, outside, prepare, null, true);
    await add('scores', state, outside, null, { articleChain: null }, true);
    await add('scores', state, outside, null, { articleChain: 'bad' }, true);
  }
  for (const state of ['failed', 'succeeded', 'superseded']) {
    await add('category', state, null, null, null, false);
    await add('tags', state, null, null, null, false);
    await add('scores', state, targets[0]!, prepare, { articleChain: {} }, false);
  }
  await database.pool.query('insert into article_scores(article_id,score_id,value,calculated_at,content_revision,assignment_revision) values ($1,$2,42,$3,1,0)', [article, targets[0], at]);
  const scoresBefore = (await database.pool.query('select * from article_scores where article_id=$1', [article])).rows;
  const history = await rows();
  const max = (action: string, target?: string) => Math.max(0, ...history.filter(t => t.action === action && (target === undefined || t.score_target_id === target)).map(t => t.generation as number));
  const result = await admit();
  const after = await rows();
  for (const row of expected) expect(after.find(t => t.id === row.id).state).toBe(row.state);
  expect(after.find(t => t.id === result.categoryTaskId).generation).toBe(max('category') + 1);
  expect(after.find(t => t.id === result.tagsTaskId).generation).toBe(max('tags') + 1);
  for (const target of targets) expect(after.find(t => result.scoreTaskIds.includes(t.id) && t.score_target_id === target).generation).toBe(max('scores', target) + 1);
  expect((await database.pool.query('select * from article_scores where article_id=$1', [article])).rows).toEqual(scoresBefore);
  const store = new TaskStore(database.db);
  for (const row of expected.filter(r => r.state === 'superseded')) expect(await store.claimTask(row.id, randomUUID(), at)).toBeNull();
});

it('preserves other articles and existing assignments', async () => {
  const other = (await database.pool.query("insert into articles(context_id,freshrss_id,imported_at) select context_id,'other',now() from articles where id=$1 returning id", [article])).rows[0].id;
  await database.pool.query("insert into processing_tasks(article_id,action,generation,state,created_at,updated_at) values ($1,'category',1,'queued',$2,$2)", [other, at]);
  const tag = (await database.pool.query("insert into tags(label,key) values ('existing',$1) returning id", [randomUUID()])).rows[0].id;
  await database.pool.query('insert into article_tags(article_id,tag_id) values ($1,$2)', [article, tag]);
  const beforeArticle = (await database.pool.query('select * from articles where id in ($1,$2) order by id', [article, other])).rows;
  const beforeTags = (await database.pool.query('select * from article_tags where article_id=$1', [article])).rows;
  const beforeOther = (await database.pool.query('select * from processing_tasks where article_id=$1', [other])).rows;
  await admit();
  expect((await database.pool.query('select * from articles where id in ($1,$2) order by id', [article, other])).rows).toEqual(beforeArticle);
  expect((await database.pool.query('select * from article_tags where article_id=$1', [article])).rows).toEqual(beforeTags);
  expect((await database.pool.query('select * from processing_tasks where article_id=$1', [other])).rows).toEqual(beforeOther);
});

it('blocks old category input before AI and captured score publication after admission', async () => {
  const tasks = new TaskStore(database.db);
  const oldCategory = await tasks.createTask({ articleId: article, action: 'category', generation: 1, state: 'queued', createdAt: at, updatedAt: at });
  const categoryToken = randomUUID();
  await tasks.claimTaskForAction(oldCategory.id, 'category', categoryToken, at);
  const oldScore = await tasks.createTask({ articleId: article, action: 'scores', scoreTargetId: targets[0], generation: 1, state: 'queued', createdAt: at, updatedAt: at });
  const scoreToken = randomUUID();
  await tasks.claimTaskForAction(oldScore.id, 'scores', scoreToken, at);
  const epoch = (await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision;
  await database.pool.query("update model_roles set provider='fake',model='classifier' where role='category'");
  const inputs = new CategoryTaskInputStore(database.pool);
  const captured = await inputs.loadResult(oldCategory.id, categoryToken, { model: { provider: 'fake', model: 'classifier' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: () => 1 }, new AbortController().signal);
  if (captured.kind !== 'loaded') throw new Error(`unexpected input ${captured.kind}`);
  const categoryId = (await database.pool.query('select category_id from articles where id=$1', [article])).rows[0].category_id;
  await database.pool.query('insert into article_scores(article_id,score_id,value,calculated_at,content_revision,assignment_revision) values ($1,$2,42,$3,1,0)', [article, targets[0], at]);
  await admit();
  expect(await new CatalogStore(database.db).publishCategoryCandidate({ ...captured.input.basis, categoryId }, at)).toBeNull();
  const classify = vi.fn<AiPort['classify']>();
  const ai = { classify, generate: vi.fn<AiPort['generate']>(), createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() };
  expect(await categorize(oldCategory.id, categoryToken, { inputs, catalog: new CatalogStore(database.db), tasks, ai, model: null, signal: new AbortController().signal, now: () => at })).toEqual({ kind: 'ownership_lost' });
  expect(classify).not.toHaveBeenCalled();
  expect(await new ScoreStore(database.db).publishCandidate({ value: 99, coverage: [] as never, basis: { taskId: oldScore.id, executionToken: scoreToken, scoreId: targets[0]!, articleId: article, contentRevision: 1, assignmentRevision: 0, catalogEpoch: epoch, generation: 1, condensed: false, limited: false } }, at)).toBe(false);
  expect((await new ScoreStore(database.db).get(article, targets[0]!))?.value).toBe(42);
});

it.each(['category', 'tags', 'scores'])('rejects %s history overflow before any writes', async action => {
  await database.pool.query("insert into processing_tasks(article_id,action,score_target_id,generation,state,created_at,updated_at) values ($1,$2,$3,2147483647,'failed',$4,$4)", [article, action, action === 'scores' ? targets[0] : null, at]);
  const before = await rows();
  await expect(admit()).rejects.toThrow('overflow');
  expect(await rows()).toEqual(before);
  expect(await jobs()).toEqual([]);
});

it('holds admission locks through commit and gives a waiting admission fresh generations', async () => {
  let release!: () => void;
  let entered!: (pid: number) => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const atSend = new Promise<number>(resolve => { entered = resolve; });
  const send = boss.send.bind(boss);
  let firstSend = true;
  vi.spyOn(boss, 'send').mockImplementation(async (...args) => {
    const id = await send(...args);
    if (firstSend) {
      firstSend = false;
      const transaction = args[2]?.db;
      if (!transaction) throw new Error('Missing transactional queue connection');
      const pid = (await transaction.executeSql('select pg_backend_pid() as pid')).rows[0].pid as number;
      entered(pid);
      await gate;
    }
    return id;
  });
  const first = admit();
  let second: ReturnType<typeof admit> | undefined;
  const clients: PoolClient[] = [];
  const mutations: Promise<unknown>[] = [];
  try {
    const firstPid = await Promise.race([atSend, first.then(() => { throw new Error('Admission did not reach barrier'); })]);
    expect(await jobs()).toEqual([]);
    expect((await rows()).filter(t => t.action !== 'prepare')).toEqual([]);
    second = admit();
    let secondPid = 0;
    for (let i = 0; i < 200 && !secondPid; i++) {
      const activity = await database.pool.query<{ pid: number }>(`select pid from pg_stat_activity
        where wait_event_type='Lock' and $1=any(pg_blocking_pids(pid)) and query like '%from "articles"%'`, [firstPid]);
      secondPid = activity.rows[0]?.pid ?? 0;
      if (!secondPid) await delay(10);
    }
    expect(secondPid).not.toBe(0);
    expect(secondPid).not.toBe(firstPid);

    // Each mutation uses its own session and must be blocked by the first transaction itself.
    for (const [query, values] of [
      ['update catalog_epoch set revision=revision where id=1', []],
      ['update score_definitions set active=false where id=$1', [targets[0]]],
      ['update processing_tasks set updated_at=updated_at where id=$1', [prepare]],
    ] as [string, unknown[]][]) {
      const client = await database.pool.connect();
      clients.push(client);
      const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      mutations.push(client.query(query, values));
      let blocked = false;
      for (let i = 0; i < 200 && !blocked; i++) {
        const activity = await database.pool.query<{ blocked: boolean }>(
          "select wait_event_type='Lock' and $2=any(pg_blocking_pids(pid)) as blocked from pg_stat_activity where pid=$1", [pid, firstPid]);
        blocked = activity.rows[0]?.blocked === true;
        if (!blocked) await delay(10);
      }
      expect(blocked).toBe(true);
    }
    release();
    const [initial, waiting] = await Promise.all([first, second]);
    await Promise.all(mutations);
    const tasks = await rows();
    for (const [result, generation] of [[initial, 1], [waiting, 2]] as const) {
      const root = tasks.find(t => t.id === result.categoryTaskId);
      expect(root.generation).toBe(generation);
      expect(readChainMetadata(root.result, 'category')?.targetCount).toBe(2);
      expect(tasks.find(t => t.id === result.tagsTaskId).generation).toBe(generation);
      const scores = tasks.filter(t => result.scoreTaskIds.includes(t.id));
      expect(scores.map(t => t.score_target_id).sort()).toEqual(targets);
      expect(scores.map(t => t.generation)).toEqual([generation, generation]);
      expect((await jobs()).some(job => job.id === root.job_id && job.data.taskId === root.id)).toBe(true);
    }
    const afterMutation = await admit();
    const latest = await rows();
    expect(latest.find(t => t.id === afterMutation.categoryTaskId).generation).toBe(3);
    expect(latest.find(t => t.id === afterMutation.tagsTaskId).generation).toBe(3);
    const scores = latest.filter(t => afterMutation.scoreTaskIds.includes(t.id));
    expect(scores.map(t => [t.score_target_id, t.generation])).toEqual([[targets[1], 3]]);
    expect(readChainMetadata(latest.find(t => t.id === afterMutation.categoryTaskId).result, 'category')?.targetCount).toBe(1);
  } finally {
    release();
    await Promise.allSettled([first, ...(second ? [second] : []), ...mutations]);
    for (const client of clients) client.release();
  }
}, 30000);

it('serializes concurrent admissions and fences old claims', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, admit));
  const tasks = await rows();
  for (const action of ['category', 'tags']) expect(results.map(r => tasks.find(t => t.id === (action === 'category' ? r.categoryTaskId : r.tagsTaskId)).generation).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  for (const target of targets) expect(tasks.filter(t => t.action === 'scores' && t.score_target_id === target).map(t => t.generation).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(tasks.filter(t => t.action === 'category' && t.state === 'queued')).toHaveLength(1);
  const store = new TaskStore(database.db);
  for (const task of tasks.filter(t => t.action === 'category' && t.state === 'superseded')) expect(await store.claimTaskForAction(task.id, 'category', randomUUID(), at)).toBeNull();
  expect(await jobs()).toHaveLength(6);
});

it.each(['throw', 'null', 'invalid', 'update', 'commit'])('rolls back admission, supersession and real jobs on %s failure', async failure => {
  const first = await admit();
  const before = await rows();
  const priorJobs = await jobs();
  const send = boss.send.bind(boss);
  let sent: string | null = null;
  vi.spyOn(boss, 'send').mockImplementation(async (...args) => {
    if (failure === 'throw') throw new Error('send failure');
    sent = await send(...args);
    return failure === 'null' ? null : failure === 'invalid' ? 'bad-id' : sent;
  });
  if (failure === 'update') {
    await database.pool.query(`create function reject_job_update() returns trigger language plpgsql as $$ begin if new.article_id = '${article}'::uuid and old.job_id is null and new.job_id is not null then return null; end if; return new; end $$`);
    await database.pool.query('create trigger reject_job_update before update on processing_tasks for each row execute function reject_job_update()');
  }
  if (failure === 'commit') {
    await database.pool.query(`create function reject_article_commit() returns trigger language plpgsql as $$ begin if new.article_id = '${article}'::uuid and new.action = 'category' then raise exception 'commit failure'; end if; return null; end $$`);
    await database.pool.query('create constraint trigger reject_article_commit after insert on processing_tasks deferrable initially deferred for each row execute function reject_article_commit()');
  }
  try {
    await expect(admit()).rejects.toThrow();
    expect(await rows()).toEqual(before);
    expect(await jobs()).toEqual(priorJobs);
    if (failure !== 'throw') {
      expect(sent).toBeTruthy();
      expect((await database.pool.query('select id from pgboss.job where id=$1', [sent])).rows).toEqual([]);
    }
    expect((await new TaskStore(database.db).getTask(first.categoryTaskId))?.state).toBe('queued');
  } finally {
    if (failure === 'update') await database.pool.query('drop trigger reject_job_update on processing_tasks; drop function reject_job_update()');
    if (failure === 'commit') await database.pool.query('drop trigger reject_article_commit on processing_tasks; drop function reject_article_commit()');
  }
});

async function categoryRun(admitted: Awaited<ReturnType<typeof admit>>, during?: () => Promise<void>, choice?: string, catalog: Pick<CatalogStore, 'publishCategoryCandidate'> = admission) {
  const tasks = new TaskStore(database.db);
  const token = randomUUID();
  expect(await tasks.claimTaskForAction(admitted.categoryTaskId, 'category', token, at)).toBeTruthy();
  await database.pool.query("update model_roles set provider='fake',model='classifier' where role='category'");
  const classify = vi.fn<AiPort['classify']>().mockImplementation(async request => {
    if (during) await during();
    const question = request.questions.category;
    if (!question || question.type !== 'choice') throw new Error('missing choices');
    const id = choice ?? Object.keys(question.criteria).find(id => id !== fallbackCategoryId)!;
    return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
  });
  const ai: AiPort = { classify, generate: vi.fn(), createRestrictedSession: vi.fn() };
  const result = await categorize(admitted.categoryTaskId, token, { inputs: new CategoryTaskInputStore(database.pool), catalog, tasks, ai,
    model: { model: { provider: 'fake', model: 'classifier' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: () => 1 },
    signal: new AbortController().signal, now: () => at });
  return { result, classify };
}
async function tagJobs() { return (await database.pool.query("select id,data,retry_limit from pgboss.job where name='tags' order by id")).rows; }
async function articleRow() { return (await database.pool.query('select category_id,assignment_revision,content_revision,title,source_id from articles where id=$1', [article])).rows[0]; }

it.each([[false, false], [false, true], [true, false], [true, true]])('publishes category and exact tags job (zero targets=%s, no-op=%s)', async (zero, noop) => {
  if (zero) await database.pool.query('update score_definitions set active=false');
  const admitted = await admit();
  const before = await articleRow();
  await database.pool.query("update processing_tasks set result=result || '{\"other\":{\"preserved\":true}}'::jsonb where id=$1", [admitted.categoryTaskId]);
  const publications: Awaited<ReturnType<ArticleJobs['publishCategoryCandidate']>>[] = [];
  const catalog = { async publishCategoryCandidate(...args: Parameters<ArticleJobs['publishCategoryCandidate']>) {
    const result = await admission.publishCategoryCandidate(...args);
    publications.push(result);
    return result;
  } };
  const run = await categoryRun(admitted, undefined, noop ? before.category_id : undefined, catalog);
  expect(run.result).toEqual({ kind: 'published' });
  expect(run.classify).toHaveBeenCalledOnce();
  const all = await rows();
  const root = all.find(t => t.id === admitted.categoryTaskId);
  const tags = all.find(t => t.id === admitted.tagsTaskId);
  const after = await articleRow();
  expect(after.assignment_revision).toBe(before.assignment_revision + (noop ? 0 : 1));
  expect(root.state).toBe('succeeded');
  const receipt = readHandoffReceipt(root.result);
  expect(root.result.other).toEqual({ preserved: true });
  expect(publications).toEqual([{ assignmentRevision: after.assignment_revision, receipt }]);
  expect(receipt).toMatchObject({ taskId: root.id, articleId: article, action: 'category', prerequisiteId: prepare,
    categoryId: after.category_id, basis: { contentRevision: after.content_revision, assignmentRevision: after.assignment_revision, articleInputHash: articleFingerprint(after.title, after.source_id) } });
  expect(tags).toMatchObject({ state: 'queued', prerequisite_id: root.id });
  expect(readChainMetadata(tags.result, 'tags')?.requiredBasis).toEqual(receipt?.basis);
  expect(await tagJobs()).toEqual([{ id: tags.job_id, data: { taskId: tags.id }, retry_limit: 0 }]);
  expect(all.filter(t => t.action === 'scores').every(t => t.state === 'waiting_dependency' && t.job_id === null)).toBe(true);
});

async function alterCategoryBasis(kind: string) {
  if (kind === 'title') await database.pool.query("update articles set title='changed' where id=$1", [article]);
  if (kind === 'source') {
    const source = (await database.pool.query("insert into sources(context_id,external_feed_id) select context_id,'changed' from articles where id=$1 returning id", [article])).rows[0].id;
    await database.pool.query('update articles set source_id=$2 where id=$1', [article, source]);
  }
  if (kind === 'assignment') await database.pool.query('update articles set assignment_revision=assignment_revision+1 where id=$1', [article]);
  if (kind === 'content') {
    await database.pool.query('update articles set content_revision=content_revision+1 where id=$1', [article]);
    await database.pool.query("update article_contents set revision=revision+1,text='changed' where article_id=$1", [article]);
  }
  if (kind === 'prepare' || kind === 'category') await database.pool.query('insert into processing_tasks(article_id,action,generation,state,created_at,updated_at) values ($1,$2,2,\'failed\',$3,$3)', [article, kind, at]);
}

it.each(['title', 'source', 'assignment', 'content', 'prepare', 'category'])('rejects %s changed before dispatch without AI', async kind => {
  const admitted = await admit();
  await alterCategoryBasis(kind);
  const before = await articleRow();
  const run = await categoryRun(admitted);
  expect(run.result.kind).toMatch(/superseded|needs_input/);
  expect(run.classify).not.toHaveBeenCalled();
  expect(await articleRow()).toEqual(before);
  expect(await tagJobs()).toEqual([]);
  expect((await rows()).find(t => t.id === admitted.tagsTaskId).state).toBe('waiting_dependency');
});

it.each(['title', 'source', 'assignment', 'content', 'prepare', 'category'])('rejects %s changed during inference without tags activation', async kind => {
  const admitted = await admit();
  const run = await categoryRun(admitted, () => alterCategoryBasis(kind));
  expect(run.result).toEqual({ kind: 'superseded' });
  expect(run.classify).toHaveBeenCalledOnce();
  const all = await rows();
  expect(all.find(t => t.id === admitted.tagsTaskId).state).toBe('waiting_dependency');
  expect(readHandoffReceipt(all.find(t => t.id === admitted.categoryTaskId).result)).toBeNull();
  expect(await tagJobs()).toEqual([]);
});

it.each(['missing anchor', 'null anchor', 'old root'])('rejects %s before AI without falling through to standalone', async kind => {
  const admitted = await admit();
  if (kind === 'null anchor') await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain}', 'null') where id=$1", [admitted.categoryTaskId]);
  else await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain}', (result->'articleChain') - 'tagsTaskId') where id=$1", [admitted.categoryTaskId]);
  const resultBefore = (await rows()).find(t => t.id === admitted.categoryTaskId).result;
  const run = await categoryRun(admitted);
  expect(run.result).toEqual({ kind: 'needs_input' });
  expect(run.classify).not.toHaveBeenCalled();
  expect((await rows()).find(t => t.id === admitted.categoryTaskId).result).toEqual(resultBefore);
  expect(await tagJobs()).toEqual([]);
});

it.each(['missing', 'malformed', 'replacement', 'root changed', 'newer tags', 'existing job', 'wrong ref generation'])('rejects %s successor transactionally for zero targets', async kind => {
  await database.pool.query('update score_definitions set active=false');
  const admitted = await admit();
  const before = await articleRow();
  const run = await categoryRun(admitted, async () => {
    if (kind === 'missing' || kind === 'replacement') {
      const original = (await database.pool.query('delete from processing_tasks where id=$1 returning *', [admitted.tagsTaskId])).rows[0];
      if (kind === 'replacement') await database.pool.query('insert into processing_tasks(id,article_id,action,generation,state,prerequisite_id,result,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), original.article_id, original.action, original.generation, original.state, original.prerequisite_id, original.result, original.created_at, original.updated_at]);
    } else if (kind === 'malformed') await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain}', 'null') where id=$1", [admitted.tagsTaskId]);
    else if (kind === 'root changed') await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,tagsTaskId}',to_jsonb($2::text)) where id=$1", [admitted.categoryTaskId, randomUUID()]);
    else if (kind === 'newer tags') await database.pool.query("insert into processing_tasks(article_id,action,generation,state,created_at,updated_at) values ($1,'tags',2,'failed',$2,$2)", [article, at]);
    else if (kind === 'existing job') await database.pool.query('update processing_tasks set job_id=$2 where id=$1', [admitted.tagsTaskId, randomUUID()]);
    else await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredHandoff,generation}', '2') where id=$1", [admitted.tagsTaskId]);
  });
  expect(run.result).toEqual({ kind: 'superseded' });
  expect(await articleRow()).toEqual(before);
  expect(readHandoffReceipt((await rows()).find(t => t.id === admitted.categoryTaskId).result)).toBeNull();
  expect(await tagJobs()).toEqual([]);
});

it.each(['throw', 'null', 'invalid', 'update', 'assignment', 'receipt', 'activation', 'commit'])('rolls back category handoff on %s failure', async failure => {
  const admitted = await admit();
  const before = await articleRow();
  const send = boss.send.bind(boss);
  let sent: string | null = null;
  vi.spyOn(boss, 'send').mockImplementation(async (...args) => {
    if (failure === 'throw') throw new Error('send failure');
    sent = await send(...args);
    return failure === 'null' ? null : failure === 'invalid' ? 'invalid' : sent;
  });
  if (failure === 'update') {
    await database.pool.query(`create function reject_tags_job_update() returns trigger language plpgsql as $$ begin if new.id = '${admitted.tagsTaskId}'::uuid and old.job_id is null and new.job_id is not null then return null; end if; return new; end $$`);
    await database.pool.query('create trigger reject_tags_job_update before update on processing_tasks for each row execute function reject_tags_job_update()');
  }
  if (failure === 'assignment') {
    await database.pool.query(`create function reject_category_assignment() returns trigger language plpgsql as $$ begin if new.id = '${article}'::uuid and new.category_id <> old.category_id then return null; end if; return new; end $$`);
    await database.pool.query('create trigger reject_category_assignment before update on articles for each row execute function reject_category_assignment()');
  }
  if (failure === 'receipt' || failure === 'activation') {
    await database.pool.query(`create function reject_handoff_update() returns trigger language plpgsql as $$ begin if (new.id = '${admitted.categoryTaskId}'::uuid and new.result ? 'handoffReceipt' and '${failure}' = 'receipt') or (new.id = '${admitted.tagsTaskId}'::uuid and new.state = 'queued' and '${failure}' = 'activation') then return null; end if; return new; end $$`);
    await database.pool.query('create trigger reject_handoff_update before update on processing_tasks for each row execute function reject_handoff_update()');
  }
  if (failure === 'commit') {
    await database.pool.query(`create function reject_category_commit() returns trigger language plpgsql as $$ begin if new.id = '${admitted.categoryTaskId}'::uuid and new.state = 'succeeded' then raise exception 'commit failure'; end if; return null; end $$`);
    await database.pool.query('create constraint trigger reject_category_commit after update on processing_tasks deferrable initially deferred for each row execute function reject_category_commit()');
  }
  try {
    await expect(categoryRun(admitted)).rejects.toThrow('Category publication failed');
    expect(await articleRow()).toEqual(before);
    const all = await rows();
    const root = all.find(t => t.id === admitted.categoryTaskId);
    expect(root.state).toBe('running');
    expect(readHandoffReceipt(root.result)).toBeNull();
    expect(all.find(t => t.id === admitted.tagsTaskId)).toMatchObject({ state: 'waiting_dependency', job_id: null });
    expect(all.filter(t => t.action === 'scores').every(t => t.state === 'waiting_dependency' && t.job_id === null)).toBe(true);
    expect(await tagJobs()).toEqual([]);
    if (sent) expect((await database.pool.query('select id from pgboss.job where id=$1', [sent])).rows).toEqual([]);
  } finally {
    if (failure === 'update') await database.pool.query('drop trigger reject_tags_job_update on processing_tasks; drop function reject_tags_job_update()');
    if (failure === 'assignment') await database.pool.query('drop trigger reject_category_assignment on articles; drop function reject_category_assignment()');
    if (failure === 'receipt' || failure === 'activation') await database.pool.query('drop trigger reject_handoff_update on processing_tasks; drop function reject_handoff_update()');
    if (failure === 'commit') await database.pool.query('drop trigger reject_category_commit on processing_tasks; drop function reject_category_commit()');
  }
});

it.each(['missing', 'malformed', 'wrong revision'])('rejects %s preparation receipt before AI', async reason => {
  const admitted = await admit();
  if (reason === 'missing') await database.pool.query("update processing_tasks set result=result - 'preparationReceipt' where id=$1", [prepare]);
  if (reason === 'malformed') await database.pool.query("update processing_tasks set result=jsonb_set(result,'{preparationReceipt}', 'null') where id=$1", [prepare]);
  if (reason === 'wrong revision') await database.pool.query("update processing_tasks set result=jsonb_set(result,'{preparationReceipt,contentRevision}', '2') where id=$1", [prepare]);
  const run = await categoryRun(admitted);
  expect(run.result).toEqual({ kind: 'needs_input' });
  expect(run.classify).not.toHaveBeenCalled();
  expect(await tagJobs()).toEqual([]);
});

it('rejects a preparation receipt changed during inference and rolls back publication', async () => {
  const admitted = await admit();
  const before = await articleRow();
  const run = await categoryRun(admitted, async () => { await database.pool.query("update processing_tasks set result=result - 'preparationReceipt' where id=$1", [prepare]); });
  expect(run.result).toEqual({ kind: 'superseded' });
  expect(await articleRow()).toEqual(before);
  const all = await rows();
  expect(readHandoffReceipt(all.find(t => t.id === admitted.categoryTaskId).result)).toBeNull();
  expect(all.find(t => t.id === admitted.tagsTaskId).state).toBe('waiting_dependency');
  expect(await tagJobs()).toEqual([]);
});

it('preserves unrelated root and successor result namespaces through the handoff', async () => {
  const admitted = await admit();
  await database.pool.query("update processing_tasks set result=result || '{\"extra\":{\"value\":3}}'::jsonb where id=any($1::uuid[])", [[admitted.categoryTaskId, admitted.tagsTaskId]]);
  expect((await categoryRun(admitted)).result).toEqual({ kind: 'published' });
  const all = await rows();
  expect(all.find(t => t.id === admitted.categoryTaskId).result.extra).toEqual({ value: 3 });
  expect(all.find(t => t.id === admitted.tagsTaskId).result.extra).toEqual({ value: 3 });
});

it('propagates a lost response after committed publication without a second settlement', async () => {
  const admitted = await admit();
  const catalog = { async publishCategoryCandidate(...args: Parameters<CatalogStore['publishCategoryCandidate']>) {
    expect(await admission.publishCategoryCandidate(...args)).toBeTruthy();
    throw new Error('lost response');
  } };
  await expect(categoryRun(admitted, undefined, undefined, catalog)).rejects.toThrow('Category publication failed');
  const all = await rows();
  expect(all.find(t => t.id === admitted.categoryTaskId).state).toBe('succeeded');
  expect(readHandoffReceipt(all.find(t => t.id === admitted.categoryTaskId).result)).not.toBeNull();
  expect(all.find(t => t.id === admitted.tagsTaskId).state).toBe('queued');
  expect(await tagJobs()).toHaveLength(1);
});

it('holds category publication locks through the transactional send and commit', async () => {
  const admitted = await admit();
  let release!: () => void;
  let entered!: (pid: number) => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const atSend = new Promise<number>(resolve => { entered = resolve; });
  const send = boss.send.bind(boss);
  vi.spyOn(boss, 'send').mockImplementation(async (...args) => {
    const id = await send(...args);
    const tx = args[2]?.db;
    if (!tx) throw new Error('Missing transactional connection');
    entered((await tx.executeSql('select pg_backend_pid() as pid')).rows[0].pid as number);
    await gate;
    return id;
  });
  const running = categoryRun(admitted);
  const clients: PoolClient[] = [];
  const mutations: Promise<unknown>[] = [];
  try {
    const pid = await Promise.race([atSend, running.then(() => { throw new Error('No send barrier'); })]);
    expect(await tagJobs()).toEqual([]);
    expect((await rows()).find(t => t.id === admitted.tagsTaskId).state).toBe('waiting_dependency');
    for (const [query, values] of [
      ['update articles set title=title where id=$1', [article]],
      ['update processing_tasks set updated_at=updated_at where id=$1', [admitted.categoryTaskId]],
      ['update processing_tasks set updated_at=updated_at where id=$1', [admitted.tagsTaskId]],
      ['update processing_tasks set updated_at=updated_at where id=$1', [prepare]],
      ['update catalog_epoch set revision=revision where id=1', []],
    ] as [string, unknown[]][]) {
      const client = await database.pool.connect();
      clients.push(client);
      const other = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      mutations.push(client.query(query, values));
      let blocked = false;
      for (let i = 0; i < 200 && !blocked; i++) {
        const activity = await database.pool.query<{ blocked: boolean }>("select wait_event_type='Lock' and $2=any(pg_blocking_pids(pid)) as blocked from pg_stat_activity where pid=$1", [other, pid]);
        blocked = activity.rows[0]?.blocked === true;
        if (!blocked) await delay(10);
      }
      expect(blocked).toBe(true);
    }
    release();
    expect((await running).result).toEqual({ kind: 'published' });
    await Promise.all(mutations);
    expect(await tagJobs()).toHaveLength(1);
  } finally {
    release();
    await Promise.allSettled([running, ...mutations]);
    for (const client of clients) client.release();
  }
}, 30000);
