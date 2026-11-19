import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { PgBoss } from 'pg-boss';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { CatalogStore } from '../../src/server/adapters/postgres/catalog-store.js';
import { ArticleJobs } from '../../src/server/adapters/postgres/article-jobs.js';
import { CategoryTaskInputStore } from '../../src/server/adapters/postgres/category-task-input-store.js';
import { TagTaskInputStore } from '../../src/server/adapters/postgres/tag-task-input-store.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { assignTags } from '../../src/server/application/assign-tags.js';
import { UsageAttemptError } from '../../src/server/application/usage.js';
import type { AiPort } from '../../src/server/ports/ai.js';
import type { VerifiedModel } from '../../src/server/application/score-context-request.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let context: string;
let boss: PgBoss;
const at = new Date('2026-01-02T03:04:05Z');
const model = { model: { provider: 'fake', model: 'tags' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: vi.fn(() => 1) };
beforeAll(async () => {
  db = await createUsageDatabase(); await migrateDatabase(db.pool);
  context = (await db.pool.query("insert into import_contexts(instance,account) values ('tags-kernel','test') returning id")).rows[0].id;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error('Missing disposable database connection string');
  boss = new PgBoss({ connectionString }); boss.on('error', () => {}); await boss.start();
  await boss.createQueue('category'); await boss.createQueue('tags');
}, 30000);
afterAll(async () => { if (boss) await boss.stop(); if (db) await db.dispose(); });
beforeEach(async () => { await db.pool.query("update model_roles set provider='fake',model='tags' where role='tags'"); model.countTokens.mockClear(); });
async function changeSource(article: string) {
  const source = (await db.pool.query('insert into sources(context_id,external_feed_id) values ($1,$2) returning id', [context, randomUUID()])).rows[0].id;
  await db.pool.query('update articles set source_id=$2 where id=$1', [article, source]);
}
async function fixture(categoryGeneration = 3, tagGeneration = 2) {
  const article = (await db.pool.query("insert into articles(context_id,freshrss_id,title,imported_at) values ($1,$2,'Title',now()) returning id", [context, randomUUID()])).rows[0].id as string;
  await new ContentStore(db.db).saveSuccessful(article, { text: 'Full body', quality: 'usable', capturedAt: at });
  const tasks = new TaskStore(db.db), catalog = new CatalogStore(db.db);
  const prepare = await tasks.createTask({ articleId: article, action: 'prepare', generation: 1, state: 'succeeded', createdAt: at, updatedAt: at });
  const category = await tasks.createTask({ articleId: article, action: 'category', generation: categoryGeneration, prerequisiteId: prepare.id, createdAt: at, updatedAt: at });
  const categoryToken = randomUUID(); await tasks.claimTask(category.id, categoryToken, at);
  const basis = (await db.pool.query('select category_id,content_revision,assignment_revision,(select revision from catalog_epoch where id=1) as epoch from articles where id=$1', [article])).rows[0];
  expect(await catalog.publishCategoryCandidate({ taskId: category.id, executionToken: categoryToken, articleId: article, generation: categoryGeneration, prerequisiteId: prepare.id, contentRevision: basis.content_revision, contentText: 'Full body', assignmentRevision: basis.assignment_revision, catalogEpoch: basis.epoch, categoryId: basis.category_id }, at)).not.toBeNull();
  const task = await tasks.createTask({ articleId: article, action: 'tags', generation: tagGeneration, state: 'queued', prerequisiteId: category.id, createdAt: at, updatedAt: at });
  const token = randomUUID(); await tasks.claimTask(task.id, token, at);
  const generate = vi.fn<AiPort['generate']>().mockResolvedValue({ kind: 'completed', value: { text: '{"tags":[]}', usage: null } });
  const deps = { ai: { generate, classify: vi.fn<AiPort['classify']>(), createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() }, inputs: new TagTaskInputStore(db.pool), catalog, tasks, model: model as VerifiedModel | null, signal: new AbortController().signal, now: () => at };
  const run = () => assignTags(task.id, token, deps);
  return { article, prepare, category, task, token, deps, run, record: () => tasks.getTask(task.id) };
}

async function linkedFixture(targetCount = 0) {
  await db.pool.query('update score_definitions set active=false');
  if (targetCount) await db.pool.query("insert into score_definitions(name,description,prompt) values ($1,'','prompt')", [`target-${randomUUID()}`]);
  const article = (await db.pool.query("insert into articles(context_id,freshrss_id,title,imported_at) values ($1,$2,'Linked',now()) returning id", [context, randomUUID()])).rows[0].id as string;
  const tasks = new TaskStore(db.db), catalog = new CatalogStore(db.db), jobs = new ArticleJobs(db.db, boss);
  const prepare = await tasks.createTask({ articleId: article, action: 'prepare', generation: 1, createdAt: at, updatedAt: at });
  const prepareToken = randomUUID(); await tasks.claimTask(prepare.id, prepareToken, at);
  expect(await new ContentStore(db.db).publishTask({ taskId: prepare.id, articleId: article, action: 'prepare', generation: 1, executionToken: prepareToken, expectedContentRevision: 0 }, { kind: 'success', content: { text: 'Linked body', quality: 'usable', capturedAt: at }, at })).toBe(1);
  const admitted = await jobs.admitPreparedArticle(article, prepare.id, at);
  if (admitted.kind !== 'admitted') throw new Error(`Unexpected admission ${admitted.kind}`);
  await db.pool.query("update model_roles set provider='fake',model='tags' where role='category'");
  const categoryToken = randomUUID(); await tasks.claimTask(admitted.categoryTaskId, categoryToken, at);
  const input = await new CategoryTaskInputStore(db.pool).loadResult(admitted.categoryTaskId, categoryToken, model, new AbortController().signal);
  if (input.kind !== 'loaded') throw new Error(`Unexpected category input ${input.kind}`);
  const categoryId = (await db.pool.query('select category_id from articles where id=$1', [article])).rows[0].category_id as string;
  expect(await jobs.publishCategoryCandidate({ ...input.input.basis, categoryId }, at)).not.toBeNull();
  const token = randomUUID(); await tasks.claimTask(admitted.tagsTaskId, token, at);
  const inputs = new TagTaskInputStore(db.pool), signal = new AbortController().signal;
  return { article, prepare, admitted, tasks, catalog, jobs, token, inputs, signal, load: () => inputs.loadResult(admitted.tagsTaskId, token, model, signal) };
}

it('publishes empty tags and measures the exact bounded request', async () => {
  const f = await fixture();
  expect(await f.run()).toEqual({ kind: 'published' });
  expect(await f.record()).toMatchObject({ state: 'succeeded' });
  const [request, scope] = f.deps.ai.generate.mock.calls[0]!;
  const category = (await db.pool.query('select c.label from articles a join categories c on c.id=a.category_id where a.id=$1', [f.article])).rows[0].label;
  expect(request).toEqual({ model: model.model, role: 'tags', system: expect.any(String), user: JSON.stringify({ title: 'Title', category, content: 'Full body' }) });
  expect(model.countTokens).toHaveBeenCalledWith(JSON.stringify(request));
  expect(scope).toMatchObject({ bucket: 'automatic', taskId: f.task.id, signal: f.deps.signal });
  expect(f.deps.ai.generate).toHaveBeenCalledOnce(); expect(f.deps.ai.classify).not.toHaveBeenCalled();
});

it('runs generation-zero standalone category and tags receipts through the kernel', async () => {
  const f = await fixture(0, 0);
  expect(await f.run()).toEqual({ kind: 'published' });
  expect(await f.record()).toMatchObject({ state: 'succeeded', generation: 0, result: { handoffReceipt: { taskId: f.task.id, generation: 0, action: 'tags', prerequisiteId: f.category.id } } });
});

it.each([0, 1])('publishes standalone generation-%i tags through ArticleJobs', async generation => {
  const f = await fixture(generation, generation);
  const jobs = new ArticleJobs(db.db, boss);
  expect(await assignTags(f.task.id, f.token, { ...f.deps, catalog: jobs })).toEqual({ kind: 'published' });
  expect(await f.record()).toMatchObject({ state: 'succeeded', generation, result: { handoffReceipt: { taskId: f.task.id, generation, action: 'tags', prerequisiteId: f.category.id } } });
});

it.each(['empty', 'new', 'existing'])('publishes generation-zero standalone %s tags through ArticleJobs', async mode => {
  const f = await fixture(0, 0);
  const jobs = new ArticleJobs(db.db, boss);
  const label = `standalone-${randomUUID()}`;
  if (mode === 'existing') {
    const tag = await f.deps.catalog.createTag(label);
    expect(await f.deps.catalog.attachTag(f.article, tag.id)).toBe(true);
  }
  await db.pool.query("update processing_tasks set result=coalesce(result,'{}'::jsonb) || '{\"extra\":true}'::jsonb where id=$1", [f.task.id]);
  const before = (await db.pool.query('select assignment_revision,(select revision from catalog_epoch where id=1) epoch from articles where id=$1', [f.article])).rows[0];
  const categoryBefore = await f.deps.tasks.getTask(f.category.id);
  f.deps.ai.generate.mockResolvedValue({ kind: 'completed', value: { text: JSON.stringify({ tags: mode === 'empty' ? [] : [label] }), usage: null } });
  expect(await assignTags(f.task.id, f.token, { ...f.deps, catalog: jobs })).toEqual({ kind: 'published' });
  const task = await f.record();
  expect(task).toMatchObject({ state: 'succeeded', generation: 0, result: { extra: true, handoffReceipt: { taskId: f.task.id, generation: 0, action: 'tags', prerequisiteId: f.category.id,
    catalogEpoch: before.epoch + (mode === 'new' ? 1 : 0), basis: { assignmentRevision: before.assignment_revision + (mode === 'new' ? 1 : 0) } } } });
  expect(task!.result).not.toHaveProperty('articleChain');
  expect(await f.deps.tasks.getTask(f.category.id)).toEqual(categoryBefore);
  expect((await db.pool.query("select id from processing_tasks where article_id=$1 and action='scores'", [f.article])).rows).toEqual([]);
  expect((await db.pool.query("select id from pgboss.job where data->>'taskId'=$1", [f.task.id])).rows).toEqual([]);
});

it('maps an invalid category receipt to needs-input without inference', async () => {
  const f = await fixture();
  await db.pool.query("update processing_tasks set result=result-'handoffReceipt' where id=$1", [f.category.id]);
  expect(await f.run()).toEqual({ kind: 'needs_input' });
  expect(await f.record()).toMatchObject({ errorCode: 'invalid_handoff' });
  expect(f.deps.ai.generate).not.toHaveBeenCalled();
});

it.each([0, 1])('captures a real chain with %i targets but both catalog publishers reject it without writes', async targetCount => {
  const f = await linkedFixture(targetCount);
  const loaded = await f.load();
  if (loaded.kind !== 'loaded') throw new Error(`Unexpected input ${loaded.kind}`);
  expect(loaded.input.basis.chainRoot).toMatchObject({ tagsTaskId: f.admitted.tagsTaskId, targetCount });
  expect(loaded.input.basis.chainConsumer).toMatchObject({ rootTaskId: f.admitted.categoryTaskId });
  const candidate = { ...loaded.input.basis, labels: [] };
  const before = (await db.pool.query('select * from processing_tasks where article_id=$1 order by id', [f.article])).rows;
  const articleBefore = (await db.pool.query('select * from articles where id=$1', [f.article])).rows;
  const epoch = (await db.pool.query('select revision from catalog_epoch where id=1')).rows;
  expect(await f.catalog.publishTagCandidate(candidate, at)).toBeNull();
  expect(await db.db.transaction(tx => f.catalog.publishTagCandidateInTransaction(tx, candidate, at))).toBeNull();
  expect((await db.pool.query('select * from processing_tasks where article_id=$1 order by id', [f.article])).rows).toEqual(before);
  expect((await db.pool.query('select * from articles where id=$1', [f.article])).rows).toEqual(articleBefore);
  expect((await db.pool.query('select revision from catalog_epoch where id=1')).rows).toEqual(epoch);
  expect(await f.catalog.listArticleTags(f.article)).toEqual([]);
  await db.pool.query("update processing_tasks set result=result-'articleChain' where id=$1", [f.admitted.tagsTaskId]);
  const omitted = { ...candidate }; delete omitted.chainRoot; delete omitted.chainConsumer;
  expect(await f.load()).toEqual({ kind: 'invalid_handoff' });
  expect(await f.catalog.publishTagCandidate(omitted, at)).toBeNull();
  expect(await db.db.transaction(tx => f.catalog.publishTagCandidateInTransaction(tx, omitted, at))).toBeNull();
  expect(await f.jobs.publishTagCandidate(omitted, at)).toBeNull();
});

it('snapshots linked handoff metadata before inference and passes it unchanged to the closed publisher', async () => {
  const f = await linkedFixture();
  const loaded = await f.load();
  if (loaded.kind !== 'loaded' || !loaded.input.basis.chainConsumer) throw new Error('Expected linked input');
  const original = structuredClone(loaded.input.basis);
  const publish = vi.spyOn(f.catalog, 'publishTagCandidate');
  const ai = { generate: vi.fn<AiPort['generate']>().mockImplementation(async () => {
    loaded.input.basis.chainConsumer!.rootTaskId = randomUUID();
    loaded.input.basis.prerequisiteReceipt.basis.assignmentRevision++;
    return { kind: 'completed', value: { text: '{"tags":[]}', usage: null } };
  }), classify: vi.fn<AiPort['classify']>(), createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() };
  expect(await assignTags(f.admitted.tagsTaskId, f.token, { inputs: { loadResult: async () => loaded }, catalog: f.catalog, tasks: f.tasks, ai, model, signal: f.signal, now: () => at })).toEqual({ kind: 'superseded' });
  expect(publish).toHaveBeenCalledWith({ ...original, labels: [] }, at);
});

it.each(['null child', 'malformed child', 'unactivated', 'zero reference', 'wrong reference', 'old root', 'wrong anchor', 'missing receipt', 'missing preparation', 'changed title', 'changed source', 'changed category', 'changed content', 'changed assignment', 'newer prepare', 'newer category', 'newer tags'])('rejects linked %s before inference', async change => {
  const f = await linkedFixture();
  const root = f.admitted.categoryTaskId, child = f.admitted.tagsTaskId;
  if (change === 'null child') await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain}','null') where id=$1", [child]);
  if (change === 'malformed child') await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain}','{}') where id=$1", [child]);
  if (change === 'unactivated') await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredBasis}','null') where id=$1", [child]);
  if (change === 'zero reference') await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredHandoff,generation}','0') where id=$1", [child]);
  if (change === 'wrong reference') await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredHandoff,generation}','2') where id=$1", [child]);
  if (change === 'missing preparation') await db.pool.query("update processing_tasks set result=result-'preparationReceipt' where id=$1", [f.prepare.id]);
  if (change === 'old root') await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain}',(result->'articleChain')-'tagsTaskId') where id=$1", [root]);
  if (change === 'wrong anchor') await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,tagsTaskId}',to_jsonb($2::text)) where id=$1", [root, randomUUID()]);
  if (change === 'missing receipt') await db.pool.query("update processing_tasks set result=result-'handoffReceipt' where id=$1", [root]);
  if (change === 'changed title') await db.pool.query("update articles set title='changed' where id=$1", [f.article]);
  if (change === 'changed source') await changeSource(f.article);
  if (change === 'changed assignment') await db.pool.query('update articles set assignment_revision=assignment_revision+1 where id=$1', [f.article]);
  if (change === 'changed content') await db.pool.query('update articles set content_revision=content_revision+1 where id=$1', [f.article]);
  if (change === 'changed category') { const category = await f.catalog.createCategory(`changed-${randomUUID()}`); await f.catalog.setCategory(f.article, category.id); }
  if (change.startsWith('newer ')) await f.tasks.createTask({ articleId: f.article, action: change.slice(6) as 'prepare' | 'category' | 'tags', generation: 2, state: 'failed', createdAt: at, updatedAt: at });
  expect(await f.load()).toEqual({ kind: change.startsWith('changed') || change.startsWith('newer') ? 'stale_basis' : 'invalid_handoff' });
});

it.each(['not json', '[]', '{}', '{"tags":[],"extra":1}', '{"tags":null}', '{"tags":[1]}', '{"tags":[" "]}', '{"tags":["\\u0000"]}', '{"tags":["\\ud800"]}', '{"tags":["A", "Ａ"]}', JSON.stringify({ tags: Array(11).fill('tag') })])('rejects malformed answer %s', async text => {
  const f = await fixture(); f.deps.ai.generate.mockResolvedValue({ kind: 'completed', value: { text, usage: null } });
  expect(await f.run()).toEqual({ kind: 'failed' });
  expect(await f.record()).toMatchObject({ state: 'failed', errorCode: 'invalid_tag_answer' });
  expect(await f.deps.catalog.listArticleTags(f.article)).toHaveLength(0);
});
it.each(['x'.repeat(4096), '猫'.repeat(1400), 'ß'.repeat(501)])('rejects oversized normalized keys before publication', async label => {
  const f = await fixture();
  const publish = vi.spyOn(f.deps.catalog, 'publishTagCandidate');
  const loaded = await f.deps.inputs.loadResult(f.task.id, f.token, f.deps.model, f.deps.signal);
  if (loaded.kind !== 'loaded') throw new Error('Expected loaded basis');
  const before = Number((await db.pool.query('select count(*) as n from tags')).rows[0].n);
  expect(await f.deps.catalog.publishTagCandidate({ ...loaded.input.basis, labels: [`safe-${randomUUID()}`, label] }, at)).toBeNull();
  expect(Number((await db.pool.query('select count(*) as n from tags')).rows[0].n)).toBe(before);
  publish.mockClear();
  f.deps.ai.generate.mockResolvedValue({ kind: 'completed', value: { text: JSON.stringify({ tags: [label] }), usage: null } });
  expect(await f.run()).toEqual({ kind: 'failed' });
  expect(await f.record()).toMatchObject({ state: 'failed', errorCode: 'invalid_tag_answer' });
  expect(f.deps.ai.generate).toHaveBeenCalledOnce(); expect(publish).not.toHaveBeenCalled();
  expect(Number((await db.pool.query('select count(*) as n from tags')).rows[0].n)).toBe(before);
});

it('checks the exact casefolded key byte limit', async () => {
  const f = await fixture();
  expect(await f.deps.catalog.tagKeysFit(['ß'.repeat(500)])).toBe(true);
  expect(await f.deps.catalog.tagKeysFit(['ß'.repeat(501)])).toBe(false);
  expect(await f.deps.catalog.tagKeysFit([`a${' '.repeat(4096)}b`])).toBe(true);
});

it('settles pre-publication validation errors without entering the publisher', async () => {
  const f = await fixture();
  vi.spyOn(f.deps.catalog, 'tagKeysFit').mockRejectedValue(new Error('database unavailable'));
  const publish = vi.spyOn(f.deps.catalog, 'publishTagCandidate');
  expect(await f.run()).toEqual({ kind: 'failed' });
  expect(await f.record()).toMatchObject({ state: 'failed', errorCode: 'tag_validation_failure' });
  expect(f.deps.ai.generate).toHaveBeenCalledOnce(); expect(publish).not.toHaveBeenCalled();
});

it('publishes normalized labels', async () => {
  const f = await fixture(); f.deps.ai.generate.mockResolvedValue({ kind: 'completed', value: { text: '{"tags":["  Ｆｏｏ  bar  "]}', usage: null } });
  expect(await f.run()).toEqual({ kind: 'published' });
  expect(await f.deps.catalog.listArticleTags(f.article)).toMatchObject([{ label: 'Foo bar' }]);
});

it.each(['null', 'failed', 'wrong article', 'wrong action', 'bad prepare', 'prepare wrong article', 'prepare wrong action', 'missing', 'unusable', 'blank', 'revision', 'newer tags', 'newer category', 'model', 'role', 'bounds', 'oversize', 'count'])('fails closed before AI for %s', async why => {
  const f = await fixture();
  if (why === 'null') await db.pool.query('update processing_tasks set prerequisite_id=null where id=$1', [f.task.id]);
  if (why === 'failed') await db.pool.query("update processing_tasks set state='failed' where id=$1", [f.category.id]);
  if (why === 'wrong article') { const other = await fixture(); await db.pool.query('update processing_tasks set prerequisite_id=$2 where id=$1', [f.task.id, other.category.id]); }
  if (why === 'wrong action') await db.pool.query("update processing_tasks set action='quality' where id=$1", [f.category.id]);
  if (['bad prepare', 'prepare wrong article', 'prepare wrong action'].includes(why)) {
    const articleId = why === 'prepare wrong article' ? (await fixture()).article : f.article;
    const p = await f.deps.tasks.createTask({ articleId, action: why === 'prepare wrong action' ? 'quality' : 'prepare', generation: 1, state: why === 'bad prepare' ? 'failed' : 'succeeded', createdAt: at, updatedAt: at });
    await db.pool.query('update processing_tasks set prerequisite_id=$2 where id=$1', [f.category.id, p.id]);
  }
  if (why === 'missing') await db.pool.query('delete from article_contents where article_id=$1', [f.article]);
  if (why === 'unusable') await db.pool.query("update article_contents set quality='unusable' where article_id=$1", [f.article]);
  if (why === 'blank') await db.pool.query("update article_contents set text='   ' where article_id=$1", [f.article]);
  if (why === 'revision') await db.pool.query('update articles set content_revision=content_revision+1 where id=$1', [f.article]);
  if (why === 'newer tags' || why === 'newer category') await f.deps.tasks.createTask({ articleId: f.article, action: why === 'newer tags' ? 'tags' : 'category', generation: 4, state: 'failed', createdAt: at, updatedAt: at });
  if (why === 'model') f.deps.model = null;
  if (why === 'role') await db.pool.query("update model_roles set model='other' where role='tags'");
  if (why === 'bounds') f.deps.model = { ...model, limits: { ...model.limits, contextTokens: 0 } };
  if (why === 'oversize') f.deps.model = { ...model, limits: { ...model.limits, contextTokens: 101 } };
  if (why === 'count') f.deps.model = { ...model, countTokens: () => NaN };
  const stale = ['newer tags', 'newer category'].includes(why);
  expect(await f.run()).toEqual({ kind: stale ? 'superseded' : 'needs_input' });
  if (why === 'revision') expect(await f.record()).toMatchObject({ errorCode: 'content_revision_mismatch' });
  expect(f.deps.ai.generate).not.toHaveBeenCalled();
});

it.each(['new category', 'new tags', 'category state', 'category generation', 'category rewire', 'category receipt', 'category chain', 'tag chain', 'tag rewire', 'prepare state', 'content', 'quality', 'title', 'source', 'epoch', 'assignment', 'owner'])('fences %s after capture', async why => {
  const f = await fixture();
  const prepare = f.prepare;
  f.deps.ai.generate.mockImplementation(async () => {
    if (why === 'new category' || why === 'new tags') await f.deps.tasks.createTask({ articleId: f.article, action: why === 'new tags' ? 'tags' : 'category', generation: 4, state: 'failed', createdAt: at, updatedAt: at });
    if (why === 'category state') await db.pool.query("update processing_tasks set state='failed' where id=$1", [f.category.id]);
    if (why === 'category generation') await db.pool.query('update processing_tasks set generation=4 where id=$1', [f.category.id]);
    if (why === 'category rewire') await db.pool.query('update processing_tasks set prerequisite_id=null where id=$1', [f.category.id]);
    if (why === 'category chain' || why === 'tag chain') await db.pool.query("update processing_tasks set result=jsonb_set(coalesce(result,'{}'::jsonb),'{articleChain}','null') where id=$1", [why === 'category chain' ? f.category.id : f.task.id]);
    if (why === 'category receipt') await db.pool.query("update processing_tasks set result=result-'handoffReceipt' where id=$1", [f.category.id]);
    if (why === 'tag rewire') await db.pool.query('update processing_tasks set prerequisite_id=null where id=$1', [f.task.id]);
    if (why === 'prepare state') await db.pool.query("update processing_tasks set state='failed' where id=$1", [prepare.id]);
    if (why === 'content') await db.pool.query("update article_contents set text='changed' where article_id=$1", [f.article]);
    if (why === 'quality') await db.pool.query("update article_contents set quality='unusable' where article_id=$1", [f.article]);
    if (why === 'title') await db.pool.query("update articles set title='changed' where id=$1", [f.article]);
    if (why === 'source') await changeSource(f.article);
    if (why === 'epoch') await f.deps.catalog.createTag(`epoch-${randomUUID()}`);
    if (why === 'assignment') await db.pool.query('update articles set assignment_revision=assignment_revision+1 where id=$1', [f.article]);
    if (why === 'owner') await db.pool.query('update processing_tasks set execution_token=$2 where id=$1', [f.task.id, randomUUID()]);
    return { kind: 'completed', value: { text: '{"tags":["never"]}', usage: null } };
  });
  expect(await f.run()).toEqual({ kind: why === 'owner' ? 'ownership_lost' : 'superseded' });
  expect(await f.deps.catalog.listArticleTags(f.article)).toHaveLength(0);
});

it('enforces the publisher-entry cancellation cutoff and ambiguous publication', async () => {
  const a = await fixture(), controller = new AbortController(); a.deps.signal = controller.signal;
  a.deps.ai.generate.mockImplementation(async () => { controller.abort(); return { kind: 'completed', value: { text: '{"tags":[]}', usage: null } }; });
  expect(await a.run()).toEqual({ kind: 'failed' }); expect(await a.record()).toMatchObject({ errorCode: 'cancelled_before_publication' });
  const b = await fixture(), later = new AbortController(); b.deps.signal = later.signal;
  const publish = b.deps.catalog.publishTagCandidate.bind(b.deps.catalog);
  b.deps.catalog.publishTagCandidate = async (...args) => { later.abort(); return publish(...args); };
  expect(await b.run()).toEqual({ kind: 'published' });
  const c = await fixture(), original = c.deps.catalog.publishTagCandidate.bind(c.deps.catalog);
  c.deps.catalog.publishTagCandidate = async (...args) => { await original(...args); throw new Error('lost response'); };
  await expect(c.run()).rejects.toThrow('Tag publication failed'); expect(await c.record()).toMatchObject({ state: 'succeeded' });
});
it.each([['paused_budget', 'daily_limit'], ['paused_auth', 'auth_required'], ['paused_configuration', 'configuration_required']] as const)('preserves %s', async (kind, code) => {
  const f = await fixture(); f.deps.ai.generate.mockResolvedValue(kind === 'paused_budget' ? { kind, reason: 'daily_limit' } : { kind });
  expect(await f.run()).toEqual({ kind: kind === 'paused_configuration' ? 'needs_input' : kind }); expect(await f.record()).toMatchObject({ errorCode: code });
});
it.each([['uncertain', 'failed', 'dispatch_uncertain'], ['auth', 'paused_auth', 'auth_required'], ['provider', 'failed', 'provider_failure'], ['aborted', 'failed', 'cancelled_before_dispatch']] as const)('preserves %s dispatch', async (error, state, code) => {
  const f = await fixture(); f.deps.ai.generate.mockRejectedValue(new UsageAttemptError('fixture', error));
  expect(await f.run()).toEqual({ kind: state }); expect(await f.record()).toMatchObject({ errorCode: code });
  expect(f.deps.ai.generate).toHaveBeenCalledOnce();
});
