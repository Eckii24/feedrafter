import { describe, expect, it, vi } from 'vitest';
import { runDirectScoreTask } from '../../src/server/application/run-direct-score-task.js';
import type { ScoreContextTask } from '../../src/server/application/process-context-chunks.js';
import { UsageAccountingError, UsageAttemptError, UsageService } from '../../src/server/application/usage.js';
import type { UsageAdmissionPort } from '../../src/server/ports/usage.js';
import type { AiPort } from '../../src/server/ports/ai.js';
import type { TaskStore } from '../../src/server/adapters/postgres/task-store.js';

const at = new Date('2026-03-01Z');
const model = { model: { provider: 'fixture', model: 'test' }, limits: { contextTokens: 2000, outputTokens: 20, framingTokens: 10 }, countTokens: (s: string) => Buffer.byteLength(s) };
const input = (): ScoreContextTask => ({ owner: { taskId: 'task', executionToken: 'token', assignmentRevision: 2, catalogEpoch: 7 }, scoreId: 'score', prompt: 'Score relevance', article: { id: 'article', contentRevision: 1, title: 'title', content: 'private '.repeat(1000), category: '', tagWeights: [], sourceWeight: null }, fields: { includeTitle: true, includeContent: false, includeCategory: false, includeTagWeights: false, includeSourceWeight: false }, generation: 3, classifier: model, generator: model, signal: new AbortController().signal });
function fixture() {
  const classify = vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'completed', value: { answers: { score: { type: 'score', score: 3, confidence: 1, criteria: [] } }, usage: null } });
  const ai = { classify, generate: vi.fn<AiPort['generate']>(), createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() };
  const scores = { publishCandidate: vi.fn().mockResolvedValue(true) };
  let owner = 'token';
  let state = 'running';
  const updateOwnedTask = vi.fn<TaskStore['updateOwnedTask']>().mockImplementation(async (id, token, update) => {
    if (id !== 'task' || token !== owner || state !== 'running') return null;
    state = update.state!;
    return { id, state } as Awaited<ReturnType<TaskStore['updateOwnedTask']>>;
  });
  const tasks = { updateOwnedTask };
  return { ai, scores, tasks, now: () => at, loseOwner: () => { owner = 'other'; }, getState: () => state };
}

describe('direct score task runner', () => {
  it('publishes the direct candidate once without a separate task update', async () => {
    const f = fixture();
    expect(await runDirectScoreTask(input(), f)).toEqual({ kind: 'published' });
    expect(f.scores.publishCandidate).toHaveBeenCalledOnce();
    expect(f.scores.publishCandidate).toHaveBeenCalledWith(expect.objectContaining({ value: 75, basis: expect.objectContaining({ taskId: 'task', executionToken: 'token', generation: 3 }) }), at);
    expect(f.tasks.updateOwnedTask).not.toHaveBeenCalled();
    expect(f.ai.classify).toHaveBeenCalledOnce();
    expect(f.ai.generate).not.toHaveBeenCalled();
  });
  it('publishes title-only scoring with empty unselected content and revision zero', async () => {
    const f = fixture(), task = input();
    expect(await runDirectScoreTask({ ...task, article: { ...task.article, content: '', contentRevision: 0 } }, f)).toEqual({ kind: 'published' });
    expect(f.ai.classify).toHaveBeenCalledOnce();
    expect(f.ai.classify.mock.calls[0]![0].state).toEqual({ title: 'title' });
    expect(f.scores.publishCandidate).toHaveBeenCalledOnce();
    expect(f.tasks.updateOwnedTask).not.toHaveBeenCalled();
  });
  it.each([false, true])('fences missing selected content settlement; ownership lost: %s', async lost => {
    const f = fixture(), task = input();
    if (lost) f.loseOwner();
    expect(await runDirectScoreTask({ ...task, article: { ...task.article, content: '' }, fields: { ...task.fields, includeContent: true } }, f)).toEqual({ kind: lost ? 'ownership_lost' : 'needs_input' });
    expect(f.tasks.updateOwnedTask).toHaveBeenCalledOnce();
    expect(f.tasks.updateOwnedTask).toHaveBeenCalledWith('task', 'token', { state: 'needs_input', errorCode: 'missing_selected_content', updatedAt: at, endedAt: null });
    expect(f.getState()).toBe(lost ? 'running' : 'needs_input');
    expect(f.ai.classify).not.toHaveBeenCalled(); expect(f.ai.generate).not.toHaveBeenCalled(); expect(f.scores.publishCandidate).not.toHaveBeenCalled();
  });
  it.each([
    [{ kind: 'paused_budget', reason: 'daily_limit' } as const, 'paused_budget', 'daily_limit'],
    [{ kind: 'paused_budget', reason: 'concurrency_limit' } as const, 'paused_budget', 'concurrency_limit'],
    [{ kind: 'paused_auth' } as const, 'paused_auth', 'auth_required'],
    [{ kind: 'paused_configuration' } as const, 'needs_input', 'configuration_required'],
  ])('settles %o visibly', async (outcome, state, errorCode) => {
    const f = fixture(); f.ai.classify.mockResolvedValue(outcome);
    expect(await runDirectScoreTask(input(), f)).toEqual({ kind: state });
    expect(f.tasks.updateOwnedTask).toHaveBeenCalledWith('task', 'token', { state, errorCode, updatedAt: at, endedAt: null });
    expect(f.scores.publishCandidate).not.toHaveBeenCalled();
  });
  it('stops oversized context without any dispatch', async () => {
    const f = fixture(), task = input();
    expect(await runDirectScoreTask({ ...task, fields: { ...task.fields, includeContent: true } }, f)).toEqual({ kind: 'needs_input' });
    expect(f.tasks.updateOwnedTask).toHaveBeenCalledWith('task', 'token', expect.objectContaining({ errorCode: 'context_too_large' }));
    expect(f.ai.classify).not.toHaveBeenCalled(); expect(f.ai.generate).not.toHaveBeenCalled(); expect(f.ai.createRestrictedSession).not.toHaveBeenCalled();
    expect(f.scores.publishCandidate).not.toHaveBeenCalled();
  });
  it('marks a rejected candidate superseded with the captured fence', async () => {
    const f = fixture(), task = input(); f.scores.publishCandidate.mockResolvedValue(false);
    f.ai.classify.mockImplementation(async () => { (task.owner as { executionToken: string }).executionToken = 'other'; return { kind: 'completed', value: { answers: { score: { type: 'score', score: 3, confidence: 1, criteria: [] } }, usage: null } }; });
    expect(await runDirectScoreTask(task, f)).toEqual({ kind: 'superseded' });
    expect(f.tasks.updateOwnedTask).toHaveBeenCalledWith('task', 'token', { state: 'superseded', errorCode: 'stale_basis', updatedAt: at, endedAt: at });
  });
  it.each(['pause', 'stale'] as const)('does not overwrite a changed owner on %s', async scenario => {
    const f = fixture();
    if (scenario === 'pause') f.ai.classify.mockImplementation(async () => { f.loseOwner(); return { kind: 'paused_auth' }; });
    else f.scores.publishCandidate.mockImplementation(async () => { f.loseOwner(); return false; });
    expect(await runDirectScoreTask(input(), f)).toEqual({ kind: 'ownership_lost' });
    expect(f.getState()).toBe('running');
  });
  it.each([
    ['auth', 'paused_auth', 'auth_required'], ['provider', 'failed', 'provider_failure'],
    ['uncertain', 'failed', 'dispatch_uncertain'], ['aborted', 'failed', 'cancelled_before_dispatch'],
  ] as const)('handles %s attempt without retry', async (kind, state, code) => {
    const f = fixture(); f.ai.classify.mockRejectedValue(new UsageAttemptError('sensitive-reservation', kind));
    expect(await runDirectScoreTask(input(), f)).toEqual({ kind: state });
    expect(f.tasks.updateOwnedTask).toHaveBeenCalledWith('task', 'token', expect.objectContaining({ state, errorCode: code }));
    expect(f.ai.classify).toHaveBeenCalledOnce(); expect(f.scores.publishCandidate).not.toHaveBeenCalled();
  });
  it.each(['already aborted', 'after recovery', 'before reservation', 'denied reservation'] as const)('fences real usage cancellation %s without dispatch or retry', async stage => {
    const f = fixture(), controller = new AbortController();
    const port: UsageAdmissionPort = {
      recover: vi.fn(async () => { if (stage === 'after recovery') controller.abort(); return 0; }),
      withOwner: vi.fn(async (_signal, action) => {
        if (stage === 'before reservation') controller.abort();
        return action({ token: 'owner', signal: new AbortController().signal });
      }),
      reserve: vi.fn<UsageAdmissionPort['reserve']>(async () => { if (stage === 'denied reservation') controller.abort(); return { admitted: false, reason: 'daily_limit' }; }),
      settle: vi.fn<UsageAdmissionPort['settle']>(async () => 'settled'),
    };
    const invoke = vi.fn(async () => { throw new Error('must not invoke'); });
    const usage = new UsageService(port);
    f.ai.classify.mockImplementation((request, scope) => usage.executeAttempt({ ...request.model, role: request.role, bucket: scope.bucket, ...(scope.taskId !== undefined && { taskId: scope.taskId }), ...(scope.turnId !== undefined && { turnId: scope.turnId }) }, scope, invoke));
    if (stage === 'already aborted') controller.abort();
    expect(await runDirectScoreTask({ ...input(), signal: controller.signal }, f)).toEqual({ kind: 'failed' });
    expect(f.tasks.updateOwnedTask).toHaveBeenCalledOnce();
    expect(f.tasks.updateOwnedTask).toHaveBeenCalledWith('task', 'token', { state: 'failed', errorCode: 'cancelled_before_dispatch', updatedAt: at, endedAt: at });
    expect(port.recover).toHaveBeenCalledTimes(stage === 'already aborted' ? 0 : 1);
    expect(port.withOwner).toHaveBeenCalledTimes(stage === 'before reservation' || stage === 'denied reservation' ? 1 : 0);
    expect(port.reserve).toHaveBeenCalledTimes(stage === 'denied reservation' ? 1 : 0);
    expect(port.settle).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
    expect(f.ai.classify).toHaveBeenCalledOnce(); expect(f.ai.generate).not.toHaveBeenCalled(); expect(f.scores.publishCandidate).not.toHaveBeenCalled();
  });
  it.each(['aborted', 'uncertain'] as const)('respects ownership loss for %s attempt errors', async kind => {
    const f = fixture();
    f.ai.classify.mockImplementation(async () => { f.loseOwner(); throw new UsageAttemptError('id', kind); });
    expect(await runDirectScoreTask(input(), f)).toEqual({ kind: 'ownership_lost' });
    expect(f.tasks.updateOwnedTask).toHaveBeenCalledWith('task', 'token', { state: 'failed', errorCode: kind === 'aborted' ? 'cancelled_before_dispatch' : 'dispatch_uncertain', updatedAt: at, endedAt: at });
    expect(f.getState()).toBe('running');
    expect(f.ai.classify).toHaveBeenCalledOnce(); expect(f.scores.publishCandidate).not.toHaveBeenCalled();
  });
  it('does not infer cancellation certainty from an aborted signal', async () => {
    const f = fixture(), controller = new AbortController(), task = { ...input(), signal: controller.signal };
    f.ai.classify.mockImplementation(async () => { controller.abort(); throw new UsageAttemptError('id', 'uncertain'); });
    expect(await runDirectScoreTask(task, f)).toEqual({ kind: 'failed' });
    expect(f.tasks.updateOwnedTask).toHaveBeenCalledWith('task', 'token', expect.objectContaining({ state: 'failed', errorCode: 'dispatch_uncertain' }));
    expect(f.ai.classify).toHaveBeenCalledOnce(); expect(f.scores.publishCandidate).not.toHaveBeenCalled();
  });
  it.each([new Error('private provider input'), Object.assign(new Error('secret'), { name: 'AbortError' }), new DOMException('secret', 'AbortError'), new UsageAccountingError('reservation', null)])('sanitizes unexpected processing failure %s', async error => {
    const f = fixture(); f.ai.classify.mockRejectedValue(error);
    expect(await runDirectScoreTask(input(), f)).toEqual({ kind: 'failed' });
    expect(f.tasks.updateOwnedTask).toHaveBeenCalledWith('task', 'token', expect.objectContaining({ state: 'failed', errorCode: 'score_task_failure' }));
    expect(f.scores.publishCandidate).not.toHaveBeenCalled();
  });
  it('surfaces ambiguous publication and task-store errors without exposing details or writing a second state', async () => {
    const f = fixture(); f.scores.publishCandidate.mockRejectedValue(new Error('private input'));
    await expect(runDirectScoreTask(input(), f)).rejects.toThrow('Score publication failed');
    expect(f.tasks.updateOwnedTask).not.toHaveBeenCalled();
    const g = fixture(); g.ai.classify.mockResolvedValue({ kind: 'paused_auth' }); g.tasks.updateOwnedTask.mockRejectedValue(new Error('private input'));
    await expect(runDirectScoreTask(input(), g)).rejects.toThrow('Score task state update failed');
    expect(g.tasks.updateOwnedTask).toHaveBeenCalledOnce();
  });
});
