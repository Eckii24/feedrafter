import { expect, it, vi } from 'vitest';
import { categorize } from '../../src/server/application/categorize.js';
import { assignTags } from '../../src/server/application/assign-tags.js';
import type { AiPort } from '../../src/server/ports/ai.js';

const model = { kind: 'unverified' as const, model: { provider: 'local', model: 'm' }, limits: { contextTokens: 32000, outputTokens: 4096, framingTokens: 1024, maxRequestBytes: 20000 } };
const content = 'BEGINNING ' + '😀é"\\\n'.repeat(10000) + ' MIDDLE ' + '漢字'.repeat(10000) + ' ENDING';

it.each(['category', 'tags'] as const)('dispatches bounded labelled Unicode excerpts for long %s content', async role => {
  expect(Buffer.byteLength(content)).toBeGreaterThan(20000);
  const ai = { classify: vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'paused_auth' }), generate: vi.fn<AiPort['generate']>().mockResolvedValue({ kind: 'paused_auth' }), createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() };
  const tasks = { updateOwnedTask: vi.fn().mockResolvedValue({}) };
  const common = { ai, tasks, model, signal: new AbortController().signal };
  const basis = { taskId: 'task', executionToken: 'token', articleId: 'a', generation: 1, prerequisiteId: null, contentRevision: 1, contentText: content, assignmentRevision: 1, catalogEpoch: 1 };
  const result = role === 'category'
    ? await categorize('task', 'token', { ...common, inputs: { loadResult: async () => ({ kind: 'loaded', input: { basis, title: 'title', content, categories: [{ id: 'one', label: 'One' }], classifier: model, signal: common.signal } }) }, catalog: { publishCategoryCandidate: vi.fn() } })
    : await assignTags('task', 'token', { ...common, inputs: { loadResult: async () => ({ kind: 'loaded', input: { basis, title: 'title', category: 'One', content, generator: model } }) } as unknown as Parameters<typeof assignTags>[2]['inputs'], catalog: { publishTagCandidate: vi.fn(), tagKeysFit: vi.fn() } });
  expect(result).toEqual({ kind: 'paused_auth' });
  const call = role === 'category' ? ai.classify.mock.calls[0] : ai.generate.mock.calls[0];
  expect(call).toBeDefined();
  const request = call![0];
  const serialized = JSON.stringify(request);
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(20000);
  expect(serialized).toContain('BEGINNING');
  expect(serialized).toContain('ENDING');
  expect(serialized).toMatch(/excerpt/i);
  expect(serialized).toMatch(/omitted/i);
  expect(serialized).not.toContain('\ufffd');
});

it.each(['category', 'tags'] as const)('retains the full revision basis when publishing sampled %s', async role => {
  const basis = { taskId: 'task', executionToken: 'token', articleId: 'a', generation: 1, prerequisiteId: null, contentRevision: 9, contentText: content, assignmentRevision: 2, catalogEpoch: 3 };
  const classify = vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'completed', value: { answers: { category: { type: 'choice', choice: 'one', confidence: 1, probabilities: { one: 1 } } }, usage: null } });
  const generate = vi.fn<AiPort['generate']>().mockResolvedValue({ kind: 'completed', value: { text: '{"tags":["one"]}', usage: null } });
  const ai = { classify, generate, createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() };
  const publish = vi.fn().mockResolvedValue({});
  const common = { ai, model, signal: new AbortController().signal, tasks: { updateOwnedTask: vi.fn() } };
  const result = role === 'category'
    ? await categorize('task', 'token', { ...common, inputs: { loadResult: async () => ({ kind: 'loaded', input: { basis, title: 'title', content, categories: [{ id: 'one', label: 'One' }], classifier: model, signal: common.signal } }) }, catalog: { publishCategoryCandidate: publish } })
    : await assignTags('task', 'token', { ...common, inputs: { loadResult: async () => ({ kind: 'loaded', input: { basis, title: 'title', category: 'One', content, generator: model } }) } as unknown as Parameters<typeof assignTags>[2]['inputs'], catalog: { publishTagCandidate: publish, tagKeysFit: vi.fn().mockResolvedValue(true) } });
  expect(result).toEqual({ kind: 'published' });
  expect(publish).toHaveBeenCalledWith(expect.objectContaining(basis), expect.any(Date));
});

it('fails closed when metadata leaves no room for meaningful excerpts', async () => {
  const updateOwnedTask = vi.fn().mockResolvedValue({});
  const classify = vi.fn<AiPort['classify']>();
  const basis = { taskId: 'task', executionToken: 'token', articleId: 'a', generation: 1, prerequisiteId: null, contentRevision: 1, contentText: content, assignmentRevision: 1, catalogEpoch: 1 };
  const result = await categorize('task', 'token', { ai: { classify, generate: vi.fn(), createRestrictedSession: vi.fn() }, model, signal: new AbortController().signal, tasks: { updateOwnedTask }, inputs: { loadResult: async () => ({ kind: 'loaded', input: { basis, title: 'x'.repeat(20000), content, categories: [{ id: 'one', label: 'One' }], classifier: model, signal: new AbortController().signal } }) }, catalog: { publishCategoryCandidate: vi.fn() } });
  expect(result).toEqual({ kind: 'needs_input' });
  expect(updateOwnedTask).toHaveBeenCalledWith('task', 'token', expect.objectContaining({ errorCode: 'context_too_large' }));
  expect(classify).not.toHaveBeenCalled();
});
