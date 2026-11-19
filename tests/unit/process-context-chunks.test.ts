import { describe, expect, it, vi } from 'vitest';
import { processContextChunks, type ScoreContextTask } from '../../src/server/application/process-context-chunks.js';
import { UsageAttemptError } from '../../src/server/application/usage.js';
import type { AiPort, ClassificationRequest } from '../../src/server/ports/ai.js';
import type { ContextStore } from '../../src/server/adapters/postgres/context-store.js';
import type { ScoreHandoff } from '../../src/server/adapters/postgres/score-handoff.js';
import { prepareContext } from '../../src/server/application/prepare-context.js';

const count = (s: string) => Buffer.byteLength(s, 'utf8');
const model = { model: { provider: 'fixture', model: 'test' }, limits: { contextTokens: 2000, outputTokens: 20, framingTokens: 10 }, countTokens: count };
const task = (): ScoreContextTask => ({ owner: { taskId: 'task', executionToken: 'token', assignmentRevision: 2, catalogEpoch: 7 }, scoreId: 'score-1', prompt: 'Score relevance', article: { id: 'article', contentRevision: 1, title: 'Title', content: 'secret content '.repeat(1000), category: 'secret category', tagWeights: [{ tag: 'secret tag', weight: 5 }], sourceWeight: 8 }, fields: { includeTitle: true, includeContent: false, includeCategory: false, includeTagWeights: false, includeSourceWeight: false }, generation: 3, classifier: model, generator: model, signal: new AbortController().signal });
const fake = (score = 1.5) => {
  const classify = vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'completed', value: { answers: { score: { type: 'score', score, confidence: 1, criteria: ['0', '25', '50', '75', '100'] } }, usage: null } });
  const generate = vi.fn<AiPort['generate']>();
  return { classify, generate, createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() };
};

function memoryStore(): Pick<ContextStore, 'save' | 'resume' | 'claimRepair'> {
  let saved: Awaited<ReturnType<ContextStore['resume']>> = null;
  return {
    resume: async () => saved,
    claimRepair: async (_owner, _input, chunkId) => {
      if (!saved || saved.state.completedChunkIds.includes(chunkId) || saved.state.repairStartedChunkIds.includes(chunkId)) return null;
      saved = { ...saved, state: { ...saved.state, repairStartedChunkIds: [...saved.state.repairStartedChunkIds, chunkId] } };
      return saved;
    },
    save: async (_owner, input, progress, _at, completions = []) => {
      const plan = prepareContext(input);
      if (plan.kind !== 'chunks') throw new Error('expected chunks');
      const done = new Set(progress.completedChunkIds);
      saved = { planId: 'test', completions, state: { version: 3, evidenceDigest: '0'.repeat(64), totalChunks: plan.chunks.length, completedChunks: done.size, completedChunkIds: [...done], repairStartedChunkIds: progress.repairStartedChunkIds ?? [], reductionLevels: [], coverage: { length: plan.coverage.length, intervals: plan.chunks.filter(c => done.has(c.id)).map(({ start, end }) => ({ start, end })), missing: plan.chunks.filter(c => !done.has(c.id)).map(({ start, end }) => ({ start, end })), complete: done.size === plan.chunks.length } } };
      return saved;
    },
  };
}

describe('direct score candidate subset', () => {
  it.each([
    ['', 1], [' \n\t ', 1], ['available', 0],
  ])('requires selected content and a positive revision: %j revision %i', async (content, contentRevision) => {
    const base = task(), ai = fake(), countTokens = vi.fn(count);
    const store = { save: vi.fn(), resume: vi.fn(), claimRepair: vi.fn() };
    const input = { ...base, article: { ...base.article, content, contentRevision }, fields: { ...base.fields, includeContent: true }, classifier: { ...model, countTokens } };
    expect(await processContextChunks(input, ai, store)).toEqual({ kind: 'needs_input', reason: 'missing_selected_content' });
    expect(countTokens).not.toHaveBeenCalled();
    expect(ai.classify).not.toHaveBeenCalled(); expect(ai.generate).not.toHaveBeenCalled(); expect(ai.createRestrictedSession).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled(); expect(store.resume).not.toHaveBeenCalled(); expect(store.claimRepair).not.toHaveBeenCalled();
  });
  it.each([{ id: '', contentRevision: 1 }, { id: 'article', contentRevision: -1 }, { id: 'article', contentRevision: 1.5 }])('rejects invalid identity before missing-content preflight: %o', async identity => {
    const base = task(), ai = fake();
    await expect(processContextChunks({ ...base, article: { ...base.article, ...identity, content: '' }, fields: { ...base.fields, includeContent: true } }, ai)).rejects.toThrow('invalid context identity');
    expect(ai.classify).not.toHaveBeenCalled(); expect(ai.generate).not.toHaveBeenCalled();
  });
  it('preserves selected source text and coverage offsets', async () => {
    const base = task(), ai = fake(), content = '  text 😀\n';
    const result = await processContextChunks({ ...base, article: { ...base.article, content }, fields: { ...base.fields, includeContent: true } }, ai);
    expect(result).toMatchObject({ kind: 'completed', value: { coverage: { length: content.length, intervals: [{ start: 0, end: content.length }] } } });
    expect(ai.classify.mock.calls[0]![0].state).toMatchObject({ content });
  });
  it('uses one exact classifier request and only selected fields for a title-only task', async () => {
    const input = task(), ai = fake();
    const result = await processContextChunks(input, ai);
    expect(result).toMatchObject({ kind: 'completed', value: { value: 37.5, basis: { scoreId: 'score-1', catalogEpoch: 7, condensed: false, limited: false }, coverage: { selected: false, length: 0, complete: true } } });
    expect(ai.generate).not.toHaveBeenCalled();
    expect(ai.classify).toHaveBeenCalledOnce();
    const [request, scope] = ai.classify.mock.calls[0]!;
    expect(request).toEqual({ model: model.model, role: 'scores', state: { title: 'Title' }, questions: { score: { type: 'score', instructions: 'Score relevance', criteria: ['0', '25', '50', '75', '100'] } } });
    expect(scope).toEqual({ bucket: 'classifier', taskId: 'task', signal: input.signal });
    expect(JSON.stringify(request)).not.toMatch(/secret|token|score-1/);
  });
  it.each([[0, 0], [1.5, 37.5], [4, 100]])('maps native %s to %s', async (index, value) => {
    expect(await processContextChunks(task(), fake(index))).toMatchObject({ kind: 'completed', value: { value } });
  });
  it.each([-1, 4.01, NaN, Infinity])('rejects invalid native index %s', async index => {
    await expect(processContextChunks(task(), fake(index))).rejects.toThrow(/native score/);
  });
  it('isolates score prompts and selected fields', async () => {
    const first = task(), second = { ...first, scoreId: 'other', prompt: 'Other question', fields: { ...first.fields, includeTitle: false, includeCategory: true } };
    const ai = fake();
    await processContextChunks(first, ai); await processContextChunks(second, ai);
    expect(ai.classify.mock.calls[1]![0]).toMatchObject({ state: { category: 'secret category' }, questions: { score: { instructions: 'Other question' } } });
    expect(JSON.stringify(ai.classify.mock.calls[1]![0])).not.toContain('Score relevance');
  });
  it('refuses oversized classifier state without generation even if generator has more capacity', async () => {
    const input = task(), ai = fake();
    const result = await processContextChunks({ ...input, fields: { ...input.fields, includeContent: true }, generator: { ...model, limits: { ...model.limits, contextTokens: 100000 } } }, ai);
    expect(result).toEqual({ kind: 'unsupported_chunks' });
    expect(ai.classify).not.toHaveBeenCalled(); expect(ai.generate).not.toHaveBeenCalled();
  });
  it('sizes the exact sent shape, including framing and output reserve', async () => {
    const input = task(), ai = fake();
    await processContextChunks(input, ai);
    const request: ClassificationRequest = ai.classify.mock.calls[0]![0];
    const size = count(JSON.stringify(request));
    const limits = { contextTokens: size + 30, outputTokens: 20, framingTokens: 10 };
    const exact = fake();
    await processContextChunks({ ...input, classifier: { ...model, limits } }, exact);
    expect(exact.classify).toHaveBeenCalledOnce();
    const smaller = fake();
    expect(await processContextChunks({ ...input, classifier: { ...model, limits: { ...limits, contextTokens: size + 29 } } }, smaller)).toEqual({ kind: 'unsupported_chunks' });
    expect(smaller.classify).not.toHaveBeenCalled();
  });
  it('uses the same order-sensitive request for preliminary sizing, planning and dispatch', async () => {
    const base = task(), ai = fake();
    const seen: string[] = [];
    const orderSensitive = (serialized: string) => {
      seen.push(serialized);
      return count(serialized) + (serialized.indexOf('"content"') < serialized.indexOf('"category"') ? 1 : 0);
    };
    const input = { ...base, article: { ...base.article, content: 'short content' }, fields: { includeTitle: true, includeContent: true, includeCategory: true, includeTagWeights: true, includeSourceWeight: true }, classifier: { ...model, limits: { ...model.limits, contextTokens: 10000 }, countTokens: orderSensitive } };
    expect(await processContextChunks(input, ai)).toMatchObject({ kind: 'completed' });
    expect(ai.classify).toHaveBeenCalledOnce();
    const request = ai.classify.mock.calls[0]![0];
    const serialized = JSON.stringify(request);
    const planner = prepareContext({ taskKind: 'scores', fields: input.fields, article: input.article, generation: input.generation, prompt: input.prompt, questions: [input.prompt], tools: '', limits: input.classifier.limits, tokenizer: envelope => orderSensitive(JSON.stringify({ ...request, state: JSON.parse(envelope).context })) });
    expect(planner.kind).toBe('direct');
    if (planner.kind !== 'direct') throw new Error('expected direct');
    expect(JSON.stringify({ ...request, state: planner.direct.request.context })).toBe(serialized);
    expect(planner.direct.inputTokens).toBe(orderSensitive(serialized));
    expect(seen[0]).toBe(serialized);
    expect(seen).toContain(serialized);
    const tooSmall = fake();
    const size = orderSensitive(serialized);
    expect(await processContextChunks({ ...input, classifier: { ...input.classifier, limits: { ...input.classifier.limits, contextTokens: size + 29 } } }, tooSmall)).toEqual({ kind: 'unsupported_chunks' });
    expect(tooSmall.classify).not.toHaveBeenCalled();
    expect(tooSmall.generate).not.toHaveBeenCalled();
  });
  it.each([{ kind: 'paused_budget' as const, reason: 'daily_limit' as const }, { kind: 'paused_auth' as const }, { kind: 'paused_configuration' as const }])('preserves $kind', async pause => {
    const ai = fake(); ai.classify.mockResolvedValueOnce(pause);
    expect(await processContextChunks(task(), ai)).toEqual(pause);
  });
  it('maps admitted auth errors without swallowing other attempt errors', async () => {
    const ai = fake(); ai.classify.mockRejectedValueOnce(new UsageAttemptError('id', 'auth'));
    expect(await processContextChunks(task(), ai)).toEqual({ kind: 'paused_auth' });
    ai.classify.mockRejectedValueOnce(new UsageAttemptError('id', 'provider'));
    await expect(processContextChunks(task(), ai)).rejects.toThrow('Usage attempt provider');
  });
  it('keeps the candidate basis stable when caller-owned data changes during classification', async () => {
    const input = task(), ai = fake();
    ai.classify.mockImplementationOnce(async () => {
      (input.owner as { assignmentRevision: number }).assignmentRevision = 99;
      (input.owner as { catalogEpoch: number }).catalogEpoch = 99;
      (input.article as { contentRevision: number }).contentRevision = 99;
      return { kind: 'completed', value: { answers: { score: { type: 'score', score: 4, confidence: 1, criteria: ['0', '25', '50', '75', '100'] } }, usage: null } };
    });
    expect(await processContextChunks(input, ai)).toMatchObject({ kind: 'completed', value: { basis: { assignmentRevision: 2, contentRevision: 1, catalogEpoch: 7 } } });
  });
  it('snapshots nested linked handoff before inference without leaking it into selected fields', async () => {
    const basis = { contentRevision: 1, assignmentRevision: 2, articleInputHash: 'a'.repeat(64) };
    const root = { version: 1 as const, rootTaskId: 'root', prepareTaskId: 'prepare', tagsTaskId: 'tags', requiredHandoff: null, requiredBasis: basis, targetCount: 1 };
    const tags = { version: 1 as const, rootTaskId: 'root', prepareTaskId: 'prepare', requiredHandoff: { taskId: 'root', generation: 1, action: 'category' as const }, requiredBasis: basis };
    const consumer = { version: 1 as const, rootTaskId: 'root', prepareTaskId: 'prepare', requiredHandoff: { taskId: 'tags', generation: 1, action: 'tags' as const }, requiredBasis: basis };
    const receipt = { version: 1 as const, taskId: 'tags', generation: 1, action: 'tags' as const, articleId: 'article', prerequisiteId: 'root', categoryId: 'category', basis, catalogEpoch: 1 };
    const handoff: ScoreHandoff = { root, tags, consumer, receipt, categoryReceipt: { ...receipt, action: 'category', taskId: 'root', prerequisiteId: 'prepare' }, preparationReceipt: { version: 1, action: 'prepare', taskId: 'prepare', articleId: 'article', generation: 1, contentRevision: 1 }, articleInputHash: basis.articleInputHash, contentText: 'secret' };
    const expected = structuredClone(handoff), input = task(), ai = fake(1.5);
    ai.classify.mockImplementationOnce(async () => { basis.assignmentRevision = 99; consumer.requiredHandoff.generation = 9; receipt.catalogEpoch = 99; return { kind: 'completed', value: { answers: { score: { type: 'score', score: 1.5, confidence: 1, criteria: [] } }, usage: null } }; });
    expect(await processContextChunks({ ...input, owner: { ...input.owner, handoff } }, ai)).toMatchObject({ kind: 'completed', value: { value: 37.5, basis: { handoff: expected } } });
    expect(ai.classify.mock.calls[0]![0].state).toEqual({ title: 'Title' });
  });
  it.each([-1, 1.5, NaN, 2147483648])('rejects invalid captured epoch %s before dispatch', async catalogEpoch => {
    const input = task(), ai = fake();
    await expect(processContextChunks({ ...input, owner: { ...input.owner, catalogEpoch } }, ai)).rejects.toThrow('invalid score task');
    expect(ai.classify).not.toHaveBeenCalled();
  });
  it('rejects unknown model limits before dispatch', async () => {
    const input = task(), ai = fake();
    await expect(processContextChunks({ ...input, classifier: { ...model, limits: { ...model.limits, contextTokens: 0 } } }, ai)).rejects.toThrow(/limits/);
    expect(ai.classify).not.toHaveBeenCalled();
  });
});

describe('oversized score evidence', () => {
  const oversized = () => ({ ...task(), article: { ...task().article, content: '😀alpha '.repeat(180) }, fields: { ...task().fields, includeContent: true }, classifier: { ...model, limits: { contextTokens: 600, outputTokens: 20, framingTokens: 10 } }, generator: { ...model, limits: { contextTokens: 750, outputTokens: 20, framingTokens: 10 } } });
  it('routes an order-sensitive oversized classifier request to chunk evidence', async () => {
    const base = oversized(), ai = fake();
    const orderSensitive = (serialized: string) => count(serialized) + (serialized.indexOf('"content"') < serialized.indexOf('"category"') ? 1 : 0);
    const input = { ...base, fields: { includeTitle: true, includeContent: true, includeCategory: true, includeTagWeights: true, includeSourceWeight: true }, classifier: { ...base.classifier, countTokens: orderSensitive } };
    ai.generate.mockResolvedValue({ kind: 'completed', value: { text: '{"items":[]}', usage: null } });
    const result = await processContextChunks(input, ai, memoryStore());
    expect(result).toMatchObject({ kind: 'evidence_ready', progress: { coverage: { complete: true } } });
    expect(ai.classify).not.toHaveBeenCalled();
    expect(ai.generate.mock.calls.length).toBeGreaterThan(1);
  });
  it('sends exact selected context and maps source quotes to UTF-16 offsets', async () => {
    const input = oversized(), ai = fake();
    ai.generate.mockResolvedValue({ kind: 'completed', value: { text: JSON.stringify({ items: [{ questionIndex: 0, polarity: 'counter', text: 'point', quotes: ['😀alpha'] }] }), usage: null } });
    const result = await processContextChunks(input, ai, memoryStore());
    expect(result.kind).toBe('evidence_ready');
    if (result.kind !== 'evidence_ready') throw new Error('expected evidence');
    expect(result.progress.coverage.complete).toBe(true);
    expect(result.completions.length).toBeGreaterThan(1);
    for (const item of result.completions) for (const ref of item.evidence[0]!.refs) expect(input.article.content.slice(ref.start, ref.end)).toBe(ref.quote);
    for (const [request, scope] of ai.generate.mock.calls) {
      expect(request).toMatchObject({ model: input.generator.model, role: 'context_reduction' });
      const body = JSON.parse(request.user);
      expect(body.question).toBe(input.prompt);
      expect(Object.keys(body.context).sort()).toEqual(['content', 'title']);
      expect(JSON.stringify(request)).not.toMatch(/secret category|secret tag|sourceWeight|token/);
      expect(count(JSON.stringify(request)) + 30).toBeLessThanOrEqual(750);
      expect(scope).toEqual({ bucket: 'automatic', taskId: input.owner.taskId, signal: input.signal });
    }
    expect(ai.classify).not.toHaveBeenCalled();
  });
  it.each(['not json', '{"items":[],"coverage":true}', '{"items":[{"questionIndex":0,"polarity":"support","text":"x","quotes":["absent"]}]}', '{"items":[{"questionIndex":1,"polarity":"support","text":"x","quotes":["alpha"]}]}'])('rejects invalid repair output after one separately admitted call: %s', async text => {
    const ai = fake(), store = memoryStore(); ai.generate.mockResolvedValue({ kind: 'completed', value: { text, usage: null } });
    await expect(processContextChunks(oversized(), ai, store)).rejects.toThrow(/evidence/);
    expect(ai.generate).toHaveBeenCalledTimes(2);
    await expect(processContextChunks(oversized(), ai, store)).rejects.toThrow(/repair opportunity/);
    expect(ai.generate).toHaveBeenCalledTimes(2);
  });
  it.each(['\ud800', '\udfff'] as const)('repairs lone surrogate evidence text and refuses a second malformed response', async bad => {
    const ai = fake(), store = memoryStore();
    ai.generate.mockResolvedValue({ kind: 'completed', value: { text: JSON.stringify({ items: [{ questionIndex: 0, polarity: 'support', text: `bad${bad}`, quotes: ['alpha'] }] }), usage: null } });
    await expect(processContextChunks(oversized(), ai, store)).rejects.toThrow('invalid evidence item');
    expect(ai.generate).toHaveBeenCalledTimes(2);
    expect(ai.generate.mock.calls[1]![0].system).toContain('Repair evidence');
    await expect(processContextChunks(oversized(), ai, store)).rejects.toThrow(/repair opportunity/);
    expect(ai.generate).toHaveBeenCalledTimes(2);
  });
  it.each(['\ud800', '\udfff'] as const)('rejects a lone surrogate quote even when it occurs in the source', async bad => {
    const input = oversized(), ai = fake();
    input.article.content = (`alpha${bad} `).repeat(180);
    ai.generate.mockResolvedValue({ kind: 'completed', value: { text: JSON.stringify({ items: [{ questionIndex: 0, polarity: 'support', text: 'evidence', quotes: [bad] }] }), usage: null } });
    await expect(processContextChunks(input, ai, memoryStore())).rejects.toThrow('invalid evidence quote');
    expect(ai.generate).toHaveBeenCalledTimes(2);
  });
  it('repairs invalid evidence with a distinct bounded regular request', async () => {
    const input = oversized(), ai = fake();
    ai.generate.mockResolvedValueOnce({ kind: 'completed', value: { text: 'invalid', usage: null } }).mockResolvedValue({ kind: 'completed', value: { text: '{"items":[]}', usage: null } });
    const result = await processContextChunks(input, ai, memoryStore());
    expect(result).toMatchObject({ kind: 'evidence_ready', progress: { repairStartedChunkIds: [expect.any(String)] } });
    const [original, repair] = ai.generate.mock.calls;
    expect(repair![0]).not.toEqual(original![0]);
    expect(repair![1]).toEqual(original![1]);
    expect(count(JSON.stringify(repair![0])) + 30).toBeLessThanOrEqual(input.generator.limits.contextTokens);
  });
  it.each([{ kind: 'paused_budget' as const, reason: 'daily_limit' as const }, { kind: 'paused_auth' as const }, { kind: 'paused_configuration' as const }])('consumes repair on non-admission $kind', async pause => {
    const ai = fake(), store = memoryStore();
    ai.generate.mockResolvedValueOnce({ kind: 'completed', value: { text: 'invalid', usage: null } }).mockResolvedValueOnce(pause);
    expect(await processContextChunks(oversized(), ai, store)).toMatchObject({ ...pause, progress: { repairStartedChunkIds: [expect.any(String)] } });
    await expect(processContextChunks(oversized(), ai, store)).rejects.toThrow(/repair opportunity/);
    expect(ai.generate).toHaveBeenCalledTimes(2);
  });
  it('keeps the repair consumed after an admitted auth failure', async () => {
    const ai = fake(), store = memoryStore();
    ai.generate.mockResolvedValueOnce({ kind: 'completed', value: { text: 'invalid', usage: null } }).mockRejectedValueOnce(new UsageAttemptError('id', 'auth'));
    await expect(processContextChunks(oversized(), ai, store)).rejects.toMatchObject({ name: 'UsageAttemptError', kind: 'auth', reservationId: 'id' });
    await expect(processContextChunks(oversized(), ai, store)).rejects.toThrow(/repair opportunity/);
    expect(ai.generate).toHaveBeenCalledTimes(2);
  });
  it('isolates different score prompts and persists a single evidence chunk when the generator fits everything', async () => {
    const input = oversized(), ai = fake();
    const larger = { ...input, generator: { ...input.generator, limits: { ...input.generator.limits, contextTokens: 10000 } } };
    ai.generate.mockResolvedValue({ kind: 'completed', value: { text: '{"items":[]}', usage: null } });
    const first = await processContextChunks(larger, ai, memoryStore());
    const second = await processContextChunks({ ...larger, scoreId: 'other-score', prompt: 'Different score question' }, ai, memoryStore());
    await processContextChunks(larger, ai, memoryStore());
    expect(first).toMatchObject({ kind: 'evidence_ready', progress: { totalChunks: 1, completedChunks: 1 } });
    expect(second).toMatchObject({ kind: 'evidence_ready', progress: { totalChunks: 1 } });
    expect(ai.generate.mock.calls[0]![0].user).toContain('Score relevance');
    expect(ai.generate.mock.calls[1]![0].user).toContain('Different score question');
    expect(ai.generate.mock.calls[1]![0].user).not.toContain('Score relevance');
    expect(ai.generate.mock.calls[0]![0]).toEqual(ai.generate.mock.calls[2]![0]);
  });
  it('reports partial progress on pause and propagates provider failure', async () => {
    const ai = fake(), input = oversized();
    ai.generate.mockResolvedValueOnce({ kind: 'completed', value: { text: '{"items":[]}', usage: null } }).mockResolvedValueOnce({ kind: 'paused_budget', reason: 'daily_limit' });
    expect(await processContextChunks(input, ai, memoryStore())).toMatchObject({ kind: 'paused_budget', progress: { completedChunks: 1, coverage: { complete: false } } });
    const failure = fake(); failure.generate.mockRejectedValueOnce(new UsageAttemptError('id', 'provider'));
    await expect(processContextChunks(input, failure, memoryStore())).rejects.toThrow('Usage attempt provider');
    expect(failure.generate).toHaveBeenCalledOnce();
  });
  it('does not dispatch with unknown generation limits', async () => {
    const input = oversized(), ai = fake();
    await expect(processContextChunks({ ...input, generator: { ...input.generator, limits: { ...input.generator.limits, contextTokens: 0 } } }, ai, memoryStore())).rejects.toThrow(/limits/);
    expect(ai.generate).not.toHaveBeenCalled();
  });
});
