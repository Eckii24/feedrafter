import { expect, it, vi } from 'vitest';
import { categorize } from '../../src/server/application/categorize.js';
import { assignTags } from '../../src/server/application/assign-tags.js';
import type { AiPort } from '../../src/server/ports/ai.js';

const local = { kind: 'unverified' as const, model: { provider: 'local', model: 'm' }, limits: { contextTokens: 10000, outputTokens: 20, framingTokens: 10, maxRequestBytes: 9000 } };
const signal = new AbortController().signal;
const ai = () => ({ classify: vi.fn<AiPort['classify']>().mockResolvedValue({ kind: 'paused_auth' }), generate: vi.fn<AiPort['generate']>().mockResolvedValue({ kind: 'paused_auth' }), createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() });

it.each(['category', 'tags'] as const)('bounds the exact local %s request before dispatch', async role => {
  const port = ai();
  const updateOwnedTask = vi.fn().mockResolvedValue({ id: 'task' });
  const run = async (maxRequestBytes: number) => {
    const model = { ...local, limits: { ...local.limits, maxRequestBytes } };
    const common = { ai: port, model, signal, tasks: { updateOwnedTask } };
    if (role === 'category') {
      const input = { basis: { taskId: 'task', executionToken: 'token', articleId: 'a', generation: 1, prerequisiteId: null, contentRevision: 1, contentText: 'café 😀', assignmentRevision: 1, catalogEpoch: 1 }, title: 'title', content: 'café 😀', categories: [{ id: 'one', label: 'One' }], classifier: model, signal };
      return categorize('task', 'token', { ...common, inputs: { loadResult: async () => ({ kind: 'loaded', input }) }, catalog: { publishCategoryCandidate: vi.fn() } });
    }
    const input = { basis: { taskId: 'task', contentRevision: 1 }, title: 'title', category: 'One', content: 'café 😀', generator: model };
    const inputs = { loadResult: async () => ({ kind: 'loaded', input }) } as unknown as Parameters<typeof assignTags>[2]['inputs'];
    return assignTags('task', 'token', { ...common, inputs, catalog: { publishTagCandidate: vi.fn(), tagKeysFit: vi.fn() } });
  };
  expect(await run(9000)).toEqual({ kind: 'paused_auth' });
  const mock = role === 'category' ? port.classify : port.generate;
  const size = Buffer.byteLength(JSON.stringify(mock.mock.calls[0]![0]));
  mock.mockClear();
  expect(await run(size)).toEqual({ kind: 'paused_auth' });
  expect(mock).toHaveBeenCalledOnce();
  mock.mockClear();
  expect(await run(size - 1)).toEqual({ kind: 'needs_input' });
  expect(mock).not.toHaveBeenCalled();
  expect(updateOwnedTask).toHaveBeenLastCalledWith('task', 'token', expect.objectContaining({ errorCode: 'context_too_large' }));
});
