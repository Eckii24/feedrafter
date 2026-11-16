import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { CatalogStore } from '../../src/server/adapters/postgres/catalog-store.js';
import { TagTaskInputStore } from '../../src/server/adapters/postgres/tag-task-input-store.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { assignTags } from '../../src/server/application/assign-tags.js';
import { UsageAttemptError } from '../../src/server/application/usage.js';
import type { AiPort } from '../../src/server/ports/ai.js';
import type { VerifiedModel } from '../../src/server/application/score-context-request.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let context: string;
const at = new Date('2026-01-02T03:04:05Z');
const model = { model: { provider: 'fake', model: 'tags' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: vi.fn(() => 1) };
beforeAll(async () => {
  db = await createUsageDatabase(); await migrateDatabase(db.pool);
  context = (await db.pool.query("insert into import_contexts(instance,account) values ('tags-kernel','test') returning id")).rows[0].id;
}, 30000);
afterAll(async () => { if (db) await db.dispose(); });
beforeEach(async () => { await db.pool.query("update model_roles set provider='fake',model='tags' where role='tags'"); model.countTokens.mockClear(); });
async function fixture() {
  const article = (await db.pool.query("insert into articles(context_id,freshrss_id,title,imported_at) values ($1,$2,'Title',now()) returning id", [context, randomUUID()])).rows[0].id as string;
  await new ContentStore(db.db).saveSuccessful(article, { text: 'Full body', quality: 'usable', capturedAt: at });
  const tasks = new TaskStore(db.db), catalog = new CatalogStore(db.db);
  const category = await tasks.createTask({ articleId: article, action: 'category', generation: 3, state: 'succeeded', createdAt: at, updatedAt: at });
  const task = await tasks.createTask({ articleId: article, action: 'tags', generation: 2, state: 'queued', prerequisiteId: category.id, createdAt: at, updatedAt: at });
  const token = randomUUID(); await tasks.claimTask(task.id, token, at);
  const generate = vi.fn<AiPort['generate']>().mockResolvedValue({ kind: 'completed', value: { text: '{"tags":[]}', usage: null } });
  const deps = { ai: { generate, classify: vi.fn<AiPort['classify']>(), createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() }, inputs: new TagTaskInputStore(db.pool), catalog, tasks, model: model as VerifiedModel | null, signal: new AbortController().signal, now: () => at };
  const run = () => assignTags(task.id, token, deps);
  return { article, category, task, token, deps, run, record: () => tasks.getTask(task.id) };
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

it.each(['new category', 'new tags', 'category state', 'category generation', 'category rewire', 'tag rewire', 'prepare state', 'content', 'quality', 'title', 'epoch', 'assignment', 'owner'])('fences %s after capture', async why => {
  const f = await fixture();
  const prepare = await f.deps.tasks.createTask({ articleId: f.article, action: 'prepare', generation: 1, state: 'succeeded', createdAt: at, updatedAt: at });
  await db.pool.query('update processing_tasks set prerequisite_id=$2 where id=$1', [f.category.id, prepare.id]);
  f.deps.ai.generate.mockImplementation(async () => {
    if (why === 'new category' || why === 'new tags') await f.deps.tasks.createTask({ articleId: f.article, action: why === 'new tags' ? 'tags' : 'category', generation: 4, state: 'failed', createdAt: at, updatedAt: at });
    if (why === 'category state') await db.pool.query("update processing_tasks set state='failed' where id=$1", [f.category.id]);
    if (why === 'category generation') await db.pool.query('update processing_tasks set generation=4 where id=$1', [f.category.id]);
    if (why === 'category rewire') await db.pool.query('update processing_tasks set prerequisite_id=null where id=$1', [f.category.id]);
    if (why === 'tag rewire') await db.pool.query('update processing_tasks set prerequisite_id=null where id=$1', [f.task.id]);
    if (why === 'prepare state') await db.pool.query("update processing_tasks set state='failed' where id=$1", [prepare.id]);
    if (why === 'content') await db.pool.query("update article_contents set text='changed' where article_id=$1", [f.article]);
    if (why === 'quality') await db.pool.query("update article_contents set quality='unusable' where article_id=$1", [f.article]);
    if (why === 'title') await db.pool.query("update articles set title='changed' where id=$1", [f.article]);
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
