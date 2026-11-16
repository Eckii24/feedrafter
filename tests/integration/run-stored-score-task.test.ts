import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { ScoreStore } from '../../src/server/adapters/postgres/score-store.js';
import { ScoreTaskInputStore } from '../../src/server/adapters/postgres/score-task-input-store.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { runStoredScoreTask } from '../../src/server/application/run-stored-score-task.js';
import { UsageAttemptError } from '../../src/server/application/usage.js';
import type { AiPort } from '../../src/server/ports/ai.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let context: string;
const score = '10000000-0000-4000-8000-000000000001';
const classifier = { model: { provider: 'fake', model: 'classifier' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: () => 1 };
const models = { classifier, generator: { ...classifier, model: { provider: 'fake', model: 'generator' } } };
const at = new Date('2026-01-02T03:04:05Z');

beforeAll(async () => {
  db = await createUsageDatabase();
  const version = await db.pool.query('show server_version_num');
  expect(Number(version.rows[0].server_version_num)).toBeGreaterThanOrEqual(180000);
  expect(Number(version.rows[0].server_version_num)).toBeLessThan(190000);
  await migrateDatabase(db.pool);
  context = (await db.pool.query("insert into import_contexts(instance,account) values ('executor','test') returning id")).rows[0].id;
}, 30000);
afterAll(async () => { if (db) await db.dispose(); });
beforeEach(async () => {
  await db.pool.query("update model_roles set provider='fake', model=case role when 'scores' then 'classifier' else 'generator' end where role in ('scores','context_reduction')");
  await db.pool.query('update score_definitions set active=true, deleted_at=null, include_title=true, include_content=true, include_category=false, include_tag_weights=false, include_source_weight=false where id=$1', [score]);
});

async function fixture() {
  const article = (await db.pool.query("insert into articles(context_id,freshrss_id,title,imported_at) values ($1,$2,'Title',now()) returning id", [context, randomUUID()])).rows[0].id as string;
  await new ContentStore(db.db).saveSuccessful(article, { text: 'Body', quality: 'usable', capturedAt: at });
  const scores = new ScoreStore(db.db);
  await scores.saveSuccessful({ articleId: article, scoreId: score, value: 25, calculatedAt: at, contentRevision: 1, assignmentRevision: 0 });
  const tasks = new TaskStore(db.db);
  const task = await tasks.createTask({ articleId: article, action: 'scores', scoreTargetId: score, generation: 1, state: 'queued', createdAt: at, updatedAt: at });
  const classify = vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'completed', value: { answers: { score: { type: 'score', score: 3, confidence: 1, criteria: [] } }, usage: null } });
  const ai = { classify, generate: vi.fn<AiPort['generate']>(), createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() };
  const deps = { ai, inputs: new ScoreTaskInputStore(db.pool), scores, tasks, models, signal: new AbortController().signal, now: () => at };
  const record = async () => ({ task: await tasks.getTask(task.id), score: await scores.get(article, score) });
  return { article, task, deps, record };
}

it('claims once, loads persisted context and atomically publishes', async () => {
  const f = await fixture();
  expect(await runStoredScoreTask(f.task.id, f.deps)).toEqual({ kind: 'published' });
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'succeeded', attemptCount: 1, startedAt: at, updatedAt: at, endedAt: at, errorCode: null });
  expect(row.task!.executionToken).toMatch(/^[0-9a-f-]{36}$/);
  expect(row.score).toMatchObject({ value: 75, calculatedAt: at, contentRevision: 1 });
  expect(f.deps.ai.classify).toHaveBeenCalledOnce();
  expect(f.deps.ai.classify.mock.calls[0]![0].state).toEqual({ title: 'Title', content: 'Body' });
  expect(f.deps.ai.classify.mock.calls[0]![1]).toMatchObject({ taskId: f.task.id, signal: f.deps.signal });
  expect(f.deps.ai.generate).not.toHaveBeenCalled();
  expect(await runStoredScoreTask(f.task.id, f.deps)).toEqual({ kind: 'not_claimed' });
  expect(f.deps.ai.classify).toHaveBeenCalledOnce();
});

it.each(['missing role', 'no capabilities', 'mismatch', 'invalid'])('requires configuration for %s without dispatch', async reason => {
  const f = await fixture();
  if (reason === 'missing role') await db.pool.query("update model_roles set provider=null,model=null where role='scores'");
  const selected = reason === 'no capabilities' ? null : reason === 'mismatch' ? { ...models, classifier: { ...classifier, model: { provider: 'fake', model: 'other' } } } : reason === 'invalid' ? { ...models, classifier: { ...classifier, limits: { ...classifier.limits, contextTokens: 0 } } } : models;
  expect(await runStoredScoreTask(f.task.id, { ...f.deps, models: selected })).toEqual({ kind: 'needs_input' });
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'needs_input', errorCode: 'configuration_required', attemptCount: 1, updatedAt: at, endedAt: null });
  expect(row.score!.value).toBe(25);
  expect(f.deps.ai.classify).not.toHaveBeenCalled(); expect(f.deps.ai.generate).not.toHaveBeenCalled();
});

it.each(['category', 'tags'] as const)('does not claim a misrouted %s task or resolve configuration', async action => {
  const f = await fixture();
  const other = await f.deps.tasks.createTask({ articleId: f.article, action, generation: 1, state: 'queued', createdAt: at, updatedAt: at });
  const resolveModels = vi.fn(async () => models);
  expect(await runStoredScoreTask(other.id, { ...f.deps, models: resolveModels })).toEqual({ kind: 'not_claimed' });
  expect(await f.deps.tasks.getTask(other.id)).toMatchObject({ state: 'queued', executionToken: null, attemptCount: 0 });
  expect(resolveModels).not.toHaveBeenCalled();
  expect(f.deps.ai.classify).not.toHaveBeenCalled();
  expect(f.deps.ai.generate).not.toHaveBeenCalled();
});

it.each(['category', 'tags', 'scores'] as const)('action-fenced %s claim is atomic and rejects duplicate deliveries', async action => {
  const f = await fixture();
  const task = action === 'scores' ? f.task : await f.deps.tasks.createTask({ articleId: f.article, action, generation: 1, state: 'queued', createdAt: at, updatedAt: at });
  const wrong = action === 'category' ? 'tags' : 'category';
  const tokens = Array.from({ length: 8 }, () => randomUUID());
  const claims = await Promise.all(tokens.map((token, index) => f.deps.tasks.claimTaskForAction(task.id, index === 0 ? wrong : action, token, at)));
  expect(claims[0]).toBeNull();
  const winners = claims.filter(row => row !== null);
  expect(winners).toHaveLength(1);
  expect(await f.deps.tasks.getTask(task.id)).toMatchObject({ state: 'running', executionToken: winners[0]!.executionToken, attemptCount: 1 });
  expect(await f.deps.tasks.claimTaskForAction(task.id, action, randomUUID(), at)).toBeNull();
});

it('claims retry_wait with a fresh token and exactly one attempt', async () => {
  const f = await fixture();
  const previous = randomUUID();
  await db.pool.query("update processing_tasks set state='retry_wait', execution_token=$2, attempt_count=1 where id=$1", [f.task.id, previous]);
  expect(await runStoredScoreTask(f.task.id, f.deps)).toEqual({ kind: 'published' });
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'succeeded', attemptCount: 2 });
  expect(row.task!.executionToken).not.toBe(previous);
  expect(f.deps.ai.classify).toHaveBeenCalledOnce();
});

it('keeps selected-content guard and previous score', async () => {
  const f = await fixture();
  await db.pool.query('delete from article_contents where article_id=$1', [f.article]);
  await db.pool.query('update articles set content_revision=0 where id=$1', [f.article]);
  expect(await runStoredScoreTask(f.task.id, f.deps)).toEqual({ kind: 'needs_input' });
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'needs_input', errorCode: 'missing_selected_content' });
  expect(row.score!.value).toBe(25);
  expect(f.deps.ai.classify).not.toHaveBeenCalled();
});

it.each(['inactive', 'newer', 'stale content'])('supersedes %s before dispatch', async reason => {
  const f = await fixture();
  if (reason === 'inactive') await db.pool.query('update score_definitions set active=false where id=$1', [score]);
  if (reason === 'newer') await f.deps.tasks.createTask({ articleId: f.article, action: 'scores', scoreTargetId: score, generation: 2, state: 'failed', createdAt: at, updatedAt: at });
  if (reason === 'stale content') await db.pool.query('update articles set content_revision=content_revision+1 where id=$1', [f.article]);
  expect(await runStoredScoreTask(f.task.id, { ...f.deps, models: null })).toEqual({ kind: 'superseded' });
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'superseded', errorCode: 'stale_basis', endedAt: at });
  expect(row.score!.value).toBe(25);
  expect(f.deps.ai.classify).not.toHaveBeenCalled();
});

it('does not claim a terminal task or a missing task', async () => {
  const f = await fixture();
  await db.pool.query("update processing_tasks set state='failed',error_code='previous' where id=$1", [f.task.id]);
  expect(await runStoredScoreTask(f.task.id, f.deps)).toEqual({ kind: 'not_claimed' });
  expect(await runStoredScoreTask(randomUUID(), f.deps)).toEqual({ kind: 'not_claimed' });
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'failed', errorCode: 'previous', attemptCount: 0, executionToken: null });
  expect(row.score!.value).toBe(25);
  expect(f.deps.ai.classify).not.toHaveBeenCalled();
});

it('settles an input load error as a sanitized terminal failure without dispatch or publication', async () => {
  const f = await fixture();
  const previousScore = (await f.record()).score;
  const inputs = { loadResult: vi.fn<ScoreTaskInputStore['loadResult']>().mockRejectedValue(new Error('lock timeout: secret database detail')) };
  const scores = { publishCandidate: vi.fn<ScoreStore['publishCandidate']>() };
  expect(await runStoredScoreTask(f.task.id, { ...f.deps, inputs, scores })).toEqual({ kind: 'failed' });
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'failed', errorCode: 'score_input_failure', attemptCount: 1, startedAt: at, updatedAt: at, endedAt: at });
  expect(JSON.stringify(row.task)).not.toContain('secret database detail');
  expect(row.score).toEqual(previousScore);
  expect(inputs.loadResult).toHaveBeenCalledOnce();
  expect(f.deps.ai.classify).not.toHaveBeenCalled();
  expect(f.deps.ai.generate).not.toHaveBeenCalled();
  expect(f.deps.ai.createRestrictedSession).not.toHaveBeenCalled();
  expect(scores.publishCandidate).not.toHaveBeenCalled();
  expect(await runStoredScoreTask(f.task.id, { ...f.deps, inputs, scores })).toEqual({ kind: 'not_claimed' });
  expect(inputs.loadResult).toHaveBeenCalledOnce();
});

it.each(['resolved', 'rejected'])('returns ownership_lost when ownership changes while models are %s', async outcome => {
  const f = await fixture();
  const previousScore = (await f.record()).score;
  const newOwner = randomUUID();
  const resolveModels = vi.fn(async () => {
    await db.pool.query('update processing_tasks set execution_token=$2 where id=$1', [f.task.id, newOwner]);
    if (outcome === 'rejected') throw new Error('secret configuration detail');
    return models;
  });
  const scores = { publishCandidate: vi.fn<ScoreStore['publishCandidate']>() };
  expect(await runStoredScoreTask(f.task.id, { ...f.deps, models: resolveModels, scores })).toEqual({ kind: 'ownership_lost' });
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'running', executionToken: newOwner, errorCode: null, attemptCount: 1, endedAt: null });
  expect(row.score).toEqual(previousScore);
  expect(resolveModels).toHaveBeenCalledOnce();
  expect(f.deps.ai.classify).not.toHaveBeenCalled(); expect(f.deps.ai.generate).not.toHaveBeenCalled();
  expect(f.deps.ai.createRestrictedSession).not.toHaveBeenCalled(); expect(scores.publishCandidate).not.toHaveBeenCalled();
});

it('does not settle an input load error after ownership changes', async () => {
  const f = await fixture();
  const previousScore = (await f.record()).score;
  const newOwner = randomUUID();
  const inputs = { loadResult: async () => {
    await db.pool.query('update processing_tasks set execution_token=$2 where id=$1', [f.task.id, newOwner]);
    throw new Error('lock timeout: secret database detail');
  } };
  const scores = { publishCandidate: vi.fn<ScoreStore['publishCandidate']>() };
  expect(await runStoredScoreTask(f.task.id, { ...f.deps, inputs, scores })).toEqual({ kind: 'ownership_lost' });
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'running', executionToken: newOwner, errorCode: null, attemptCount: 1, endedAt: null });
  expect(row.score).toEqual(previousScore);
  expect(f.deps.ai.classify).not.toHaveBeenCalled();
  expect(f.deps.ai.generate).not.toHaveBeenCalled();
  expect(f.deps.ai.createRestrictedSession).not.toHaveBeenCalled();
  expect(scores.publishCandidate).not.toHaveBeenCalled();
});

it('sanitizes a failed input-error settlement without assuming the task was updated', async () => {
  const f = await fixture();
  const inputs = { loadResult: vi.fn<ScoreTaskInputStore['loadResult']>().mockRejectedValue(new Error('input database detail')) };
  const updateOwnedTask = vi.fn<TaskStore['updateOwnedTask']>().mockRejectedValue(new Error('settlement database detail'));
  const tasks = { claimTaskForAction: f.deps.tasks.claimTaskForAction.bind(f.deps.tasks), updateOwnedTask };
  const scores = { publishCandidate: vi.fn<ScoreStore['publishCandidate']>() };
  await expect(runStoredScoreTask(f.task.id, { ...f.deps, inputs, tasks, scores })).rejects.toThrow(/^Score task state update failed$/);
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'running', errorCode: null, attemptCount: 1, endedAt: null });
  expect(row.score!.value).toBe(25);
  expect(updateOwnedTask).toHaveBeenCalledOnce();
  expect(f.deps.ai.classify).not.toHaveBeenCalled();
  expect(f.deps.ai.generate).not.toHaveBeenCalled();
  expect(f.deps.ai.createRestrictedSession).not.toHaveBeenCalled();
  expect(scores.publishCandidate).not.toHaveBeenCalled();
});

it('fences lost ownership while loading', async () => {
  const f = await fixture();
  const inputs = { loadResult: async (...args: Parameters<ScoreTaskInputStore['loadResult']>) => {
    await db.pool.query('update processing_tasks set execution_token=$2 where id=$1', [f.task.id, randomUUID()]);
    return f.deps.inputs.loadResult(...args);
  } };
  expect(await runStoredScoreTask(f.task.id, { ...f.deps, inputs })).toEqual({ kind: 'ownership_lost' });
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'running', errorCode: null });
  expect(row.score!.value).toBe(25);
  expect(f.deps.ai.classify).not.toHaveBeenCalled();
});

it('does not settle configuration after ownership changes', async () => {
  const f = await fixture();
  const inputs = { loadResult: async (...args: Parameters<ScoreTaskInputStore['loadResult']>) => {
    const result = await f.deps.inputs.loadResult(...args);
    await db.pool.query('update processing_tasks set execution_token=$2 where id=$1', [f.task.id, randomUUID()]);
    return result;
  } };
  expect(await runStoredScoreTask(f.task.id, { ...f.deps, inputs, models: null })).toEqual({ kind: 'ownership_lost' });
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'running', errorCode: null });
  expect(row.score!.value).toBe(25);
  expect(f.deps.ai.classify).not.toHaveBeenCalled();
});

it.each([['aborted', 'cancelled_before_dispatch'], ['uncertain', 'dispatch_uncertain']] as const)('preserves %s certainty mapping', async (kind, errorCode) => {
  const f = await fixture();
  f.deps.ai.classify.mockRejectedValue(new UsageAttemptError('fixture', kind));
  expect(await runStoredScoreTask(f.task.id, f.deps)).toEqual({ kind: 'failed' });
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'failed', errorCode, endedAt: at });
  expect(row.score!.value).toBe(25);
  expect(f.deps.ai.classify).toHaveBeenCalledOnce();
});

it('rejects basis changes during dispatch without replacing the score', async () => {
  const f = await fixture();
  f.deps.ai.classify.mockImplementation(async () => {
    await db.pool.query('update articles set assignment_revision=assignment_revision+1 where id=$1', [f.article]);
    return { kind: 'completed', value: { answers: { score: { type: 'score', score: 3, confidence: 1, criteria: [] } }, usage: null } };
  });
  expect(await runStoredScoreTask(f.task.id, f.deps)).toEqual({ kind: 'superseded' });
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'superseded', errorCode: 'stale_basis' });
  expect(row.score!.value).toBe(25);
});

it('does not overwrite an ambiguous committed publication', async () => {
  const f = await fixture();
  const scores = { publishCandidate: async (...args: Parameters<ScoreStore['publishCandidate']>) => {
    await f.deps.scores.publishCandidate(...args);
    throw new Error('lost response');
  } };
  await expect(runStoredScoreTask(f.task.id, { ...f.deps, scores })).rejects.toThrow('Score publication failed');
  const row = await f.record();
  expect(row.task).toMatchObject({ state: 'succeeded', errorCode: null });
  expect(row.score!.value).toBe(75);
});
