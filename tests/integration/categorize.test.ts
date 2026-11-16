import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { CatalogStore } from '../../src/server/adapters/postgres/catalog-store.js';
import { CategoryTaskInputStore } from '../../src/server/adapters/postgres/category-task-input-store.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { categorize } from '../../src/server/application/categorize.js';
import type { VerifiedModel } from '../../src/server/application/score-context-request.js';
import { UsageAttemptError } from '../../src/server/application/usage.js';
import { fallbackCategoryId } from '../../src/shared/taxonomy.js';
import type { AiPort, ClassificationRequest } from '../../src/server/ports/ai.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let context: string;
const at = new Date('2026-01-02T03:04:05Z');
const model = { model: { provider: 'fake', model: 'classifier' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: vi.fn((serialized: string) => serialized.length > 0 ? 1 : 0) };

beforeAll(async () => {
  db = await createUsageDatabase();
  const version = await db.pool.query('show server_version_num');
  expect(Number(version.rows[0].server_version_num)).toBeGreaterThanOrEqual(180000);
  expect(Number(version.rows[0].server_version_num)).toBeLessThan(190000);
  await migrateDatabase(db.pool);
  context = (await db.pool.query("insert into import_contexts(instance,account) values ('category','test') returning id")).rows[0].id;
}, 30000);
afterAll(async () => { if (db) await db.dispose(); });
beforeEach(async () => { await db.pool.query("update model_roles set provider='fake',model='classifier' where role='category'"); model.countTokens.mockClear(); });

async function fixture() {
  const article = (await db.pool.query("insert into articles(context_id,freshrss_id,title,imported_at) values ($1,$2,'Title',now()) returning id", [context, randomUUID()])).rows[0].id as string;
  await new ContentStore(db.db).saveSuccessful(article, { text: 'Body', quality: 'usable', capturedAt: at });
  const tasks = new TaskStore(db.db);
  const task = await tasks.createTask({ articleId: article, action: 'category', generation: 1, state: 'queued', createdAt: at, updatedAt: at });
  const token = randomUUID();
  expect(await tasks.claimTask(task.id, token, at)).toBeTruthy();
  const chosen = (await db.pool.query('select id from categories where archived_at is null and id<>$1 order by id limit 1', [fallbackCategoryId])).rows[0].id as string;
  const response = (request: ClassificationRequest, choice = chosen, p = 0.7, confidence = 0.7) => {
    const question = request.questions.category!;
    if (question.type !== 'choice') throw new Error('expected choice');
    return { kind: 'completed' as const, value: { answers: { category: { type: 'choice' as const, choice, confidence, probabilities: Object.fromEntries(Object.keys(question.criteria).map(id => [id, id === choice ? p : 0])) } }, usage: null } };
  };
  const classify = vi.fn<AiPort['classify']>().mockImplementation(async request => response(request));
  const ai = { classify, generate: vi.fn<AiPort['generate']>(), createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() };
  const deps = { ai, inputs: new CategoryTaskInputStore(db.pool), catalog: new CatalogStore(db.db), tasks, model: model as VerifiedModel | null, signal: new AbortController().signal, now: () => at };
  const run = () => categorize(task.id, token, deps);
  const record = async () => ({ task: await tasks.getTask(task.id), article: (await db.pool.query('select category_id,assignment_revision from articles where id=$1', [article])).rows[0] });
  return { article, task, token, chosen, response, deps, run, record };
}

it.each([[0.7, 0.7, true], [0.699999, 1, false], [1, 0.699999, false], [1, 1, true]])('applies threshold probability=%s confidence=%s', async (p, confidence, accept) => {
  const f = await fixture();
  f.deps.ai.classify.mockImplementation(async request => f.response(request, f.chosen, p as number, confidence as number));
  expect(await f.run()).toEqual({ kind: 'published' });
  const row = await f.record();
  expect(row.article.category_id).toBe(accept ? f.chosen : fallbackCategoryId);
  expect(row.task).toMatchObject({ state: 'succeeded', errorCode: null });
  expect(f.deps.ai.classify).toHaveBeenCalledOnce();
  const [request, scope] = f.deps.ai.classify.mock.calls[0]!;
  expect(request).toMatchObject({ role: 'category', state: { title: 'Title', content: 'Body' }, questions: { category: { type: 'choice' } } });
  expect(scope).toMatchObject({ bucket: 'classifier', taskId: f.task.id, signal: f.deps.signal });
  expect(model.countTokens).toHaveBeenCalledWith(JSON.stringify(request));
  expect(f.deps.ai.generate).not.toHaveBeenCalled();
});

it.each(['unknown', 'missing probability', 'extra probability', 'nan', 'confidence', 'extra answer', 'wrong type'])('fails visibly on %s', async reason => {
  const f = await fixture();
  f.deps.ai.classify.mockImplementation(async request => {
    const result = f.response(request);
    const answer = result.value.answers.category;
    if (reason === 'unknown') answer.choice = randomUUID();
    if (reason === 'missing probability') delete answer.probabilities[f.chosen];
    if (reason === 'extra probability') answer.probabilities[randomUUID()] = 0;
    if (reason === 'nan') answer.probabilities[f.chosen] = NaN;
    if (reason === 'confidence') answer.confidence = Infinity;
    if (reason === 'extra answer') Object.assign(result.value.answers, { extra: answer });
    if (reason === 'wrong type') Object.assign(answer, { type: 'score' });
    return result;
  });
  expect(await f.run()).toEqual({ kind: 'failed' });
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'failed', errorCode: 'invalid_category_answer' });
  expect(row.article.category_id).toBe(fallbackCategoryId);
});

it('validates against the captured choices even if the AI mutates its request', async () => {
  const f = await fixture();
  const unknown = randomUUID();
  f.deps.ai.classify.mockImplementation(async request => {
    const question = request.questions.category!;
    if (question.type !== 'choice') throw new Error('expected choice');
    delete question.criteria[f.chosen];
    question.criteria[unknown] = 'injected';
    return f.response(request, unknown, 1, 1);
  });
  expect(await f.run()).toEqual({ kind: 'failed' });
  expect((await f.record()).task).toMatchObject({ errorCode: 'invalid_category_answer' });
});

it.each(['missing role', 'missing model', 'mismatch', 'invalid limits', 'oversized', 'bad count', 'missing content'])('fails closed for %s', async reason => {
  const f = await fixture();
  if (reason === 'missing role') await db.pool.query("update model_roles set provider=null,model=null where role='category'");
  if (reason === 'missing model') f.deps.model = null;
  if (reason === 'mismatch') f.deps.model = { ...model, model: { ...model.model, model: 'other' } };
  if (reason === 'invalid limits') f.deps.model = { ...model, limits: { ...model.limits, contextTokens: 0 } };
  if (reason === 'oversized') f.deps.model = { ...model, limits: { ...model.limits, contextTokens: 101 } };
  if (reason === 'bad count') f.deps.model = { ...model, countTokens: vi.fn(() => NaN) };
  if (reason === 'missing content') { await db.pool.query('delete from article_contents where article_id=$1', [f.article]); }
  expect(await f.run()).toEqual({ kind: 'needs_input' });
  expect((await f.record()).task).toMatchObject({ state: 'needs_input', errorCode: reason === 'missing content' ? 'missing_selected_content' : reason === 'oversized' ? 'context_too_large' : 'configuration_required' });
  expect(f.deps.ai.classify).not.toHaveBeenCalled();
});

it.each(['failed', 'running', 'wrong article', 'wrong action', 'missing'])('requires the exact successful prepare prerequisite: %s', async reason => {
  const f = await fixture();
  const other = reason === 'wrong article' ? (await fixture()).article : f.article;
  const prerequisite = await f.deps.tasks.createTask({ articleId: other, action: reason === 'wrong action' ? 'quality' : 'prepare', generation: 7, state: reason === 'running' ? 'running' : reason === 'failed' ? 'failed' : 'succeeded', createdAt: at, updatedAt: at });
  // A separate successful prepare must never be used as a fallback.
  await f.deps.tasks.createTask({ articleId: f.article, action: 'prepare', generation: 8, state: 'succeeded', createdAt: at, updatedAt: at });
  await db.pool.query('update processing_tasks set prerequisite_id=$2 where id=$1', [f.task.id, prerequisite.id]);
  if (reason === 'missing') {
    // The foreign key normally prevents this; a null root is covered separately.
    await db.pool.query('alter table processing_tasks disable trigger all');
    try { await db.pool.query('delete from processing_tasks where id=$1', [prerequisite.id]); } finally { await db.pool.query('alter table processing_tasks enable trigger all'); }
  }
  expect(await f.run()).toEqual({ kind: 'needs_input' });
  expect((await f.record()).task).toMatchObject({ errorCode: 'prerequisite_required' });
  expect(f.deps.ai.classify).not.toHaveBeenCalled();
});

it.each(['unusable', 'unknown'])('rejects %s content despite a successful prerequisite', async quality => {
  const f = await fixture();
  const prerequisite = await f.deps.tasks.createTask({ articleId: f.article, action: 'prepare', generation: 1, state: 'succeeded', createdAt: at, updatedAt: at });
  await db.pool.query('update processing_tasks set prerequisite_id=$2 where id=$1', [f.task.id, prerequisite.id]);
  await db.pool.query('update article_contents set quality=$2 where article_id=$1', [f.article, quality]);
  expect(await f.run()).toEqual({ kind: 'needs_input' });
  expect((await f.record()).task).toMatchObject({ errorCode: 'content_not_usable' });
  expect(f.deps.ai.classify).not.toHaveBeenCalled();
});

it('allows a usable root with a limitation and a successful declared prerequisite', async () => {
  const root = await fixture();
  await db.pool.query("update article_contents set limitation='partial' where article_id=$1", [root.article]);
  expect(await root.run()).toEqual({ kind: 'published' });
  const f = await fixture();
  const prerequisite = await f.deps.tasks.createTask({ articleId: f.article, action: 'prepare', generation: 1, state: 'succeeded', createdAt: at, updatedAt: at });
  await db.pool.query('update processing_tasks set prerequisite_id=$2 where id=$1', [f.task.id, prerequisite.id]);
  expect(await f.run()).toEqual({ kind: 'published' });
});

it.each(['newer', 'wrong action', 'wrong owner', 'stale content'])('does not infer on %s', async reason => {
  const f = await fixture();
  if (reason === 'newer') await f.deps.tasks.createTask({ articleId: f.article, action: 'category', generation: 2, state: 'failed', createdAt: at, updatedAt: at });
  if (reason === 'wrong action') await db.pool.query("update processing_tasks set action='quality' where id=$1", [f.task.id]);
  if (reason === 'wrong owner') await db.pool.query('update processing_tasks set execution_token=$2 where id=$1', [f.task.id, randomUUID()]);
  if (reason === 'stale content') await db.pool.query('update articles set content_revision=content_revision+1 where id=$1', [f.article]);
  expect(await f.run()).toEqual({ kind: reason === 'wrong owner' || reason === 'wrong action' ? 'ownership_lost' : 'superseded' });
  expect(f.deps.ai.classify).not.toHaveBeenCalled();
});

it.each([['paused_budget', 'daily_limit'], ['paused_auth', 'auth_required'], ['paused_configuration', 'configuration_required']] as const)('preserves %s', async (kind, code) => {
  const f = await fixture();
  f.deps.ai.classify.mockResolvedValue(kind === 'paused_budget' ? { kind, reason: 'daily_limit' } : { kind });
  expect(await f.run()).toEqual({ kind: kind === 'paused_configuration' ? 'needs_input' : kind });
  expect((await f.record()).task).toMatchObject({ errorCode: code });
});

it('preserves uncertain dispatch and fences changed basis during inference', async () => {
  const f = await fixture();
  f.deps.ai.classify.mockRejectedValueOnce(new UsageAttemptError('fixture', 'uncertain'));
  expect(await f.run()).toEqual({ kind: 'failed' });
  expect((await f.record()).task).toMatchObject({ errorCode: 'dispatch_uncertain' });
  const g = await fixture();
  g.deps.ai.classify.mockImplementation(async request => { await db.pool.query('update articles set assignment_revision=assignment_revision+1 where id=$1', [g.article]); return g.response(request); });
  expect(await g.run()).toEqual({ kind: 'superseded' });
  expect((await g.record()).article.category_id).toBe(fallbackCategoryId);
});

it('does not overwrite a committed publication after an ambiguous error', async () => {
  const f = await fixture();
  const publish = f.deps.catalog.publishCategoryCandidate.bind(f.deps.catalog);
  f.deps.catalog.publishCategoryCandidate = async (...args) => { await publish(...args); throw new Error('lost response'); };
  await expect(f.run()).rejects.toThrow('Category publication failed');
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'succeeded' });
  expect(row.article.category_id).toBe(f.chosen);
});
