import { createHash } from 'node:crypto';
import type { ScoreContext } from '../../shared/scores.js';

export type ContextFields = Readonly<ScoreContext>;
export type TimeBoundary = Readonly<{ offset: number; seconds: number }>;
export type ContextInput = Readonly<{
  taskKind: string;
  fields: ContextFields;
  article: Readonly<{ id: string; contentRevision: number; title: string | null; content: string; category: string | null; tagWeights: readonly Readonly<{ tag: string; weight: number }>[]; sourceWeight: number | null; timeBoundaries?: readonly TimeBoundary[] }>;
  generation: number;
  prompt: string;
  questions: readonly string[];
  // JSON text for the exact tool schemas to be used; included as a string in the request envelope.
  tools: string;
  limits: Readonly<{ contextTokens: number; outputTokens: number; framingTokens: number; maxInputTokens?: number }>;
  tokenizer?: (serializedRequest: string) => number;
  // Evidence execution needs a persisted chunk even if the generator fits all content.
  forceChunks?: boolean;
  scoreTargetId?: string;
}>;

type Selected = { title?: string | null; content?: string; category?: string | null; tagWeights?: { tag: string; weight: number }[]; sourceWeight?: number | null };
type Request = { prompt: string; questions: string[]; tools: string; context: Selected };
type SizedRequest = { request: Request; serialized: string; inputTokens: number; totalTokens: number };
export type ContextChunk = SizedRequest & { id: string; start: number; end: number; overlap: number; startSeconds: number | null; endSeconds: number | null };
export type ContextPlan = {
  basis: { articleId: string; contentRevision: number; generation: number; taskKind: string; sizing: 'provider' | 'utf8-bytes'; offsetUnit: 'utf16'; condensed: false; limited: false };
  coverage: { selected: boolean; length: number; intervals: { start: number; end: number }[]; missing: { start: number; end: number }[]; complete: true };
} & ({ kind: 'direct'; direct: SizedRequest } | { kind: 'chunks'; chunks: ContextChunk[] });

const integer = (value: number, min: number) => Number.isSafeInteger(value) && value >= min;
const isBoundary = (s: string, i: number) => i <= 0 || i >= s.length || !(s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff && s.charCodeAt(i) >= 0xdc00 && s.charCodeAt(i) <= 0xdfff);

/** Canonical property order for selected context, including the optional content last. */
export function selectContext(article: ContextInput['article'], fields: ContextFields): Selected {
  const selected: Selected = {};
  if (fields.includeTitle) selected.title = article.title;
  if (fields.includeCategory) selected.category = article.category;
  if (fields.includeTagWeights) selected.tagWeights = article.tagWeights.map(t => ({ tag: t.tag, weight: t.weight }));
  if (fields.includeSourceWeight) selected.sourceWeight = article.sourceWeight;
  if (fields.includeContent) selected.content = article.content;
  return selected;
}

/** Plans only the serialized envelope returned here. Callers must reserve additional provider framing tokens and send this exact envelope. UTF-8 bytes are a conservative estimate only for tokenizers with at most one token per byte. */
export function prepareContext(input: ContextInput): ContextPlan {
  if (!input || !input.article || !input.fields || !input.limits || typeof input.taskKind !== 'string' || !input.taskKind.trim() || typeof input.article.id !== 'string' || !input.article.id.trim() || !integer(input.article.contentRevision, 0) || !integer(input.generation, 0)) throw new RangeError('invalid context identity');
  const { article, fields, limits } = input;
  if (['includeTitle', 'includeContent', 'includeCategory', 'includeTagWeights', 'includeSourceWeight'].some(key => typeof fields[key as keyof ContextFields] !== 'boolean')) throw new RangeError('invalid context fields');
  if (typeof input.prompt !== 'string' || !Array.isArray(input.questions) || input.questions.some(q => typeof q !== 'string') || typeof input.tools !== 'string' || (input.tokenizer !== undefined && typeof input.tokenizer !== 'function')) throw new RangeError('invalid request');
  if (!integer(limits.contextTokens, 1) || !integer(limits.outputTokens, 0) || !integer(limits.framingTokens, 0) || (limits.maxInputTokens !== undefined && !integer(limits.maxInputTokens, 1)) || limits.outputTokens + limits.framingTokens > limits.contextTokens) throw new RangeError('invalid token limits');
  if (typeof article.content !== 'string' || (article.title !== null && typeof article.title !== 'string') || (article.category !== null && typeof article.category !== 'string') || (article.sourceWeight !== null && !Number.isFinite(article.sourceWeight)) || !Array.isArray(article.tagWeights) || article.tagWeights.some(t => !t || typeof t.tag !== 'string' || !Number.isFinite(t.weight))) throw new RangeError('invalid article');
  const times = article.timeBoundaries ?? [];
  if (!Array.isArray(times) || times.some((t, i) => !t || !integer(t.offset, 0) || t.offset > article.content.length || !isBoundary(article.content, t.offset) || !Number.isFinite(t.seconds) || t.seconds < 0 || (i > 0 && (t.offset <= times[i - 1]!.offset || t.seconds < times[i - 1]!.seconds)))) throw new RangeError('invalid time boundaries');
  const selected = selectContext(article, { ...fields, includeContent: false });
  const size = (content?: string): SizedRequest => {
    const context: Selected = { ...selected };
    if (content !== undefined) context.content = content;
    const request: Request = { prompt: input.prompt, questions: [...input.questions], tools: input.tools, context };
    const serialized = JSON.stringify(request);
    const inputTokens = input.tokenizer ? input.tokenizer(serialized) : Buffer.byteLength(serialized, 'utf8');
    if (!integer(inputTokens, 0)) throw new RangeError('invalid tokenizer result');
    const totalTokens = inputTokens + limits.framingTokens + limits.outputTokens;
    if (!Number.isSafeInteger(totalTokens)) throw new RangeError('token count overflow');
    return { request, serialized, inputTokens, totalTokens };
  };
  const fits = (s: SizedRequest) => s.totalTokens <= limits.contextTokens && (limits.maxInputTokens === undefined || s.inputTokens + limits.framingTokens <= limits.maxInputTokens);
  const basis = { articleId: article.id, contentRevision: article.contentRevision, generation: input.generation, taskKind: input.taskKind, sizing: input.tokenizer ? 'provider' as const : 'utf8-bytes' as const, offsetUnit: 'utf16' as const, condensed: false as const, limited: false as const };
  const length = fields.includeContent ? article.content.length : 0;
  // The empty selected-content envelope includes every fixed field and both reserves.
  const fixed = size(fields.includeContent ? '' : undefined);
  if (!fits(fixed)) throw new RangeError('fixed request envelope exceeds limits');
  const direct = length ? size(article.content) : fixed;
  if (fits(direct) && !input.forceChunks) return { kind: 'direct', direct, basis, coverage: { selected: fields.includeContent, length, intervals: length ? [{ start: 0, end: length }] : [], missing: [], complete: true } };
  if (!length) throw new RangeError('chunk evidence requires selected content');

  // Bound all provider prefix probes across the plan, including binary and preferred-boundary
  // searches. JSON escaping uses at most six UTF-8 bytes per UTF-16 content unit.
  let probes = 0, probeBytes = 0;
  const fixedBytes = Buffer.byteLength(fixed.serialized, 'utf8');
  const prefix = (start: number, end: number) => {
    if (input.tokenizer) {
      probes++;
      probeBytes += fixedBytes + 6 * (end - start);
      if (probes > 4096 || probeBytes > 16 * 1024 * 1024) throw new RangeError('provider prefix search work limit exceeded');
    }
    return size(article.content.slice(start, end));
  };

  // Offsets are UTF-16 code-unit boundaries, never between a surrogate pair.
  const positions = [0];
  for (let i = 0; i < length;) { i += article.content.codePointAt(i)! > 0xffff ? 2 : 1; positions.push(i); }
  const preferred = new Set<number>(times.map(t => t.offset));
  for (const match of article.content.matchAll(/\n(?:[\t \r]*\n)+/g)) preferred.add(match.index + match[0].length);
  preferred.add(length);
  const timeAt = new Map(times.map(t => [t.offset, t.seconds]));
  const identity = createHash('sha256').update(JSON.stringify([basis, selected, input.prompt, input.questions, input.tools, article.content, times])).digest('hex');
  const chunks: ContextChunk[] = [];
  let startIndex = 0;
  while (startIndex < positions.length - 1) {
    const start = positions[startIndex]!;
    let low = startIndex + 1, high = positions.length - 1, best = startIndex;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (fits(prefix(start, positions[mid]!))) { best = mid; low = mid + 1; } else high = mid - 1;
    }
    // Provider token counts need not be monotonic; UTF-8 bytes are monotonic
    // across code-point boundaries, so only provider sizing needs a fallback scan.
    if (best === startIndex && input.tokenizer) {
      for (let i = startIndex + 1; i < positions.length; i++) {
        if (fits(prefix(start, positions[i]!))) { best = i; break; }
      }
    }
    if (best === startIndex) throw new RangeError('request cannot fit any remaining content');
    let endIndex = best;
    for (let i = best; i > startIndex; i--) if (preferred.has(positions[i]!) && fits(prefix(start, positions[i]!))) { endIndex = i; break; }
    const end = positions[endIndex]!;
    const sized = prefix(start, end);
    if (!fits(sized)) throw new RangeError('tokenizer returned inconsistent sizes');
    const id = createHash('sha256').update(identity).update(JSON.stringify([start, end])).digest('hex');
    chunks.push({ ...sized, id, start, end, overlap: 0, startSeconds: timeAt.get(start) ?? null, endSeconds: timeAt.get(end) ?? null });
    startIndex = endIndex;
  }
  const intervals = chunks.map(({ start, end }) => ({ start, end }));
  let covered = 0;
  for (const interval of intervals) {
    if (interval.start !== covered || interval.end <= interval.start) throw new Error('incomplete context coverage');
    covered = interval.end;
  }
  if (covered !== length) throw new Error('incomplete context coverage');
  return { kind: 'chunks', chunks, basis, coverage: { selected: true, length, intervals, missing: [], complete: true } };
}
