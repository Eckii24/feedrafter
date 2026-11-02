import { describe, expect, it, vi } from 'vitest';
import { prepareContext, type ContextInput } from '../../src/server/application/prepare-context.js';

const base = (): ContextInput => ({
  taskKind: 'scores', fields: { includeTitle: true, includeContent: true, includeCategory: false, includeTagWeights: false, includeSourceWeight: false },
  article: { id: 'article', contentRevision: 1, title: 'Title', content: 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.', category: 'SECRET CATEGORY', tagWeights: [{ tag: 'SECRET TAG', weight: 7 }], sourceWeight: 42 },
  generation: 2, prompt: 'Score this', questions: ['Why?'], tools: '{"tool":"schema"}', limits: { contextTokens: 10000, outputTokens: 20, framingTokens: 10 },
});
const modified = (x: ContextInput, changes: Partial<ContextInput>): ContextInput => ({ ...x, ...changes });
const limited = (x: ContextInput, extra: number): ContextInput => {
  const empty = prepareContext(modified(x, { article: { ...x.article, content: '', timeBoundaries: [] } }));
  if (empty.kind !== 'direct') throw new Error('expected direct');
  return modified(x, { limits: { ...x.limits, contextTokens: empty.direct.totalTokens + extra } });
};

describe('prepareContext', () => {
  it('sizes the exact serialized envelope and output/framing reserve including tools and questions', () => {
    const x = base();
    const result = prepareContext(x);
    expect(result.kind).toBe('direct');
    if (result.kind !== 'direct') return;
    expect(result.direct.inputTokens).toBe(Buffer.byteLength(result.direct.serialized));
    expect(result.direct.totalTokens).toBe(result.direct.inputTokens + 30);
    expect(JSON.parse(result.direct.serialized)).toEqual(result.direct.request);
    expect(result.direct.request).toMatchObject({ prompt: x.prompt, questions: x.questions, tools: x.tools });
    expect(prepareContext(modified(x, { limits: { ...x.limits, contextTokens: result.direct.totalTokens } })).kind).toBe('direct');
    expect(prepareContext(modified(x, { limits: { ...x.limits, contextTokens: result.direct.totalTokens - 1 } })).kind).toBe('chunks');
  });
  it('selects only allowed fields, including for every chunk', () => {
    const x = limited(base(), 20);
    const result = prepareContext(x);
    expect(result.kind).toBe('chunks');
    if (result.kind !== 'chunks') return;
    for (const chunk of result.chunks) {
      expect(chunk.request.context).toEqual({ title: 'Title', content: x.article.content.slice(chunk.start, chunk.end) });
      expect(chunk.serialized).not.toMatch(/SECRET|42/);
    }
    const all = prepareContext(modified(base(), { fields: { includeTitle: false, includeContent: false, includeCategory: true, includeTagWeights: true, includeSourceWeight: true } }));
    expect(all.kind).toBe('direct');
    if (all.kind === 'direct') expect(all.direct.request.context).toEqual({ category: 'SECRET CATEGORY', tagWeights: [{ tag: 'SECRET TAG', weight: 7 }], sourceWeight: 42 });
  });
  it('does not chunk or leak an unselected huge article', () => {
    const x = base();
    const result = prepareContext(modified(x, { article: { ...x.article, content: 'PRIVATE'.repeat(10000) }, fields: { ...x.fields, includeContent: false }, limits: { ...x.limits, contextTokens: 200 } }));
    expect(result.kind).toBe('direct');
    expect(result.coverage).toEqual({ selected: false, length: 0, intervals: [], missing: [], complete: true });
    if (result.kind === 'direct') expect(result.direct.serialized).not.toContain('PRIVATE');
  });
  it('prefers paragraph and timestamp boundaries, with exact gapless coverage and no overlap', () => {
    const x = base();
    const content = 'aaaaaaaaaa\n\nbbbbbbbbbb\n\ncccccccccc';
    const result = prepareContext(limited(modified(x, { article: { ...x.article, content, timeBoundaries: [{ offset: 0, seconds: 0 }, { offset: 12, seconds: 5 }, { offset: 24, seconds: 9 }, { offset: 34, seconds: 12 }] } }), 16));
    expect(result.kind).toBe('chunks');
    if (result.kind !== 'chunks') return;
    expect(result.chunks.map(c => [c.start, c.end, c.startSeconds, c.endSeconds, c.overlap])).toEqual([[0, 12, 0, 5, 0], [12, 24, 5, 9, 0], [24, 34, 9, 12, 0]]);
    expect(result.chunks.map(c => c.request.context.content).join('')).toBe(content);
    expect(result.coverage).toEqual({ selected: true, length: content.length, intervals: [{ start: 0, end: 12 }, { start: 12, end: 24 }, { start: 24, end: 34 }], missing: [], complete: true });
  });
  it('prefers time boundaries without paragraph breaks and does not invent partial timestamps', () => {
    const x = base();
    const content = 'abcdefghij'.repeat(5);
    const result = prepareContext(limited(modified(x, { article: { ...x.article, content, timeBoundaries: [{ offset: 0, seconds: 0 }, { offset: 10, seconds: 4 }, { offset: 50, seconds: 20 }] } }), 20));
    expect(result.kind).toBe('chunks');
    if (result.kind !== 'chunks') return;
    expect(result.chunks[0]).toMatchObject({ start: 0, end: 10, startSeconds: 0, endSeconds: 4 });
    expect(result.chunks[1]!.endSeconds).toBeNull();
    expect(result.chunks.map(c => c.request.context.content).join('')).toBe(content);
  });
  it('splits oversized paragraphs at Unicode code point boundaries and reports exact offsets', () => {
    const x = base();
    const content = '😀é漢"\\'.repeat(60);
    const input = limited(modified(x, { article: { ...x.article, content } }), 24);
    const result = prepareContext(input);
    expect(result.kind).toBe('chunks');
    if (result.kind !== 'chunks') return;
    expect(result.chunks.length).toBeGreaterThan(2);
    expect(result.chunks.map(c => c.request.context.content).join('')).toBe(content);
    for (const c of result.chunks) {
      expect(c.request.context.content).toBe(content.slice(c.start, c.end));
      expect(c.request.context.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
      expect(c.totalTokens).toBeLessThanOrEqual(input.limits.contextTokens);
    }
    expect(result.chunks.at(-1)?.end).toBe(content.length);
  });
  it('uses provider tokenizer and enforces both input and total limits', () => {
    const x = modified(base(), { tokenizer: (s: string) => [...s].length });
    const direct = prepareContext(x);
    expect(direct.basis.sizing).toBe('provider');
    if (direct.kind !== 'direct') throw new Error('expected direct');
    expect(direct.direct.inputTokens).toBe([...direct.direct.serialized].length);
    const input = limited(modified(x, { article: { ...x.article, content: 'a😀é'.repeat(75) } }), 20);
    const result = prepareContext(modified(input, { limits: { ...input.limits, contextTokens: 10000, maxInputTokens: input.limits.contextTokens - input.limits.outputTokens } }));
    expect(result.kind).toBe('chunks');
    if (result.kind === 'chunks') {
      expect(result.chunks.map(c => c.request.context.content).join('')).toBe(input.article.content);
      for (const c of result.chunks) {
        expect(c.request.context.content).toBe(input.article.content.slice(c.start, c.end));
        expect(c.request.context.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
        expect(c.inputTokens + input.limits.framingTokens).toBeLessThanOrEqual(input.limits.contextTokens - input.limits.outputTokens);
      }
    }
  });
  it('handles a non-monotonic tokenizer without assuming a single character fits', () => {
    const x = base();
    const tokenizer = (s: string) => {
      const n = (JSON.parse(s) as { context: { content: string } }).context.content.length;
      return n === 0 || n === 2 ? 1 : 100;
    };
    const result = prepareContext(modified(x, { article: { ...x.article, content: 'abcdef' }, tokenizer, limits: { contextTokens: 5, outputTokens: 0, framingTokens: 0 } }));
    expect(result.kind).toBe('chunks');
    if (result.kind === 'chunks') expect(result.chunks.map(c => c.request.context.content)).toEqual(['ab', 'cd', 'ef']);
  });
  it('rejects an impossible fixed envelope before scanning large content prefixes', () => {
    const x = base();
    const seen: number[] = [];
    const tokenizer = (s: string) => {
      seen.push((JSON.parse(s) as { context: { content: string } }).context.content.length);
      return 100;
    };
    expect(() => prepareContext(modified(x, { article: { ...x.article, content: 'x'.repeat(40000) }, tokenizer, limits: { contextTokens: 5, outputTokens: 0, framingTokens: 0 } }))).toThrow(/exceeds/);
    expect(seen).toEqual([0]);
    seen.length = 0;
    expect(() => prepareContext(modified(x, { article: { ...x.article, content: 'x'.repeat(40000) }, tokenizer, limits: { contextTokens: 200, outputTokens: 0, framingTokens: 2, maxInputTokens: 100 } }))).toThrow(/exceeds/);
    expect(seen).toEqual([0]);
  });
  it('bounds default UTF-8 sizing work when the fixed envelope leaves no content headroom', () => {
    const x = base();
    const input = limited(modified(x, { article: { ...x.article, content: 'x'.repeat(40000) } }), 0);
    const byteLength = vi.spyOn(Buffer, 'byteLength');
    try {
      expect(() => prepareContext(input)).toThrow(/remaining content/);
      expect(byteLength.mock.calls.length).toBeLessThan(25);
    } finally {
      byteLength.mockRestore();
    }
  });
  it('bounds total provider prefix search work for pathological non-monotonic tokenizers', () => {
    const x = base();
    let calls = 0, bytes = 0;
    const tokenizer = (s: string) => {
      calls++;
      bytes += Buffer.byteLength(s);
      return (JSON.parse(s) as { context: { content: string } }).context.content.length === 0 ? 0 : 100;
    };
    expect(() => prepareContext(modified(x, { article: { ...x.article, content: 'x'.repeat(40000) }, tokenizer, limits: { contextTokens: 5, outputTokens: 0, framingTokens: 0 } }))).toThrow(/search work limit/);
    // Includes the empty and full-content requests outside the search budget.
    expect(calls).toBeLessThanOrEqual(4098);
    expect(bytes).toBeLessThanOrEqual(16 * 1024 * 1024 + 50000);
  });
  it('caps provider probes across all chunks, not just each fallback search', () => {
    const x = base();
    let calls = 0;
    const tokenizer = (s: string) => {
      calls++;
      const n = (JSON.parse(s) as { context: { content: string } }).context.content.length;
      return n <= 1 ? 0 : 100;
    };
    expect(() => prepareContext(modified(x, { article: { ...x.article, content: 'x'.repeat(600) }, tokenizer, limits: { contextTokens: 5, outputTokens: 0, framingTokens: 0 } }))).toThrow(/search work limit/);
    expect(calls).toBe(4098); // 4096 prefix probes plus fixed and direct requests
  });
  it('produces stable IDs bound to identity, generation, request and content', () => {
    const x = limited(base(), 20);
    const ids = (input: ContextInput) => { const p = prepareContext(input); if (p.kind !== 'chunks') throw new Error('expected chunks'); return p.chunks.map(c => c.id); };
    expect(ids(x)).toEqual(ids(x));
    expect(ids(modified(x, { generation: 3 }))).not.toEqual(ids(x));
    expect(ids(modified(x, { article: { ...x.article, contentRevision: 2 } }))).not.toEqual(ids(x));
    expect(ids(modified(x, { taskKind: 'summary' }))).not.toEqual(ids(x));
    expect(new Set(ids(x)).size).toBe(ids(x).length);
  });
  it('rejects invalid identities, limits, tokenizer results and impossible fixed overhead', () => {
    const x = base();
    for (const invalid of [modified(x, { generation: -1 }), modified(x, { taskKind: '' }), modified(x, { limits: { ...x.limits, contextTokens: 0 } }), modified(x, { limits: { ...x.limits, outputTokens: 10001 } }), modified(x, { limits: { ...x.limits, maxInputTokens: 0 } }), modified(x, { tokenizer: () => NaN }), modified(x, { tokenizer: () => -1 }), modified(x, { article: { ...x.article, timeBoundaries: [{ offset: 2, seconds: 1 }, { offset: 1, seconds: 2 }] } })]) expect(() => prepareContext(invalid)).toThrow();
    expect(() => prepareContext(modified(x, { fields: { ...x.fields, includeContent: false }, limits: { contextTokens: 1, outputTokens: 0, framingTokens: 0 } }))).toThrow(/exceeds/);
    expect(() => prepareContext(limited(x, 0))).toThrow(/remaining content/);
  });
});
