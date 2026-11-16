import { describe, expect, it, vi } from 'vitest';
import { summarizeArticle, type SummaryInput } from '../../src/server/application/summarize-article.js';
import type { AiPort } from '../../src/server/ports/ai.js';

function fixture(): SummaryInput {
  return { articleId: 'article', taskId: 'task', executionToken: 'token', generation: 3, contentRevision: 2, title: 'title', content: 'full article', quality: 'usable', limitation: null, prompt: 'Summarize faithfully', signal: new AbortController().signal,
    generator: { model: { provider: 'fixture', model: 'fixture' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 10 }, countTokens: value => Buffer.byteLength(value) } };
}
function fake() {
  return { generate: vi.fn<AiPort['generate']>().mockResolvedValue({ kind: 'completed', value: { text: 'Saved candidate', usage: null } }) };
}

describe('direct summary candidate', () => {
  it('counts the exact dispatched request and uses interactive admission', async () => {
    const input = fixture(), ai = fake();
    const count = vi.fn(input.generator.countTokens);
    input.generator = { ...input.generator, countTokens: count };
    expect(await summarizeArticle(input, ai)).toEqual({ kind: 'completed', value: { articleId: 'article', taskId: 'task', executionToken: 'token', generation: 3, text: 'Saved candidate', contentRevision: 2, limitation: null } });
    const [request, scope] = ai.generate.mock.calls[0]!;
    expect(count).toHaveBeenCalledWith(JSON.stringify(request));
    expect(request).toMatchObject({ role: 'summary', system: input.prompt, user: JSON.stringify({ title: input.title, content: input.content, quality: input.quality, limitation: input.limitation }) });
    expect(scope).toEqual({ bucket: 'interactive', taskId: input.taskId, signal: input.signal });
  });
  it('requires a real execution identity and preserves the limitation in the candidate', async () => {
    const ai = fake(), input = { ...fixture(), limitation: 'fallback' };
    expect(await summarizeArticle(input, ai)).toMatchObject({ kind: 'completed', value: { articleId: input.articleId, taskId: input.taskId, executionToken: input.executionToken, generation: input.generation, contentRevision: input.contentRevision, limitation: 'fallback' } });
    for (const patch of [{ articleId: '' }, { taskId: '' }, { executionToken: '' }, { generation: -1 }, { generation: 1.5 }, { contentRevision: 0 }, { limitation: 'bad\0value' }]) {
      await expect(summarizeArticle({ ...input, ...patch }, ai)).rejects.toThrow(/summary input/);
    }
    expect(ai.generate).toHaveBeenCalledOnce();
  });
  it.each(['unusable', 'uncertain', 'unknown'])('rejects %s quality before generation', async quality => {
    const ai = fake();
    await expect(summarizeArticle({ ...fixture(), quality }, ai)).rejects.toThrow(/summary input/);
    expect(ai.generate).not.toHaveBeenCalled();
  });
  it('includes limitations for usable content', async () => {
    const ai = fake(), input = { ...fixture(), limitation: 'fallback; quality is heuristic' };
    expect(await summarizeArticle(input, ai)).toMatchObject({ kind: 'completed' });
    expect(ai.generate).toHaveBeenCalledOnce();
    expect(JSON.parse(ai.generate.mock.calls[0]![0].user)).toMatchObject({ quality: 'usable', limitation: input.limitation });
  });
  it('does not dispatch oversized or unverifiable contexts', async () => {
    const ai = fake(), input = fixture();
    input.generator = { ...input.generator, limits: { contextTokens: 120, outputTokens: 100, framingTokens: 10 } };
    expect(await summarizeArticle(input, ai)).toEqual({ kind: 'unsupported_context' });
    input.generator = { ...input.generator, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 10, maxInputTokens: 1 } };
    expect(await summarizeArticle(input, ai)).toEqual({ kind: 'unsupported_context' });
    input.generator = { ...input.generator, countTokens: () => Number.NaN };
    expect(await summarizeArticle(input, ai)).toEqual({ kind: 'unsupported_context' });
    expect(ai.generate).not.toHaveBeenCalled();
  });
  it.each(['', '   ', 'bad\0text', 'bad\ud800', 'a'.repeat(16385)])('rejects invalid generated text', async text => {
    const ai = fake(); ai.generate.mockResolvedValue({ kind: 'completed', value: { text, usage: null } });
    expect(await summarizeArticle(fixture(), ai)).toEqual({ kind: 'invalid_output' });
  });
  it('preserves non-admission outcome without creating a candidate', async () => {
    const ai = fake(); ai.generate.mockResolvedValue({ kind: 'paused_budget', reason: 'daily_limit' });
    expect(await summarizeArticle(fixture(), ai)).toEqual({ kind: 'paused_budget', reason: 'daily_limit' });
  });
});
