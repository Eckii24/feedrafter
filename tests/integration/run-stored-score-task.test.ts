import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { linkedScoreFixture } from '../helpers/linked-score-fixture.js';
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

it('consumer-only real receipts traverse the stored executor and publish', async () => {
  const f = await linkedScoreFixture(db, context, score, at);
  const seen = vi.fn(async (...args: Parameters<ScoreStore['publishCandidate']>) => new ScoreStore(db.db).publishCandidate(...args));
  const classify = vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'completed', value: { answers: { score: { type: 'score', score: 1.5, confidence: 1, criteria: [] } }, usage: null } });
  // Historical handoff epoch is not the dispatch epoch.
  await db.pool.query('update catalog_epoch set revision=revision+1 where id=1');
  expect(await runStoredScoreTask(f.score.id, { ai: { classify, generate: vi.fn(), createRestrictedSession: vi.fn() }, inputs: new ScoreTaskInputStore(db.pool), scores: { publishCandidate: seen }, tasks: f.tasks, models, signal: new AbortController().signal, now: () => at })).toEqual({ kind: 'published' });
  expect(seen).toHaveBeenCalledOnce();
  expect(seen.mock.calls[0]![0].basis.handoff).toMatchObject({ root: f.root, tags: f.tags, consumer: f.consumer, receipt: f.tagReceipt });
  expect(await new ScoreStore(db.db).get(f.article, score)).toMatchObject({ value: 37.5 });
  expect(classify.mock.calls[0]![0].state).toEqual({ title: 'Linked title', content: 'Linked body' });
});

it('consumer-only dispatch uses current eligible score configuration after receipt creation', async () => {
  const target = (await db.pool.query("insert into score_definitions(name,description,prompt) values ($1,'','old') returning id", [randomUUID()])).rows[0].id as string;
  const f = await linkedScoreFixture(db, context, target, at);
  await db.pool.query("update score_definitions set prompt='new prompt',include_title=true,include_content=false,include_category=false,include_tag_weights=false,include_source_weight=false where id=$1", [target]);
  await db.pool.query('update catalog_epoch set revision=revision+1 where id=1');
  const classify = vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'completed', value: { answers: { score: { type: 'score', score: 0, confidence: 1, criteria: [] } }, usage: null } });
  expect(await runStoredScoreTask(f.score.id, { ai: { classify, generate: vi.fn(), createRestrictedSession: vi.fn() }, inputs: new ScoreTaskInputStore(db.pool), scores: new ScoreStore(db.db), tasks: f.tasks, models, signal: new AbortController().signal, now: () => at })).toEqual({ kind: 'published' });
  expect(classify.mock.calls[0]![0]).toMatchObject({ state: { title: 'Linked title' }, questions: { score: { instructions: 'new prompt' } } });
  expect(await new ScoreStore(db.db).get(f.article, target)).toMatchObject({ value: 0 });
});

const linkedTampering = ['missing score chain', 'null score chain', 'zero score reference', 'unactivated score', 'wrong activated basis', 'wrong score reference', 'wrong score prepare', 'rewired score', 'missing tags receipt', 'malformed tags receipt', 'wrong tags receipt generation', 'wrong tags receipt article', 'wrong actual tag generation', 'missing tag chain', 'zero tag reference', 'rewired tag', 'missing root', 'old root', 'zero target count', 'wrong anchor', 'wrong root', 'missing category receipt', 'wrong category receipt generation', 'wrong actual category generation', 'missing preparation receipt', 'wrong preparation generation', 'wrong preparation article', 'title', 'source', 'category', 'content revision', 'assignment revision', 'newer tags', 'newer category', 'newer prepare'] as const;
it.each(linkedTampering.flatMap(change => ([['before', change], ['during', change]] as const)))('consumer-only rejects %s inference tampering: %s', async (when, change) => {
  const f = await linkedScoreFixture(db, context, score, at);
  const scores = new ScoreStore(db.db);
  expect(await scores.saveSuccessful({ articleId: f.article, scoreId: score, value: 25, calculatedAt: at, contentRevision: 1, assignmentRevision: 0 })).toBe(true);
  const before = await scores.get(f.article, score);
  const tamper = async () => {
    switch (change) {
      case 'missing score chain': await db.pool.query("update processing_tasks set result=result-'articleChain' where id=$1", [f.score.id]); break;
      case 'null score chain': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain}','null') where id=$1", [f.score.id]); break;
      case 'zero score reference': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredHandoff,generation}','0') where id=$1", [f.score.id]); break;
      case 'unactivated score': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredBasis}','null') where id=$1", [f.score.id]); break;
      case 'wrong activated basis': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredBasis,assignmentRevision}','100') where id=$1", [f.score.id]); break;
      case 'wrong score reference': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredHandoff,taskId}',to_jsonb($2::text)) where id=$1", [f.score.id, randomUUID()]); break;
      case 'wrong score prepare': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,prepareTaskId}',to_jsonb($2::text)) where id=$1", [f.score.id, randomUUID()]); break;
      case 'rewired score': await db.pool.query('update processing_tasks set prerequisite_id=$2 where id=$1', [f.score.id, f.category.id]); break;
      case 'missing tags receipt': await db.pool.query("update processing_tasks set result=result-'handoffReceipt' where id=$1", [f.tag.id]); break;
      case 'malformed tags receipt': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{handoffReceipt}','null') where id=$1", [f.tag.id]); break;
      case 'wrong tags receipt generation': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{handoffReceipt,generation}','0') where id=$1", [f.tag.id]); break;
      case 'wrong tags receipt article': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{handoffReceipt,articleId}',to_jsonb($2::text)) where id=$1", [f.tag.id, randomUUID()]); break;
      case 'wrong actual tag generation': await db.pool.query('update processing_tasks set generation=2 where id=$1', [f.tag.id]); break;
      case 'missing tag chain': await db.pool.query("update processing_tasks set result=result-'articleChain' where id=$1", [f.tag.id]); break;
      case 'zero tag reference': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,requiredHandoff,generation}','0') where id=$1", [f.tag.id]); break;
      case 'rewired tag': await db.pool.query('update processing_tasks set prerequisite_id=$2 where id=$1', [f.tag.id, f.prepare.id]); break;
      case 'missing root': await db.pool.query("update processing_tasks set result=result-'articleChain' where id=$1", [f.category.id]); break;
      case 'old root': await db.pool.query("update processing_tasks set result=result #- '{articleChain,tagsTaskId}' where id=$1", [f.category.id]); break;
      case 'zero target count': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,targetCount}','0') where id=$1", [f.category.id]); break;
      case 'wrong anchor': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,tagsTaskId}',to_jsonb($2::text)) where id=$1", [f.category.id, randomUUID()]); break;
      case 'wrong root': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{articleChain,rootTaskId}',to_jsonb($2::text)) where id=$1", [f.score.id, randomUUID()]); break;
      case 'missing category receipt': await db.pool.query("update processing_tasks set result=result-'handoffReceipt' where id=$1", [f.category.id]); break;
      case 'wrong category receipt generation': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{handoffReceipt,generation}','0') where id=$1", [f.category.id]); break;
      case 'wrong actual category generation': await db.pool.query('update processing_tasks set generation=2 where id=$1', [f.category.id]); break;
      case 'missing preparation receipt': await db.pool.query("update processing_tasks set result=result-'preparationReceipt' where id=$1", [f.prepare.id]); break;
      case 'wrong preparation generation': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{preparationReceipt,generation}','2') where id=$1", [f.prepare.id]); break;
      case 'wrong preparation article': await db.pool.query("update processing_tasks set result=jsonb_set(result,'{preparationReceipt,articleId}',to_jsonb($2::text)) where id=$1", [f.prepare.id, randomUUID()]); break;
      case 'title': await db.pool.query("update articles set title='Changed' where id=$1", [f.article]); break;
      case 'source': { const id = (await db.pool.query('insert into sources(context_id,external_feed_id) values ($1,$2) returning id', [context, randomUUID()])).rows[0].id; await db.pool.query('update articles set source_id=$2 where id=$1', [f.article, id]); break; }
      case 'category': await db.pool.query("update articles set category_id='00000000-0000-4000-8000-000000000003' where id=$1", [f.article]); break;
      case 'content revision': await db.pool.query('update articles set content_revision=content_revision+1 where id=$1', [f.article]); break;
      case 'assignment revision': await db.pool.query('update articles set assignment_revision=assignment_revision+1 where id=$1', [f.article]); break;
      case 'newer tags': case 'newer category': case 'newer prepare': await f.tasks.createTask({ articleId: f.article, action: change.slice(6), generation: 2, state: 'failed', createdAt: at, updatedAt: at }); break;
    }
  };
  if (when === 'before') await tamper();
  const classify = vi.fn<AiPort['classify']>().mockImplementation(async () => { if (when === 'during') await tamper(); return { kind: 'completed', value: { answers: { score: { type: 'score', score: 4, confidence: 1, criteria: [] } }, usage: null } }; });
  const result = await runStoredScoreTask(f.score.id, { ai: { classify, generate: vi.fn(), createRestrictedSession: vi.fn() }, inputs: new ScoreTaskInputStore(db.pool), scores, tasks: f.tasks, models, signal: new AbortController().signal, now: () => at });
  const stale = ['title', 'source', 'category', 'content revision', 'assignment revision', 'newer tags', 'newer category', 'newer prepare'].includes(change);
  const expectedState = when === 'during' || stale ? 'superseded' : 'needs_input';
  const expectedError = expectedState === 'superseded' ? 'stale_basis' : 'invalid_handoff';
  expect(result).toEqual({ kind: expectedState });
  expect(await f.tasks.getTask(f.score.id)).toMatchObject({ state: expectedState, errorCode: expectedError });
  expect(classify).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
  expect(await scores.get(f.article, score)).toEqual(before);
});

it.each(['content text', 'category receipt epoch', 'preparation receipt', 'both score linkage fields'])('consumer-only rejects %s changed in flight', async change => {
  const f = await linkedScoreFixture(db, context, score, at);
  const scores = new ScoreStore(db.db);
  const classify = vi.fn<AiPort['classify']>().mockImplementation(async () => {
    if (change === 'content text') await db.pool.query("update article_contents set text='changed' where article_id=$1", [f.article]);
    if (change === 'category receipt epoch') await db.pool.query("update processing_tasks set result=jsonb_set(result,'{handoffReceipt,catalogEpoch}',to_jsonb((result->'handoffReceipt'->>'catalogEpoch')::int+1)) where id=$1", [f.category.id]);
    if (change === 'preparation receipt') await db.pool.query("update processing_tasks set result=result-'preparationReceipt' where id=$1", [f.prepare.id]);
    if (change === 'both score linkage fields') await db.pool.query("update processing_tasks set prerequisite_id=null,result=result-'articleChain' where id=$1", [f.score.id]);
    return { kind: 'completed', value: { answers: { score: { type: 'score', score: 4, confidence: 1, criteria: [] } }, usage: null } };
  });
  expect(await runStoredScoreTask(f.score.id, { ai: { classify, generate: vi.fn(), createRestrictedSession: vi.fn() }, inputs: new ScoreTaskInputStore(db.pool), scores, tasks: f.tasks, models, signal: new AbortController().signal, now: () => at })).toEqual({ kind: 'superseded' });
  expect(await scores.get(f.article, score)).toBeNull();
});

it.each(['null', 'malformed'])('explicit root with %s namespace fails before AI', async value => {
  const f = await fixture();
  await db.pool.query("update processing_tasks set result=jsonb_build_object('articleChain',$2::jsonb) where id=$1", [f.task.id, value === 'null' ? 'null' : '{}']);
  expect(await runStoredScoreTask(f.task.id, f.deps)).toEqual({ kind: 'needs_input' });
  expect((await f.record()).task).toMatchObject({ errorCode: 'invalid_handoff' });
  expect(f.deps.ai.classify).not.toHaveBeenCalled();
});

it('rejects an explicit root whose persisted namespace appears during inference', async () => {
  const f = await fixture();
  f.deps.ai.classify.mockImplementationOnce(async () => {
    await db.pool.query("update processing_tasks set result=jsonb_build_object('articleChain',null) where id=$1", [f.task.id]);
    return { kind: 'completed', value: { answers: { score: { type: 'score', score: 4, confidence: 1, criteria: [] } }, usage: null } };
  });
  expect(await runStoredScoreTask(f.task.id, f.deps)).toEqual({ kind: 'superseded' });
  expect((await f.record()).score).toMatchObject({ value: 25 });
});

it('consumer-only rejects omission of captured link at publication', async () => {
  const f = await linkedScoreFixture(db, context, score, at);
  const scores = new ScoreStore(db.db);
  const classify = vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'completed', value: { answers: { score: { type: 'score', score: 4, confidence: 1, criteria: [] } }, usage: null } });
  const publishCandidate: ScoreStore['publishCandidate'] = (candidate, time) => { const basis = { ...candidate.basis }; delete basis.handoff; return scores.publishCandidate({ ...candidate, basis }, time); };
  expect(await runStoredScoreTask(f.score.id, { ai: { classify, generate: vi.fn(), createRestrictedSession: vi.fn() }, inputs: new ScoreTaskInputStore(db.pool), scores: { publishCandidate }, tasks: f.tasks, models, signal: new AbortController().signal, now: () => at })).toEqual({ kind: 'superseded' });
  expect(await scores.get(f.article, score)).toBeNull();
});

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
