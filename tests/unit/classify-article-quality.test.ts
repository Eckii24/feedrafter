import { describe, expect, it, vi } from 'vitest';
import { createArticleQualityClassifier } from '../../src/server/application/classify-article-quality.js';
import type { VerifiedModel } from '../../src/server/application/score-context-request.js';
import type { AiPort } from '../../src/server/ports/ai.js';

const verified = (): VerifiedModel => ({ model: { provider: 'fixture', model: 'classifier' }, limits: { contextTokens: 1000, outputTokens: 10, framingTokens: 5 }, countTokens: value => Buffer.byteLength(value) });
const input = { text: 'article text', sourceUrl: 'https://example.com/private' };
const scope = () => new AbortController().signal;

describe('article quality classifier seam', () => {
  it.each([[0.1, false], [0.5, true], [0.8, true]])('sends the measured request with task ownership and maps %s', async (probability, usable) => {
    const count = vi.fn((s: string) => Buffer.byteLength(s));
    const model = { ...verified(), countTokens: count };
    const classify = vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'completed', value: { answers: { usable: { type: 'bool', probability } }, usage: null } });
    const classifier = createArticleQualityClassifier({ classify }, model);
    model.model.model = 'changed';
    const signal = scope();
    expect(await classifier.classify(input, signal, 'task')).toEqual({ usable, probability });
    const [request, receivedScope] = classify.mock.calls[0]!;
    expect(request).toMatchObject({ model: { provider: 'fixture', model: 'classifier' }, role: 'quality', state: { text: input.text } });
    expect(JSON.stringify(request)).not.toContain('private');
    expect(count).toHaveBeenCalledWith(JSON.stringify(request));
    expect(receivedScope).toEqual({ bucket: 'classifier', taskId: 'task', signal });
  });
  it('samples long article text within the unverified request limit and identifies the excerpts', async () => {
    const classify = vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'completed', value: { answers: { usable: { type: 'bool', probability: 0.8 } }, usage: null } });
    const local = { kind: 'unverified' as const, model: verified().model, limits: { contextTokens: 32000, outputTokens: 4096, framingTokens: 1024, maxRequestBytes: 20000 } };
    const text = 'BEGIN ' + 'café 😀 "\\\n'.repeat(12000) + ' END';
    await expect(createArticleQualityClassifier({ classify }, local).classify({ ...input, text }, scope(), 'task')).resolves.toEqual({ usable: true, probability: 0.8, provenance: { coverage: 'sampled', method: 'beginning_middle_end' } });
    const [request] = classify.mock.calls[0]!;
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(20000);
    expect(request.state.text).toEqual(expect.any(String));
    expect(String(request.state.text)).toContain('BEGIN');
    expect(String(request.state.text)).toContain('END');
    expect(request.questions.usable!.instructions).toMatch(/excerpt|sample/i);
    expect(request.state).not.toEqual({ text });
  });
  it('retains the provider result without fabricating confidence from excerpts', async () => {
    const classify = vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'completed', value: { answers: { usable: { type: 'bool', probability: 0.99 } }, usage: null } });
    const local = { kind: 'unverified' as const, model: verified().model, limits: { contextTokens: 32000, outputTokens: 4096, framingTokens: 1024, maxRequestBytes: 20000 } };
    await expect(createArticleQualityClassifier({ classify }, local).classify({ ...input, text: 'Article text '.repeat(10000) }, scope(), 'task')).resolves.toEqual({ usable: true, probability: 0.99, provenance: { coverage: 'sampled', method: 'beginning_middle_end' } });
    expect(classify).toHaveBeenCalledOnce();
  });
  it('does not dispatch samples too small to assess article quality', async () => {
    const classify = vi.fn<AiPort['classify']>();
    const local = { kind: 'unverified' as const, model: verified().model, limits: { contextTokens: 2000, outputTokens: 10, framingTokens: 5, maxRequestBytes: 700 } };
    await expect(createArticleQualityClassifier({ classify }, local).classify({ ...input, text: 'article '.repeat(1000) }, scope(), 'task')).rejects.toThrow('exceeds');
    expect(classify).not.toHaveBeenCalled();
  });
  it('respects the context reserve when it is stricter than the byte cap', async () => {
    const classify = vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'completed', value: { answers: { usable: { type: 'bool', probability: 0.8 } }, usage: null } });
    const local = { kind: 'unverified' as const, model: verified().model, limits: { contextTokens: 3000, outputTokens: 500, framingTokens: 500, maxRequestBytes: 20000 } };
    await createArticleQualityClassifier({ classify }, local).classify({ ...input, text: 'A"😀\\\n'.repeat(5000) }, scope(), 'task');
    expect(Buffer.byteLength(JSON.stringify(classify.mock.calls[0]![0]))).toBeLessThanOrEqual(2000);
  });
  it('propagates sampled provider failures without manufacturing a result', async () => {
    const failure = new Error('provider failure');
    const classify = vi.fn<AiPort['classify']>().mockRejectedValue(failure);
    const local = { kind: 'unverified' as const, model: verified().model, limits: { contextTokens: 32000, outputTokens: 4096, framingTokens: 1024, maxRequestBytes: 20000 } };
    await expect(createArticleQualityClassifier({ classify }, local).classify({ ...input, text: 'article '.repeat(10000) }, scope(), 'task')).rejects.toBe(failure);
    expect(classify).toHaveBeenCalledOnce();
  });
  it('bounds the exact local quality request by UTF-8 bytes before dispatch', async () => {
    const classify = vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'completed', value: { answers: { usable: { type: 'bool', probability: 1 } }, usage: null } });
    const local = { kind: 'unverified' as const, model: verified().model, limits: { contextTokens: 2000, outputTokens: 10, framingTokens: 5, maxRequestBytes: 1000 } };
    const content = { ...input, text: 'café 😀' };
    await createArticleQualityClassifier({ classify }, local).classify(content, scope(), 'task');
    const size = Buffer.byteLength(JSON.stringify(classify.mock.calls[0]![0]));
    classify.mockClear();
    await createArticleQualityClassifier({ classify }, { ...local, limits: { ...local.limits, maxRequestBytes: size, contextTokens: size + 15 } }).classify(content, scope(), 'task');
    expect(classify).toHaveBeenCalledOnce();
    classify.mockClear();
    await expect(createArticleQualityClassifier({ classify }, { ...local, limits: { ...local.limits, maxRequestBytes: size - 1 } }).classify(content, scope(), 'task')).rejects.toThrow('exceeds');
    expect(classify).not.toHaveBeenCalled();
  });
  it('rejects oversized requests, cancellation and invalid identity before dispatch', async () => {
    const classify = vi.fn<AiPort['classify']>();
    const classifier = createArticleQualityClassifier({ classify }, { ...verified(), countTokens: () => 1000 });
    await expect(classifier.classify(input, scope(), 'task')).rejects.toThrow('exceeds');
    await expect(classifier.classify(input, scope(), '')).rejects.toThrow();
    const aborted = new AbortController(); aborted.abort();
    await expect(classifier.classify(input, aborted.signal, 'task')).rejects.toThrow();
    expect(classify).not.toHaveBeenCalled();
  });
  it('preserves pre-dispatch budget denial as a typed pause', async () => {
    const classify = vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'paused_budget', reason: 'daily_limit' });
    await expect(createArticleQualityClassifier({ classify }, verified()).classify(input, scope(), 'task'))
      .rejects.toMatchObject({ name: 'QualityClassifierPause', kind: 'paused_budget', reason: 'daily_limit' });
  });
  it.each([
    { kind: 'paused_auth' }, { kind: 'paused_configuration' }, { kind: 'paused_budget', reason: 'daily_limit' },
    { kind: 'completed', value: { answers: { usable: { type: 'bool', probability: 2 } }, usage: null } },
    { kind: 'completed', value: { answers: { usable: { type: 'bool', probability: 0.8 }, extra: {} }, usage: null } },
  ])('fails closed on unavailable or invalid result %#', async outcome => {
    const classify = vi.fn<AiPort['classify']>().mockResolvedValue(outcome as never);
    await expect(createArticleQualityClassifier({ classify }, verified()).classify(input, scope(), 'task')).rejects.toThrow();
  });
});
