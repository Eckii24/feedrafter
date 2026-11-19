import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ArticleJobs } from '../../src/server/adapters/postgres/article-jobs.js';
import { provisionArticleQueues, startArticleWorkers } from '../../src/server/adapters/postgres/article-worker.js';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { provisionScoreQueue } from '../../src/server/adapters/postgres/score-admission.js';
import { ScoreStore } from '../../src/server/adapters/postgres/score-store.js';
import { startScoreWorker } from '../../src/server/adapters/postgres/score-worker.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { prepareArticle } from '../../src/server/application/prepare-article.js';
import type { AiPort } from '../../src/server/ports/ai.js';
import { fallbackCategoryId } from '../../src/shared/taxonomy.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();
const model = (name: string) => ({ model: { provider: 'fake', model: name }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: () => 1 });
let container = '';
let database: ReturnType<typeof createDatabase>;
let boss: PgBoss;
let context: string;
let targets: string[];
let databaseUrl: string;

async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await delay(50); }
  throw new Error('Timed out');
}
beforeAll(async () => {
  container = docker('run', '--detach', '--rm', '--pull=never', '--name', `feedrafter-article-worker-${randomUUID()}`, '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
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
  await provisionArticleQueues(boss); await provisionScoreQueue(boss);
  await database.pool.query("update model_roles set provider='fake',model=case role when 'tags' then 'tags' when 'context_reduction' then 'generator' else 'classifier' end where role in ('category','tags','scores','context_reduction')");
  targets = (await database.pool.query('select id from score_definitions order by id limit 3')).rows.map(row => row.id as string);
  await database.pool.query('update score_definitions set active=(id=any($1::uuid[])), include_title=true, include_content=true, include_category=true, include_tag_weights=(id=$2), include_source_weight=false', [targets, targets[0]]);
  context = (await database.pool.query("insert into import_contexts(instance,account) values ('article-worker','test') returning id")).rows[0].id;
}, 30000);
afterAll(async () => {
  try { if (boss) await boss.stop(); if (database) await database.close(); }
  finally { if (container) docker('rm', '--force', container); }
});

async function prepared() {
  const imported = await new ImportStore(database.db).importPageWithIdentities(context, [{ id: randomUUID(), title: 'Synthetic title', url: 'https://example.com/article', author: null, publishedAt: null, feedId: null, feedTitle: null }], new Date());
  expect(imported).toEqual([{ id: expect.any(String), inserted: true }]);
  const article = imported[0]!.id;
  const tasks = new TaskStore(database.db);
  const task = await tasks.createTask({ articleId: article, action: 'prepare', generation: 1, createdAt: new Date(), updatedAt: new Date() });
  const token = randomUUID();
  expect(await tasks.claimTask(task.id, token, new Date())).toBeTruthy();
  const body = Buffer.from(`<html><head><title>Report</title></head><body><article><h1>Report</h1><p>${'A synthetic report with independent details and meaningful factual information. '.repeat(30)}</p></article></body></html>`);
  expect(await prepareArticle({ web: { async get() { return { status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': 'text/html' }, body }; } }, content: new ContentStore(database.db), classifier: { async classify() { return { usable: true, probability: 1 }; } } }, { context: { articleId: article, taskId: task.id, action: 'prepare', generation: 1, executionToken: token, expectedContentRevision: 0 }, originalUrl: 'https://example.com/article' })).toEqual({ status: 'succeeded', revision: 1 });
  const admitted = await new ArticleJobs(database.db, boss).admitPreparedArticle(article, task.id, new Date());
  if (admitted.kind !== 'admitted') throw new Error(`Admission ${admitted.kind}`);
  return { article, admitted };
}

it('explicit migrate provisions all article and score queues', async () => {
  await database.pool.query('create database article_migrate_test');
  const url = new URL(databaseUrl); url.pathname = '/article_migrate_test';
  execFileSync(process.execPath, ['--import', 'tsx', 'src/server/main.ts', 'migrate'], { cwd: process.cwd(), timeout: 30000, env: { ...process.env, DATABASE_URL: url.toString(), APP_ORIGIN: 'http://localhost:3000', FRESHRSS_ENABLED: 'false', KARAKEEP_ENABLED: 'false' } });
  const migrated = createDatabase(url.toString());
  try { expect((await migrated.pool.query("select name from pgboss.queue where name in ('category','tags','score') order by name")).rows).toEqual([{ name: 'category' }, { name: 'score' }, { name: 'tags' }]); }
  finally { await migrated.close(); }
}, 45000);

it('delivers the prepared chain through real queues, preserves original score identities and ignores duplicate and wrong-action deliveries', async () => {
  const calls: string[] = [];
  const indices = [0, 1.5, 4];
  const ai: AiPort = {
    classify: vi.fn<AiPort['classify']>().mockImplementation(async (request, options) => {
      calls.push(request.role);
      if (request.role === 'category') {
        expect(options.bucket).toBe('classifier');
        const question = request.questions.category;
        if (!question || question.type !== 'choice') throw new Error('missing choices');
        const id = Object.keys(question.criteria).find(key => key !== fallbackCategoryId)!;
        return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
      }
      expect(options.bucket).toBe('classifier');
      const target = (await database.pool.query('select score_target_id from processing_tasks where id=$1', [options.taskId])).rows[0].score_target_id;
      const expectedCategory = (await database.pool.query('select c.label from categories c join articles a on a.category_id=c.id where a.id=(select article_id from processing_tasks where id=$1)', [options.taskId])).rows[0].label;
      expect(request.model).toEqual({ provider: 'fake', model: 'classifier' });
      expect(request.state).toMatchObject({ title: 'Synthetic title', category: expectedCategory, content: expect.stringContaining('synthetic report') });
      expect(Object.keys(request.state).sort()).toEqual((target === targets[0] ? ['category', 'content', 'tagWeights', 'title'] : ['category', 'content', 'title']).sort());
      if (target === targets[0]) expect(request.state.tagWeights).toEqual([expect.objectContaining({ tag: 'queue proof', weight: expect.any(Number) })]);
      expect(request.questions.score).toMatchObject({ type: 'score', criteria: ['0', '25', '50', '75', '100'] });
      const score = indices.shift();
      if (score === undefined) throw new Error('Unexpected score call');
      return { kind: 'completed', value: { answers: { score: { type: 'score', score, confidence: 1, criteria: [] } }, usage: null } };
    }),
    generate: vi.fn<AiPort['generate']>().mockImplementation(async (request, options) => {
      calls.push(request.role); expect(request.role).toBe('tags'); expect(options.bucket).toBe('automatic');
      expect(request.user).toContain('Synthetic title');
      return { kind: 'completed', value: { text: '{"tags":["queue proof"]}', usage: null } };
    }), createRestrictedSession: vi.fn(),
  };
  const fixture = await prepared();
  const { admitted, article } = fixture;
  expect(admitted.scoreTaskIds).toHaveLength(3);
  const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel: async () => model('classifier'), resolveTagModel: async () => model('tags') });
  const scoreWorker = await startScoreWorker({ ...database, boss, ai, resolveModels: async () => ({ classifier: model('classifier'), generator: model('generator') }) });
  try {
    const ids = [admitted.categoryTaskId, admitted.tagsTaskId, ...admitted.scoreTaskIds];
    await eventually(async () => Number((await database.pool.query("select count(*) n from processing_tasks where id=any($1::uuid[]) and state='succeeded'", [ids])).rows[0].n) === ids.length);
    const tasks = (await database.pool.query('select id,action,state,job_id,result from processing_tasks where id=any($1::uuid[])', [ids])).rows;
    for (const task of tasks) {
      expect(task.job_id).toBeTruthy();
      await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [task.job_id])).rows[0]?.state === 'completed');
    }
    expect(calls).toEqual(['category', 'tags', 'scores', 'scores', 'scores']);
    expect(tasks.find(row => row.id === admitted.categoryTaskId).result.handoffReceipt.action).toBe('category');
    expect(tasks.find(row => row.id === admitted.tagsTaskId).result.handoffReceipt.action).toBe('tags');
    const values = await Promise.all(targets.map(async target => (await new ScoreStore(database.db).get(article, target))?.value));
    expect(values.sort((a, b) => Number(a) - Number(b))).toEqual([0, 37.5, 100]);
    expect((await database.pool.query('select t.label from tags t join article_tags a on a.tag_id=t.id where a.article_id=$1', [article])).rows).toEqual([{ label: 'queue proof' }]);
    const duplicates = await Promise.all([boss.send('category', { taskId: admitted.categoryTaskId }, { retryLimit: 0 }), boss.send('tags', { taskId: admitted.categoryTaskId }, { retryLimit: 0 }), boss.send('category', { taskId: admitted.tagsTaskId }, { retryLimit: 0 }), boss.send('score', { taskId: admitted.scoreTaskIds[0] }, { retryLimit: 0 })]);
    for (const id of duplicates) await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [id])).rows[0]?.state === 'completed');
    expect(calls).toEqual(['category', 'tags', 'scores', 'scores', 'scores']);
  } finally { await worker.close(); await scoreWorker.close(); }
}, 45000);

it.each(['stale', 'paused'] as const)('completes %s category delivery without releasing successors', async scenario => {
  const { article, admitted } = await prepared();
  if (scenario === 'stale') await database.pool.query("update articles set title='changed after enqueue' where id=$1", [article]);
  const classify = vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'paused_auth' });
  const ai: AiPort = { classify, generate: vi.fn(), createRestrictedSession: vi.fn() };
  const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel: async () => model('classifier'), resolveTagModel: async () => model('tags') });
  try {
    const expected = scenario === 'stale' ? 'superseded' : 'paused_auth';
    const tasks = new TaskStore(database.db);
    await eventually(async () => (await tasks.getTask(admitted.categoryTaskId))?.state === expected);
    const category = await tasks.getTask(admitted.categoryTaskId);
    expect(category).toMatchObject({ state: expected, errorCode: scenario === 'stale' ? 'stale_basis' : 'auth_required' });
    await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [category!.jobId])).rows[0]?.state === 'completed');
    expect(await tasks.getTask(admitted.tagsTaskId)).toMatchObject({ state: 'waiting_dependency', jobId: null });
    for (const id of admitted.scoreTaskIds) expect(await tasks.getTask(id)).toMatchObject({ state: 'waiting_dependency', jobId: null });
    expect(classify).toHaveBeenCalledTimes(scenario === 'stale' ? 0 : 1);
    expect(ai.generate).not.toHaveBeenCalled();
  } finally { await worker.close(); }
}, 30000);

it.each(['tags', 'scores'] as const)('rejects a title edit after handoff before %s load', async stage => {
  const { article, admitted } = await prepared();
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ai: AiPort = { classify: vi.fn<AiPort['classify']>().mockImplementation(async request => {
    if (request.role !== 'category') throw new Error('Stale score dispatched');
    const question = request.questions.category;
    if (!question || question.type !== 'choice') throw new Error('missing choices');
    const id = Object.keys(question.criteria)[0]!;
    return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
  }), generate: vi.fn<AiPort['generate']>().mockResolvedValue({ kind: 'completed', value: { text: '{"tags":["fence"]}', usage: null } }), createRestrictedSession: vi.fn() };
  const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel: async () => model('classifier'), resolveTagModel: async () => {
    if (stage === 'tags') { entered = true; await gate; }
    return model('tags');
  } });
  const scores = await startScoreWorker({ ...database, boss, ai, resolveModels: async () => {
    if (stage === 'scores') { entered = true; await gate; }
    return { classifier: model('classifier'), generator: model('generator') };
  } });
  try {
    await eventually(async () => entered);
    await database.pool.query("update articles set title='changed after handoff' where id=$1", [article]);
    release();
    const tasks = new TaskStore(database.db);
    const ids = stage === 'tags' ? [admitted.tagsTaskId] : admitted.scoreTaskIds;
    await eventually(async () => (await Promise.all(ids.map(id => tasks.getTask(id)))).every(task => task?.state === 'superseded'));
    for (const id of ids) expect(await tasks.getTask(id)).toMatchObject({ state: 'superseded', errorCode: 'stale_basis' });
    expect(ai.classify).toHaveBeenCalledTimes(1);
    expect(ai.generate).toHaveBeenCalledTimes(stage === 'tags' ? 0 : 1);
    if (stage === 'tags') for (const id of admitted.scoreTaskIds) expect(await tasks.getTask(id)).toMatchObject({ state: 'waiting_dependency', jobId: null });
    else for (const target of targets) expect(await new ScoreStore(database.db).get(article, target)).toBeNull();
  } finally { release(); await worker.close(); await scores.close(); }
}, 30000);

it('drains in-flight category work and leaves unrelated registrations running', async () => {
  const { article, admitted } = await prepared();
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ai: AiPort = { classify: vi.fn<AiPort['classify']>().mockImplementation(async request => {
    entered = true; await gate;
    const question = request.questions.category;
    if (!question || question.type !== 'choice') throw new Error('missing choices');
    const id = Object.keys(question.criteria)[0]!;
    return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
  }), generate: vi.fn(), createRestrictedSession: vi.fn() };
  await boss.createQueue('unrelated');
  const other = await boss.work('unrelated', { batchSize: 1 }, async () => {});
  const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel: async () => model('classifier'), resolveTagModel: async () => model('tags') });
  try {
    await eventually(async () => entered);
    await database.pool.query("update articles set title='changed during inference' where id=$1", [article]);
    let closed = false;
    const closing = worker.close().then(() => { closed = true; });
    await delay(100); expect(closed).toBe(false);
    release(); await closing;
    expect(await new TaskStore(database.db).getTask(admitted.categoryTaskId)).toMatchObject({ state: 'superseded', errorCode: 'stale_basis' });
    expect(await new TaskStore(database.db).getTask(admitted.tagsTaskId)).toMatchObject({ state: 'waiting_dependency', jobId: null });
    const job = await boss.send('unrelated', {}, { retryLimit: 0 });
    await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [job])).rows[0]?.state === 'completed');
  } finally { release(); await worker.close(); await boss.offWork('unrelated', { id: other, wait: true }); }
}, 30000);

it.each((['category', 'tags', 'scores'] as const).flatMap(stage =>
  (['before load', 'during inference'] as const).flatMap(timing =>
    (['title', 'source', 'content', 'category', 'tags', 'new prepare', 'new category'] as const).map(change => [stage, timing, change] as const))))(
  'fences %s %s edit to %s through real delivery', async (stage, timing, change) => {
    const { article, admitted } = await prepared();
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const barrier = async () => { if (!entered) { entered = true; await gate; } };
    const ai: AiPort = {
      classify: vi.fn<AiPort['classify']>().mockImplementation(async request => {
        if (timing === 'during inference' && request.role === stage) await barrier();
        if (request.role === 'category') {
          const question = request.questions.category;
          if (!question || question.type !== 'choice') throw new Error('missing choices');
          const id = Object.keys(question.criteria)[0]!;
          return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
        }
        return { kind: 'completed', value: { answers: { score: { type: 'score', score: 2, confidence: 1, criteria: [] } }, usage: null } };
      }),
      generate: vi.fn<AiPort['generate']>().mockImplementation(async () => {
        if (timing === 'during inference' && stage === 'tags') await barrier();
        return { kind: 'completed', value: { text: '{"tags":["worker fence"]}', usage: null } };
      }), createRestrictedSession: vi.fn(),
    };
    const resolve = async (name: string) => { if (timing === 'before load' && stage === name) await barrier(); return model(name === 'tags' ? 'tags' : 'classifier'); };
    const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel: () => resolve('category'), resolveTagModel: () => resolve('tags') });
    const scores = await startScoreWorker({ ...database, boss, ai, resolveModels: async () => ({ classifier: await resolve('scores'), generator: model('generator') }) });
    try {
      await eventually(async () => entered);
      if (change === 'title') await database.pool.query("update articles set title='edited' where id=$1", [article]);
      if (change === 'source') {
        const source = (await database.pool.query('insert into sources(context_id,external_feed_id) values ($1,$2) returning id', [context, randomUUID()])).rows[0].id;
        await database.pool.query('update articles set source_id=$2 where id=$1', [article, source]);
      }
      if (change === 'content') {
        await database.pool.query('update articles set content_revision=content_revision+1 where id=$1', [article]);
        await database.pool.query("update article_contents set revision=revision+1,text='edited' where article_id=$1", [article]);
      }
      if (change === 'category') await database.pool.query('update articles set category_id=(select id from categories where id<>articles.category_id order by id limit 1), assignment_revision=assignment_revision+1 where id=$1', [article]);
      if (change === 'new prepare' || change === 'new category') await database.pool.query("insert into processing_tasks(article_id,action,generation,state,created_at,updated_at) values ($1,$2,2,'failed',now(),now())", [article, change === 'new prepare' ? 'prepare' : 'category']);
      if (change === 'tags') {
        const tag = (await database.pool.query('insert into tags(label,key) values ($1,$2) returning id', [randomUUID(), randomUUID()])).rows[0].id;
        await database.pool.query('insert into article_tags(article_id,tag_id) values ($1,$2)', [article, tag]);
        await database.pool.query('update articles set assignment_revision=assignment_revision+1 where id=$1', [article]);
      }
      const before = (await database.pool.query('select category_id,assignment_revision,content_revision,title,source_id from articles where id=$1', [article])).rows;
      const tagsBefore = (await database.pool.query('select tag_id from article_tags where article_id=$1 order by tag_id', [article])).rows;
      release();
      const tasks = new TaskStore(database.db);
      const ids = stage === 'category' ? [admitted.categoryTaskId] : stage === 'tags' ? [admitted.tagsTaskId] : admitted.scoreTaskIds;
      const invalid = stage === 'category' && timing === 'before load' && change === 'content';
      await eventually(async () => (await Promise.all(ids.map(id => tasks.getTask(id)))).every(task => task?.state === (invalid ? 'needs_input' : 'superseded')));
      for (const id of ids) {
        const task = await tasks.getTask(id);
        expect(task).toMatchObject(invalid ? { state: 'needs_input', errorCode: 'invalid_handoff' } : { state: 'superseded', errorCode: 'stale_basis' });
        expect(task?.result).not.toHaveProperty('handoffReceipt');
        await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [task!.jobId])).rows[0]?.state === 'completed');
        expect((await database.pool.query('select name,data,retry_limit from pgboss.job where id=$1', [task!.jobId])).rows[0]).toEqual({ name: stage === 'scores' ? 'score' : stage, data: { taskId: id }, retry_limit: 0 });
      }
      expect((await database.pool.query('select category_id,assignment_revision,content_revision,title,source_id from articles where id=$1', [article])).rows).toEqual(before);
      expect((await database.pool.query('select tag_id from article_tags where article_id=$1 order by tag_id', [article])).rows).toEqual(tagsBefore);
      expect((await database.pool.query('select * from article_scores where article_id=$1', [article])).rows).toEqual([]);
      if (stage === 'category') expect(await tasks.getTask(admitted.tagsTaskId)).toMatchObject({ state: 'waiting_dependency', jobId: null });
      if (stage !== 'scores') for (const id of admitted.scoreTaskIds) expect(await tasks.getTask(id)).toMatchObject({ state: 'waiting_dependency', jobId: null });
      expect(ai.classify).toHaveBeenCalledTimes((stage === 'category' ? 0 : 1) + (timing === 'during inference' && stage !== 'tags' ? 1 : 0));
      expect(ai.generate).toHaveBeenCalledTimes((stage === 'scores' || (stage === 'tags' && timing === 'during inference')) ? 1 : 0);
    } finally { release(); await worker.close(); await scores.close(); }
  }, 30000,
);

it.each((['null root', 'old root', 'wrong anchor'] as const).flatMap(change =>
  (['before load', 'during inference'] as const).map(timing => [change, timing] as const)))(
  'rejects category %s %s without standalone fallback', async (change, timing) => {
    const { article, admitted } = await prepared();
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const barrier = async () => { entered = true; await gate; };
    const ai: AiPort = {
      classify: vi.fn<AiPort['classify']>().mockImplementation(async request => {
        if (timing === 'during inference') await barrier();
        const question = request.questions.category;
        if (!question || question.type !== 'choice') throw new Error('missing choices');
        const id = Object.keys(question.criteria)[0]!;
        return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
      }), generate: vi.fn(), createRestrictedSession: vi.fn(),
    };
    const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel: async () => {
      if (timing === 'before load') await barrier();
      return model('classifier');
    }, resolveTagModel: async () => model('tags') });
    try {
      await eventually(async () => entered);
      if (change === 'null root') await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain}','null') where id=$1", [admitted.categoryTaskId]);
      if (change === 'old root') await database.pool.query("update processing_tasks set result=result #- '{articleChain,tagsTaskId}' where id=$1", [admitted.categoryTaskId]);
      if (change === 'wrong anchor') await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,tagsTaskId}',to_jsonb($2::text)) where id=$1", [admitted.categoryTaskId, randomUUID()]);
      const tasks = new TaskStore(database.db);
      const invalid = (await tasks.getTask(admitted.categoryTaskId))!.result;
      const before = (await database.pool.query('select category_id,assignment_revision from articles where id=$1', [article])).rows;
      release();
      // A well-formed wrong anchor is checked at publication; malformed roots fail at load.
      const beforeLoadRejection = timing === 'before load' && change !== 'wrong anchor';
      const state = beforeLoadRejection ? 'needs_input' : 'superseded';
      await eventually(async () => (await tasks.getTask(admitted.categoryTaskId))?.state === state);
      const task = await tasks.getTask(admitted.categoryTaskId);
      expect(task).toMatchObject({ state, errorCode: beforeLoadRejection ? 'invalid_handoff' : 'stale_basis', result: invalid });
      expect(task?.result).not.toHaveProperty('handoffReceipt');
      await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [task!.jobId])).rows[0]?.state === 'completed');
      expect((await database.pool.query('select category_id,assignment_revision from articles where id=$1', [article])).rows).toEqual(before);
      expect(await tasks.getTask(admitted.tagsTaskId)).toMatchObject({ state: 'waiting_dependency', jobId: null });
      for (const id of admitted.scoreTaskIds) expect(await tasks.getTask(id)).toMatchObject({ state: 'waiting_dependency', jobId: null });
      expect(ai.classify).toHaveBeenCalledTimes(beforeLoadRejection ? 0 : 1);
      expect(ai.generate).not.toHaveBeenCalled();
    } finally { release(); await worker.close(); }
  }, 30000,
);

it.each((['missing child', 'null child', 'malformed child', 'zero reference', 'missing root', 'old root', 'wrong anchor', 'missing receipt', 'missing preparation', 'newer tags'] as const)
  .flatMap(change => (['before load', 'during inference'] as const).map(timing => [change, timing] as const)))(
  'rejects linked tags %s %s without releasing scores', async (change, timing) => {
    const { article, admitted } = await prepared();
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const barrier = async () => { entered = true; await gate; };
    const ai: AiPort = {
      classify: vi.fn<AiPort['classify']>().mockImplementation(async request => {
        const question = request.questions.category;
        if (request.role !== 'category' || !question || question.type !== 'choice') throw new Error('unexpected classification');
        const id = Object.keys(question.criteria)[0]!;
        return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
      }),
      generate: vi.fn<AiPort['generate']>().mockImplementation(async () => {
        if (timing === 'during inference') await barrier();
        return { kind: 'completed', value: { text: '{"tags":["must not publish"]}', usage: null } };
      }), createRestrictedSession: vi.fn(),
    };
    const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel: async () => model('classifier'), resolveTagModel: async () => {
      if (timing === 'before load') await barrier();
      return model('tags');
    } });
    try {
      await eventually(async () => entered);
      const prepare = (await database.pool.query('select prerequisite_id from processing_tasks where id=$1', [admitted.categoryTaskId])).rows[0].prerequisite_id as string;
      switch (change) {
        case 'missing child': await database.pool.query("update processing_tasks set result=result-'articleChain' where id=$1", [admitted.tagsTaskId]); break;
        case 'null child': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain}','null') where id=$1", [admitted.tagsTaskId]); break;
        case 'malformed child': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain}','{}') where id=$1", [admitted.tagsTaskId]); break;
        case 'zero reference': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredHandoff,generation}','0') where id=$1", [admitted.tagsTaskId]); break;
        case 'missing root': await database.pool.query("update processing_tasks set result=result-'articleChain' where id=$1", [admitted.categoryTaskId]); break;
        case 'old root': await database.pool.query("update processing_tasks set result=result #- '{articleChain,tagsTaskId}' where id=$1", [admitted.categoryTaskId]); break;
        case 'wrong anchor': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,tagsTaskId}',to_jsonb($2::text)) where id=$1", [admitted.categoryTaskId, randomUUID()]); break;
        case 'missing receipt': await database.pool.query("update processing_tasks set result=result-'handoffReceipt' where id=$1", [admitted.categoryTaskId]); break;
        case 'missing preparation': await database.pool.query("update processing_tasks set result=result-'preparationReceipt' where id=$1", [prepare]); break;
        case 'newer tags': await new TaskStore(database.db).createTask({ articleId: article, action: 'tags', generation: 2, state: 'failed', createdAt: new Date(), updatedAt: new Date() }); break;
      }
      const ids = [prepare, admitted.categoryTaskId, admitted.tagsTaskId];
      const before = (await database.pool.query('select id,result,prerequisite_id from processing_tasks where id=any($1::uuid[]) order by id', [ids])).rows;
      const articleBefore = (await database.pool.query('select category_id,assignment_revision from articles where id=$1', [article])).rows;
      release();
      const tasks = new TaskStore(database.db);
      const stale = timing === 'during inference' || change === 'newer tags';
      await eventually(async () => (await tasks.getTask(admitted.tagsTaskId))?.state === (stale ? 'superseded' : 'needs_input'));
      const tagTask = await tasks.getTask(admitted.tagsTaskId);
      expect(tagTask).toMatchObject({ errorCode: stale ? 'stale_basis' : 'invalid_handoff' });
      await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [tagTask!.jobId])).rows[0]?.state === 'completed');
      for (const id of admitted.scoreTaskIds) expect(await tasks.getTask(id)).toMatchObject({ state: 'waiting_dependency', jobId: null });
      expect((await database.pool.query('select id,result,prerequisite_id from processing_tasks where id=any($1::uuid[]) order by id', [ids])).rows).toEqual(before);
      expect((await database.pool.query('select category_id,assignment_revision from articles where id=$1', [article])).rows).toEqual(articleBefore);
      expect((await database.pool.query('select tag_id from article_tags where article_id=$1', [article])).rows).toEqual([]);
      expect(ai.classify).toHaveBeenCalledTimes(1);
      expect(ai.generate).toHaveBeenCalledTimes(timing === 'before load' ? 0 : 1);
    } finally { release(); await worker.close(); }
  }, 30000,
);

const scoreHandoffTampering = [
  'missing score chain', 'null score chain', 'zero score reference', 'unactivated score', 'wrong score basis',
  'wrong score reference', 'wrong score prepare', 'wrong score root', 'rewired score',
  'missing tags receipt', 'malformed tags receipt', 'wrong tags receipt generation', 'wrong tags receipt article', 'wrong tags receipt task', 'wrong tags receipt prerequisite', 'wrong tag article', 'wrong tag generation',
  'missing tag chain', 'zero tag reference', 'rewired tag', 'missing root', 'null root', 'old root', 'zero target count', 'wrong anchor',
  'missing category receipt', 'wrong category receipt generation', 'wrong category generation',
  'missing preparation receipt', 'wrong preparation generation', 'wrong preparation article', 'newer tags',
] as const;

it.each(scoreHandoffTampering.flatMap(change => (['before load', 'during inference'] as const).map(timing => [change, timing] as const)))(
  'rejects %s %s through linked score delivery, preserving prior scores', async (change, timing) => {
    const { article, admitted } = await prepared();
    const store = new ScoreStore(database.db);
    for (const target of targets) expect(await store.saveSuccessful({ articleId: article, scoreId: target, value: 25, calculatedAt: new Date(), contentRevision: 1, assignmentRevision: 0 })).toBe(true);
    const before = await Promise.all(targets.map(target => store.get(article, target)));
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const barrier = async () => { if (!entered) { entered = true; await gate; } };
    const ai: AiPort = {
      classify: vi.fn<AiPort['classify']>().mockImplementation(async request => {
        if (request.role === 'category') {
          const question = request.questions.category;
          if (!question || question.type !== 'choice') throw new Error('missing choices');
          const id = Object.keys(question.criteria)[0]!;
          return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
        }
        if (timing === 'during inference') await barrier();
        return { kind: 'completed', value: { answers: { score: { type: 'score', score: 4, confidence: 1, criteria: [] } }, usage: null } };
      }),
      generate: vi.fn<AiPort['generate']>().mockResolvedValue({ kind: 'completed', value: { text: '{"tags":["handoff test"]}', usage: null } }),
      createRestrictedSession: vi.fn(),
    };
    const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel: async () => model('classifier'), resolveTagModel: async () => model('tags') });
    const scores = await startScoreWorker({ ...database, boss, ai, resolveModels: async () => {
      if (timing === 'before load') await barrier();
      return { classifier: model('classifier'), generator: model('generator') };
    } });
    try {
      await eventually(async () => entered);
      const prepare = (await database.pool.query('select prerequisite_id from processing_tasks where id=$1', [admitted.categoryTaskId])).rows[0].prerequisite_id as string;
      const scoreIds = admitted.scoreTaskIds;
      switch (change) {
        case 'missing score chain': await database.pool.query("update processing_tasks set result=result-'articleChain' where id=any($1::uuid[])", [scoreIds]); break;
        case 'null score chain': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain}','null') where id=any($1::uuid[])", [scoreIds]); break;
        case 'zero score reference': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredHandoff,generation}','0') where id=any($1::uuid[])", [scoreIds]); break;
        case 'unactivated score': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredBasis}','null') where id=any($1::uuid[])", [scoreIds]); break;
        case 'wrong score basis': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredBasis,assignmentRevision}','100') where id=any($1::uuid[])", [scoreIds]); break;
        case 'wrong score prepare': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,prepareTaskId}',to_jsonb($2::text)) where id=any($1::uuid[])", [scoreIds, randomUUID()]); break;
        case 'wrong score root': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,rootTaskId}',to_jsonb($2::text)) where id=any($1::uuid[])", [scoreIds, randomUUID()]); break;
        case 'wrong score reference': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredHandoff,taskId}',to_jsonb($2::text)) where id=any($1::uuid[])", [scoreIds, randomUUID()]); break;
        case 'rewired score': await database.pool.query('update processing_tasks set prerequisite_id=$2 where id=any($1::uuid[])', [scoreIds, admitted.categoryTaskId]); break;
        case 'missing tags receipt': await database.pool.query("update processing_tasks set result=result-'handoffReceipt' where id=$1", [admitted.tagsTaskId]); break;
        case 'malformed tags receipt': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{handoffReceipt}','null') where id=$1", [admitted.tagsTaskId]); break;
        case 'wrong tags receipt generation': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{handoffReceipt,generation}','0') where id=$1", [admitted.tagsTaskId]); break;
        case 'wrong tags receipt article': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{handoffReceipt,articleId}',to_jsonb($2::text)) where id=$1", [admitted.tagsTaskId, randomUUID()]); break;
        case 'wrong tags receipt task': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{handoffReceipt,taskId}',to_jsonb($2::text)) where id=$1", [admitted.tagsTaskId, randomUUID()]); break;
        case 'wrong tags receipt prerequisite': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{handoffReceipt,prerequisiteId}',to_jsonb($2::text)) where id=$1", [admitted.tagsTaskId, randomUUID()]); break;
        case 'wrong tag article': {
          const other = (await database.pool.query("insert into articles(context_id,freshrss_id,title,imported_at) values ($1,$2,'Other',now()) returning id", [context, randomUUID()])).rows[0].id;
          await database.pool.query('update processing_tasks set article_id=$2 where id=$1', [admitted.tagsTaskId, other]);
          break;
        }
        case 'wrong tag generation': await database.pool.query('update processing_tasks set generation=2 where id=$1', [admitted.tagsTaskId]); break;
        case 'missing tag chain': await database.pool.query("update processing_tasks set result=result-'articleChain' where id=$1", [admitted.tagsTaskId]); break;
        case 'zero tag reference': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredHandoff,generation}','0') where id=$1", [admitted.tagsTaskId]); break;
        case 'rewired tag': await database.pool.query('update processing_tasks set prerequisite_id=$2 where id=$1', [admitted.tagsTaskId, prepare]); break;
        case 'missing root': await database.pool.query("update processing_tasks set result=result-'articleChain' where id=$1", [admitted.categoryTaskId]); break;
        case 'null root': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain}','null') where id=$1", [admitted.categoryTaskId]); break;
        case 'old root': await database.pool.query("update processing_tasks set result=result #- '{articleChain,tagsTaskId}' where id=$1", [admitted.categoryTaskId]); break;
        case 'zero target count': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,targetCount}','0') where id=$1", [admitted.categoryTaskId]); break;
        case 'wrong anchor': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,tagsTaskId}',to_jsonb($2::text)) where id=$1", [admitted.categoryTaskId, randomUUID()]); break;
        case 'missing category receipt': await database.pool.query("update processing_tasks set result=result-'handoffReceipt' where id=$1", [admitted.categoryTaskId]); break;
        case 'wrong category receipt generation': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{handoffReceipt,generation}','0') where id=$1", [admitted.categoryTaskId]); break;
        case 'wrong category generation': await database.pool.query('update processing_tasks set generation=2 where id=$1', [admitted.categoryTaskId]); break;
        case 'missing preparation receipt': await database.pool.query("update processing_tasks set result=result-'preparationReceipt' where id=$1", [prepare]); break;
        case 'wrong preparation generation': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{preparationReceipt,generation}','2') where id=$1", [prepare]); break;
        case 'wrong preparation article': await database.pool.query("update processing_tasks set result=jsonb_set(result,'{preparationReceipt,articleId}',to_jsonb($2::text)) where id=$1", [prepare, randomUUID()]); break;
        case 'newer tags': await new TaskStore(database.db).createTask({ articleId: article, action: 'tags', generation: 2, state: 'failed', createdAt: new Date(), updatedAt: new Date() }); break;
      }
      const tampered = (await database.pool.query('select id,article_id,result,prerequisite_id from processing_tasks where id=any($1::uuid[]) order by id', [[prepare, admitted.categoryTaskId, admitted.tagsTaskId, ...scoreIds]])).rows;
      release();
      const tasks = new TaskStore(database.db);
      await eventually(async () => (await Promise.all(scoreIds.map(id => tasks.getTask(id)))).every(task => task?.state === 'superseded' || task?.state === 'needs_input'));
      for (const id of scoreIds) {
        const task = await tasks.getTask(id);
        expect(task?.errorCode).toBe(task?.state === 'superseded' ? 'stale_basis' : 'invalid_handoff');
        await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [task!.jobId])).rows[0]?.state === 'completed');
      }
      expect(ai.classify).toHaveBeenCalledTimes(timing === 'before load' ? 1 : 2);
      expect(ai.generate).toHaveBeenCalledTimes(1);
      expect(await Promise.all(targets.map(target => store.get(article, target)))).toEqual(before);
      expect((await database.pool.query('select id,article_id,result,prerequisite_id from processing_tasks where id=any($1::uuid[]) order by id', [[prepare, admitted.categoryTaskId, admitted.tagsTaskId, ...scoreIds]])).rows).toEqual(tampered);
    } finally { release(); await worker.close(); await scores.close(); }
  }, 30000,
);

it.each((['category', 'tags', 'scores'] as const).flatMap(stage =>
  (['standalone', 'null namespace', 'old-shaped namespace', 'namespace added in flight'] as const).map(shape => [stage, shape] as const)))(
  'delivers generation-zero %s %s without standalone fallback for malformed roots', async (stage, shape) => {
    const article = (await database.pool.query("insert into articles(context_id,freshrss_id,title,imported_at) values ($1,$2,'Standalone',now()) returning id", [context, randomUUID()])).rows[0].id as string;
    await new ContentStore(database.db).saveSuccessful(article, { text: 'Standalone usable body', quality: 'usable', capturedAt: new Date() });
    const tasks = new TaskStore(database.db);
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const barrier = async () => { entered = true; await gate; };
    const ai: AiPort = {
      classify: vi.fn<AiPort['classify']>().mockImplementation(async request => {
        if (shape === 'namespace added in flight' && request.role === stage) await barrier();
        if (request.role === 'scores') return { kind: 'completed', value: { answers: { score: { type: 'score', score: 2, confidence: 1, criteria: [] } }, usage: null } };
        const question = request.questions.category;
        if (!question || question.type !== 'choice') throw new Error('missing choices');
        const id = Object.keys(question.criteria)[0]!;
        return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
      }), generate: vi.fn<AiPort['generate']>().mockImplementation(async () => {
        if (shape === 'namespace added in flight' && stage === 'tags') await barrier();
        return { kind: 'completed', value: { text: '{"tags":[]}', usage: null } };
      }), createRestrictedSession: vi.fn(),
    };
    const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel: async () => model('classifier'), resolveTagModel: async () => model('tags') });
    const scores = await startScoreWorker({ ...database, boss, ai, resolveModels: async () => ({ classifier: model('classifier'), generator: model('generator') }) });
    try {
      let prerequisiteId: string | undefined;
      if (stage === 'tags') {
        const category = await tasks.createTask({ articleId: article, action: 'category', generation: 0, state: 'queued', createdAt: new Date(), updatedAt: new Date() });
        const job = await boss.send('category', { taskId: category.id }, { retryLimit: 0 });
        await eventually(async () => (await tasks.getTask(category.id))?.state === 'succeeded');
        await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [job])).rows[0]?.state === 'completed');
        expect(await tasks.getTask(category.id)).toMatchObject({ result: { handoffReceipt: { generation: 0, taskId: category.id } } });
        prerequisiteId = category.id;
      }
      const result = shape === 'standalone' || shape === 'namespace added in flight' ? {} : { articleChain: shape === 'null namespace' ? null : { version: 1 } };
      const task = await tasks.createTask({ articleId: article, action: stage, generation: 0, state: 'queued', result, ...(prerequisiteId ? { prerequisiteId } : {}), ...(stage === 'scores' ? { scoreTargetId: targets[0]! } : {}), createdAt: new Date(), updatedAt: new Date() });
      const job = await boss.send(stage === 'scores' ? 'score' : stage, { taskId: task.id }, { retryLimit: 0 });
      if (shape === 'namespace added in flight') {
        await eventually(async () => entered);
        await database.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain}','null') where id=$1", [task.id]);
        release();
      }
      const expected = shape === 'standalone' ? 'succeeded' : shape === 'namespace added in flight' ? 'superseded' : 'needs_input';
      await eventually(async () => (await tasks.getTask(task.id))?.state === expected);
      await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [job])).rows[0]?.state === 'completed');
      const finished = await tasks.getTask(task.id);
      if (shape === 'standalone') {
        expect(finished?.result).not.toHaveProperty('articleChain');
        if (stage !== 'scores') expect(finished).toMatchObject({ generation: 0, result: { handoffReceipt: { generation: 0, action: stage, taskId: task.id } } });
        else expect((await new ScoreStore(database.db).get(article, targets[0]!))?.value).toBe(50);
      } else {
        expect(finished).toMatchObject(shape === 'namespace added in flight'
          ? { state: 'superseded', errorCode: 'stale_basis', result: { articleChain: null } }
          : { state: 'needs_input', errorCode: 'invalid_handoff', result });
        expect(finished?.result).not.toHaveProperty('handoffReceipt');
        expect(await new ScoreStore(database.db).get(article, targets[0]!)).toBeNull();
      }
      const dispatched = shape === 'standalone' || shape === 'namespace added in flight';
      expect(ai.classify).toHaveBeenCalledTimes((stage === 'tags' ? 1 : 0) + (dispatched && stage !== 'tags' ? 1 : 0));
      expect(ai.generate).toHaveBeenCalledTimes(dispatched && stage === 'tags' ? 1 : 0);
      expect((await database.pool.query('select count(*) n from processing_tasks where article_id=$1', [article])).rows[0].n).toBe(stage === 'tags' ? '2' : '1');
    } finally { release(); await worker.close(); await scores.close(); }
  }, 30000,
);

it.each((['category', 'tags'] as const).flatMap(stage =>
  (['budget', 'auth', 'configuration', 'oversize', 'invalid answer'] as const).map(reason => [stage, reason] as const)))(
  'records %s %s through the queue without releasing descendants', async (stage, reason) => {
    const { article, admitted } = await prepared();
    const ai: AiPort = {
      classify: vi.fn<AiPort['classify']>().mockImplementation(async request => {
        if (stage === 'category' && reason === 'budget') return { kind: 'paused_budget', reason: 'daily_limit' };
        if (stage === 'category' && reason === 'auth') return { kind: 'paused_auth' };
        if (stage === 'category' && reason === 'invalid answer') return { kind: 'completed', value: { answers: {}, usage: null } };
        const question = request.questions.category;
        if (!question || question.type !== 'choice') throw new Error('missing choices');
        const id = Object.keys(question.criteria)[0]!;
        return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
      }),
      generate: vi.fn<AiPort['generate']>().mockImplementation(async () => {
        if (reason === 'budget') return { kind: 'paused_budget', reason: 'daily_limit' };
        if (reason === 'auth') return { kind: 'paused_auth' };
        return { kind: 'completed', value: { text: 'not json', usage: null } };
      }), createRestrictedSession: vi.fn(),
    };
    const resolve = async (name: 'category' | 'tags') => {
      if (stage === name && reason === 'configuration') return null;
      const configured = model(name === 'category' ? 'classifier' : 'tags');
      return stage === name && reason === 'oversize' ? { ...configured, countTokens: () => 10000 } : configured;
    };
    const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel: () => resolve('category'), resolveTagModel: () => resolve('tags') });
    try {
      const tasks = new TaskStore(database.db);
      const taskId = stage === 'category' ? admitted.categoryTaskId : admitted.tagsTaskId;
      const expected = reason === 'budget' ? { state: 'paused_budget', errorCode: 'daily_limit' }
        : reason === 'auth' ? { state: 'paused_auth', errorCode: 'auth_required' }
          : reason === 'configuration' ? { state: 'needs_input', errorCode: 'configuration_required' }
            : reason === 'oversize' ? { state: 'needs_input', errorCode: 'context_too_large' }
              : { state: 'failed', errorCode: stage === 'category' ? 'invalid_category_answer' : 'invalid_tag_answer' };
      await eventually(async () => (await tasks.getTask(taskId))?.state === expected.state);
      const task = await tasks.getTask(taskId);
      expect(task).toMatchObject(expected);
      expect(task?.result).not.toHaveProperty('handoffReceipt');
      await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [task!.jobId])).rows[0]?.state === 'completed');
      if (stage === 'category') expect(await tasks.getTask(admitted.tagsTaskId)).toMatchObject({ state: 'waiting_dependency', jobId: null });
      for (const id of admitted.scoreTaskIds) expect(await tasks.getTask(id)).toMatchObject({ state: 'waiting_dependency', jobId: null });
      expect((await database.pool.query('select * from article_scores where article_id=$1', [article])).rows).toEqual([]);
      expect(ai.classify).toHaveBeenCalledTimes(stage === 'tags' || !['configuration', 'oversize'].includes(reason) ? 1 : 0);
      expect(ai.generate).toHaveBeenCalledTimes(stage === 'tags' && !['configuration', 'oversize'].includes(reason) ? 1 : 0);
    } finally { await worker.close(); }
  }, 30000,
);

it.each(['category', 'tags', 'scores'] as const)('obsolete %s owner cannot publish or reclaim on duplicate delivery', async stage => {
  const { article, admitted } = await prepared();
  const store = new ScoreStore(database.db);
  for (const target of targets) await store.saveSuccessful({ articleId: article, scoreId: target, value: 25, calculatedAt: new Date(), contentRevision: 1, assignmentRevision: 0 });
  let entered = false;
  let running = '';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const barrier = async (taskId: string | undefined) => {
    if (!taskId) throw new Error('missing task ID');
    if (!entered) { running = taskId; entered = true; await gate; }
  };
  const ai: AiPort = {
    classify: vi.fn<AiPort['classify']>().mockImplementation(async (request, options) => {
      if (request.role === stage) await barrier(options.taskId);
      if (request.role === 'category') {
        const question = request.questions.category;
        if (!question || question.type !== 'choice') throw new Error('missing choices');
        const id = Object.keys(question.criteria)[0]!;
        return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
      }
      return { kind: 'completed', value: { answers: { score: { type: 'score', score: 4, confidence: 1, criteria: [] } }, usage: null } };
    }),
    generate: vi.fn<AiPort['generate']>().mockImplementation(async (_request, options) => {
      if (stage === 'tags') await barrier(options.taskId);
      return { kind: 'completed', value: { text: '{"tags":[]}', usage: null } };
    }), createRestrictedSession: vi.fn(),
  };
  const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel: async () => model('classifier'), resolveTagModel: async () => model('tags') });
  const scores = await startScoreWorker({ ...database, boss, ai, resolveModels: async () => ({ classifier: model('classifier'), generator: model('generator') }) });
  try {
    await eventually(async () => entered);
    const tasks = new TaskStore(database.db);
    const claimed = await tasks.getTask(running);
    const target = (await database.pool.query('select score_target_id from processing_tasks where id=$1', [running])).rows[0].score_target_id as string | null;
    const prior = target ? await store.get(article, target) : null;
    const token = randomUUID();
    await database.pool.query('update processing_tasks set execution_token=$2 where id=$1', [running, token]);
    const duplicate = await boss.send(stage === 'scores' ? 'score' : stage, { taskId: running }, { retryLimit: 0 });
    release();
    for (const id of [claimed!.jobId, duplicate]) await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [id])).rows[0]?.state === 'completed');
    expect(await tasks.getTask(running)).toMatchObject({ state: 'running', executionToken: token, attemptCount: 1 });
    expect((await tasks.getTask(running))?.result).not.toHaveProperty('handoffReceipt');
    if (stage === 'category') expect(await tasks.getTask(admitted.tagsTaskId)).toMatchObject({ state: 'waiting_dependency', jobId: null });
    if (stage !== 'scores') for (const id of admitted.scoreTaskIds) expect(await tasks.getTask(id)).toMatchObject({ state: 'waiting_dependency', jobId: null });
    if (target) expect(await store.get(article, target)).toEqual(prior);
  } finally { release(); await worker.close(); await scores.close(); }
}, 30000);

it('isolates a failing article from a concurrent successful chain and retains prior scores', async () => {
  const failed = await prepared();
  const good = await prepared();
  const store = new ScoreStore(database.db);
  for (const target of targets) await store.saveSuccessful({ articleId: failed.article, scoreId: target, value: 25, calculatedAt: new Date(), contentRevision: 1, assignmentRevision: 0 });
  const prior = await Promise.all(targets.map(target => store.get(failed.article, target)));
  const ai: AiPort = {
    classify: vi.fn<AiPort['classify']>().mockImplementation(async (request, options) => {
      if (request.role === 'category') {
        if (options.taskId === failed.admitted.categoryTaskId) return { kind: 'completed', value: { answers: {}, usage: null } };
        const question = request.questions.category;
        if (!question || question.type !== 'choice') throw new Error('missing choices');
        const id = Object.keys(question.criteria)[0]!;
        return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
      }
      return { kind: 'completed', value: { answers: { score: { type: 'score', score: 2, confidence: 1, criteria: [] } }, usage: null } };
    }), generate: vi.fn<AiPort['generate']>().mockResolvedValue({ kind: 'completed', value: { text: '{"tags":[]}', usage: null } }), createRestrictedSession: vi.fn(),
  };
  const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel: async () => model('classifier'), resolveTagModel: async () => model('tags') });
  const scores = await startScoreWorker({ ...database, boss, ai, resolveModels: async () => ({ classifier: model('classifier'), generator: model('generator') }) });
  try {
    const tasks = new TaskStore(database.db);
    const goodIds = [good.admitted.categoryTaskId, good.admitted.tagsTaskId, ...good.admitted.scoreTaskIds];
    await eventually(async () => (await Promise.all(goodIds.map(id => tasks.getTask(id)))).every(task => task?.state === 'succeeded'));
    expect(await tasks.getTask(failed.admitted.categoryTaskId)).toMatchObject({ state: 'failed', errorCode: 'invalid_category_answer' });
    expect(await tasks.getTask(failed.admitted.tagsTaskId)).toMatchObject({ state: 'waiting_dependency', jobId: null });
    for (const id of failed.admitted.scoreTaskIds) expect(await tasks.getTask(id)).toMatchObject({ state: 'waiting_dependency', jobId: null });
    expect(await Promise.all(targets.map(target => store.get(failed.article, target)))).toEqual(prior);
    for (const target of targets) expect((await store.get(good.article, target))?.value).toBe(50);
    for (const id of goodIds) { const task = await tasks.getTask(id); await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [task!.jobId])).rows[0]?.state === 'completed'); }
  } finally { await worker.close(); await scores.close(); }
}, 30000);

it.each(['failure', 'budget', 'configuration', 'oversize'] as const)('preserves a prior linked score on %s while siblings succeed', async reason => {
  const { article, admitted } = await prepared();
  const store = new ScoreStore(database.db);
  for (const target of targets) await store.saveSuccessful({ articleId: article, scoreId: target, value: 25, calculatedAt: new Date(), contentRevision: 1, assignmentRevision: 0 });
  const prior = await store.get(article, targets[0]!);
  const ai: AiPort = {
    classify: vi.fn<AiPort['classify']>().mockImplementation(async (request, options) => {
      if (request.role === 'category') {
        const question = request.questions.category;
        if (!question || question.type !== 'choice') throw new Error('missing choices');
        const id = Object.keys(question.criteria)[0]!;
        return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
      }
      const target = (await database.pool.query('select score_target_id from processing_tasks where id=$1', [options.taskId])).rows[0].score_target_id;
      if (target === targets[0] && reason === 'failure') return { kind: 'completed', value: { answers: {}, usage: null } };
      if (target === targets[0] && reason === 'budget') return { kind: 'paused_budget', reason: 'daily_limit' };
      return { kind: 'completed', value: { answers: { score: { type: 'score', score: 2, confidence: 1, criteria: [] } }, usage: null } };
    }), generate: vi.fn<AiPort['generate']>().mockResolvedValue({ kind: 'completed', value: { text: '{"tags":[]}', usage: null } }), createRestrictedSession: vi.fn(),
  };
  const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel: async () => model('classifier'), resolveTagModel: async () => model('tags') });
  const scores = await startScoreWorker({ ...database, boss, ai, resolveModels: async () => {
    const row = (await database.pool.query("select score_target_id from processing_tasks where id=any($1::uuid[]) and state='running'", [admitted.scoreTaskIds])).rows[0];
    if (!row) throw new Error('missing running score');
    if (row.score_target_id === targets[0] && reason === 'configuration') return null;
    const classifier = model('classifier');
    return { classifier: row.score_target_id === targets[0] && reason === 'oversize' ? { ...classifier, countTokens: () => 10000 } : classifier, generator: model('generator') };
  } });
  try {
    const tasks = new TaskStore(database.db);
    const expected = reason === 'failure' ? { state: 'failed', errorCode: 'score_task_failure' } : reason === 'budget' ? { state: 'paused_budget', errorCode: 'daily_limit' } : { state: 'needs_input', errorCode: reason === 'configuration' ? 'configuration_required' : 'context_too_large' };
    await eventually(async () => (await Promise.all(admitted.scoreTaskIds.map(id => tasks.getTask(id)))).every(task => task?.state === 'succeeded' || task?.state === expected.state));
    for (const id of admitted.scoreTaskIds) {
      const task = await tasks.getTask(id);
      const target = (await database.pool.query('select score_target_id from processing_tasks where id=$1', [id])).rows[0].score_target_id;
      expect(task).toMatchObject(target === targets[0] ? expected : { state: 'succeeded', errorCode: null });
      await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [task!.jobId])).rows[0]?.state === 'completed');
    }
    expect(await store.get(article, targets[0]!)).toEqual(prior);
    for (const target of targets.slice(1)) expect((await store.get(article, target))?.value).toBe(50);
    expect(ai.classify).toHaveBeenCalledTimes(reason === 'configuration' || reason === 'oversize' ? 3 : 4);
    expect(ai.generate).toHaveBeenCalledTimes(1);
  } finally { await worker.close(); await scores.close(); }
}, 30000);

it('uses dispatch-time configuration and preserves successful siblings of paused and retired scores', async () => {
  const { article, admitted } = await prepared();
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  const ai: AiPort = {
    classify: vi.fn<AiPort['classify']>().mockImplementation(async (request, options) => {
      if (request.role === 'category') {
        const question = request.questions.category;
        if (!question || question.type !== 'choice') throw new Error('missing choices');
        const id = Object.keys(question.criteria)[0]!;
        return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
      }
      const target = (await database.pool.query('select score_target_id from processing_tasks where id=$1', [options.taskId])).rows[0].score_target_id as string;
      seen.push(target);
      expect(request.model).toEqual({ provider: 'fake', model: 'changed-classifier' });
      expect(request.state).toEqual({ title: 'Synthetic title' });
      expect(request.questions.score).toMatchObject({ instructions: 'dispatch-time prompt' });
      if (target === targets[0]) return { kind: 'paused_auth' };
      return { kind: 'completed', value: { answers: { score: { type: 'score', score: 2, confidence: 1, criteria: [] } }, usage: null } };
    }),
    generate: vi.fn<AiPort['generate']>().mockResolvedValue({ kind: 'completed', value: { text: '{"tags":["dispatch proof"]}', usage: null } }),
    createRestrictedSession: vi.fn(),
  };
  const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel: async () => model('classifier'), resolveTagModel: async () => model('tags') });
  const scores = await startScoreWorker({ ...database, boss, ai, resolveModels: async () => {
    if (!entered) { entered = true; await gate; }
    return { classifier: model('changed-classifier'), generator: model('generator') };
  } });
  try {
    await eventually(async () => entered);
    await database.pool.query("update model_roles set model='changed-classifier' where role='scores'");
    await database.pool.query("update score_definitions set prompt='dispatch-time prompt',include_title=true,include_content=false,include_category=false,include_tag_weights=false,include_source_weight=false where id=any($1::uuid[])", [targets]);
    await database.pool.query('delete from score_category_prompts where score_id=any($1::uuid[])', [targets]);
    await database.pool.query('update score_definitions set active=false where id=$1', [targets[1]]);
    const later = (await database.pool.query("insert into score_definitions(name,description,prompt) values ($1,'','later prompt') returning id", [randomUUID()])).rows[0].id as string;
    await database.pool.query('update catalog_epoch set revision=revision+1 where id=1');
    release();
    const tasks = new TaskStore(database.db);
    await eventually(async () => (await Promise.all(admitted.scoreTaskIds.map(id => tasks.getTask(id)))).every(task => task?.state === 'succeeded' || task?.state === 'paused_auth' || task?.state === 'superseded'));
    for (const id of admitted.scoreTaskIds) {
      const task = await tasks.getTask(id);
      const target = (await database.pool.query('select score_target_id from processing_tasks where id=$1', [id])).rows[0].score_target_id;
      expect(task).toMatchObject(target === targets[0] ? { state: 'paused_auth', errorCode: 'auth_required' } : target === targets[1] ? { state: 'superseded', errorCode: 'stale_basis' } : { state: 'succeeded', errorCode: null });
      await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [task!.jobId])).rows[0]?.state === 'completed');
      const result = await new ScoreStore(database.db).get(article, target);
      if (target === targets[0] || target === targets[1]) expect(result).toBeNull(); else expect(result?.value).toBe(50);
    }
    expect(seen.sort()).toEqual([targets[0], targets[2]].sort());
    expect((await database.pool.query("select id from processing_tasks where article_id=$1 and action='scores' and score_target_id=$2", [article, later])).rows).toEqual([]);
    expect(await tasks.getTask(admitted.tagsTaskId)).toMatchObject({ state: 'succeeded' });
  } finally { release(); await worker.close(); await scores.close(); }
}, 30000);

it('misrouted queued tasks remain unclaimed without resolving either model', async () => {
  const article = (await database.pool.query("insert into articles(context_id,freshrss_id,title,imported_at) values ($1,$2,'misrouted',now()) returning id", [context, randomUUID()])).rows[0].id as string;
  const tasks = new TaskStore(database.db);
  const at = new Date();
  const category = await tasks.createTask({ articleId: article, action: 'category', state: 'queued', createdAt: at, updatedAt: at });
  const tags = await tasks.createTask({ articleId: article, action: 'tags', state: 'queued', createdAt: at, updatedAt: at });
  const score = await tasks.createTask({ articleId: article, action: 'scores', scoreTargetId: targets[0]!, state: 'queued', createdAt: at, updatedAt: at });
  const ids = await Promise.all([boss.send('category', { taskId: tags.id }, { retryLimit: 0 }), boss.send('tags', { taskId: category.id }, { retryLimit: 0 }), boss.send('category', { taskId: score.id }, { retryLimit: 0 }), boss.send('tags', { taskId: score.id }, { retryLimit: 0 })]);
  const resolveCategoryModel = vi.fn(async () => model('classifier'));
  const resolveTagModel = vi.fn(async () => model('tags'));
  const ai: AiPort = { classify: vi.fn(), generate: vi.fn(), createRestrictedSession: vi.fn() };
  const worker = await startArticleWorkers({ ...database, boss, ai, resolveCategoryModel, resolveTagModel });
  try {
    for (const id of ids) await eventually(async () => (await database.pool.query('select state from pgboss.job where id=$1', [id])).rows[0]?.state === 'completed');
    expect(await tasks.getTask(category.id)).toMatchObject({ state: 'queued', executionToken: null });
    expect(await tasks.getTask(tags.id)).toMatchObject({ state: 'queued', executionToken: null });
    expect(await tasks.getTask(score.id)).toMatchObject({ state: 'queued', executionToken: null });
    expect(resolveCategoryModel).not.toHaveBeenCalled(); expect(resolveTagModel).not.toHaveBeenCalled();
    expect(ai.classify).not.toHaveBeenCalled(); expect(ai.generate).not.toHaveBeenCalled();
  } finally { await worker.close(); }
}, 30000);
