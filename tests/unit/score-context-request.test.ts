import { describe, expect, it } from 'vitest';
import { measureRequest, measureVerifiedRequest, renderFinalEvidenceState, renderScoreRequest, requestPlannerLimits, validateRequestModel, validateVerifiedModel } from '../../src/server/application/score-context-request.js';

describe('score request renderer', () => {
  it('preserves the exact classifier envelope and selected state order', () => {
    const request = renderScoreRequest({ provider: 'fixture', model: 'model' }, 'Question "\\\n😀', { title: 'café', content: 'Text', category: 'Cat' });
    expect(JSON.stringify(request)).toBe(JSON.stringify({ model: { provider: 'fixture', model: 'model' }, role: 'scores', state: { title: 'café', content: 'Text', category: 'Cat' }, questions: { score: { type: 'score', instructions: 'Question "\\\n😀', criteria: ['0', '25', '50', '75', '100'] } } }));
  });

  it('renders selected non-content fields then ordered host evidence with exact JSON escaping', () => {
    const article = { id: 'a', contentRevision: 1, title: 'café 😀', content: 'secret', category: 'cat', tagWeights: [{ tag: 'x', weight: 1 }], sourceWeight: 4 };
    const fields = { includeTitle: true, includeContent: true, includeCategory: false, includeTagWeights: true, includeSourceWeight: false };
    const state = renderFinalEvidenceState(article, fields, [{ id: 'id', questionId: '0', polarity: 'counter', text: '"\\\n😀', refs: [{ chunkId: 'chunk', start: 0, end: 2, quote: '😀' }] }]);
    expect(JSON.stringify(state)).toBe(JSON.stringify({ title: 'café 😀', tagWeights: [{ tag: 'x', weight: 1 }], evidence: [{ id: 'id', questionId: '0', polarity: 'counter', text: '"\\\n😀', refs: [{ chunkId: 'chunk', start: 0, end: 2, quote: '😀' }] }] }));
    expect(JSON.stringify(state)).not.toContain('secret');
  });

  it('counts the exact ordered request and applies both bounds', () => {
    const request = renderScoreRequest({ provider: 'fixture', model: 'model' }, 'Q', { title: '😀\n"\\' });
    const serialized = JSON.stringify(request);
    const seen: string[] = [];
    const countTokens = (value: string) => { seen.push(value); return Buffer.byteLength(value); };
    const size = Buffer.byteLength(serialized);
    const model = { model: request.model, limits: { contextTokens: size + 3, outputTokens: 2, framingTokens: 1, maxInputTokens: size + 1 }, countTokens };
    expect(measureVerifiedRequest(model, request)).toEqual({ serialized, inputTokens: size, fits: true });
    expect(seen).toEqual([serialized]);
    expect(measureVerifiedRequest({ ...model, limits: { ...model.limits, contextTokens: size + 2 } }, request).fits).toBe(false);
    expect(measureVerifiedRequest({ ...model, limits: { ...model.limits, maxInputTokens: size } }, request).fits).toBe(false);
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid or overflowing count %s', count => {
    const model = { model: { provider: 'p', model: 'm' }, limits: { contextTokens: 100, outputTokens: 1, framingTokens: 1 }, countTokens: () => count };
    expect(() => measureVerifiedRequest(model, {})).toThrow(/size/);
  });

  it('uses exact UTF-8 request bytes and independently reserves context, framing and output', () => {
    const request = { text: '😀"\n' };
    const size = Buffer.byteLength(JSON.stringify(request));
    const model = { kind: 'unverified' as const, model: { provider: 'local', model: 'm' }, limits: { contextTokens: size + 7, outputTokens: 4, framingTokens: 3, maxRequestBytes: size } };
    expect(measureRequest(model, request)).toEqual({ serialized: JSON.stringify(request), inputTokens: size, fits: true });
    expect(requestPlannerLimits(model).maxInputTokens).toBe(size + 3);
    expect(measureRequest({ ...model, limits: { ...model.limits, maxRequestBytes: size - 1 } }, request).fits).toBe(false);
    expect(measureRequest({ ...model, limits: { ...model.limits, contextTokens: size + 6 } }, request).fits).toBe(false);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid local byte bound %s', maxRequestBytes => {
    const model = { kind: 'unverified' as const, model: { provider: 'local', model: 'm' }, limits: { contextTokens: 100, outputTokens: 5, framingTokens: 1, maxRequestBytes } };
    expect(() => validateRequestModel(model)).toThrow(/limits/);
  });

  it('rejects invalid verified limits', () => {
    const model = { model: { provider: 'p', model: 'm' }, limits: { contextTokens: 100, outputTokens: 0, framingTokens: 1 }, countTokens: () => 0 };
    expect(() => validateVerifiedModel(model)).toThrow(/limits/);
  });
});
