import type { AiOutcome, AiPort, GenerationRequest } from '../ports/ai.js';
import type { VerifiedModel } from './process-context-chunks.js';
import { validSummaryString, validSummaryText } from '../../shared/summaries.js';

/** Unpublished candidate. The caller must fence its write against task ownership and content revision. */
export type SummaryCandidate = { articleId: string; taskId: string; executionToken: string; generation: number; text: string; contentRevision: number; limitation: string | null };
export type SummaryInput = {
  articleId: string;
  taskId: string;
  executionToken: string;
  generation: number;
  contentRevision: number;
  title: string | null;
  content: string;
  quality: string;
  limitation: string | null;
  prompt: string;
  generator: VerifiedModel;
  signal: AbortSignal;
};

/** Direct-only candidate stage. No persistence, retries, refetch or Pi sessions. */
export async function summarizeArticle(input: SummaryInput, ai: Pick<AiPort, 'generate'>): Promise<AiOutcome<SummaryCandidate> | { kind: 'unsupported_context' } | { kind: 'invalid_output' }> {
  const { articleId, taskId, executionToken, generation, contentRevision, title, content, quality, limitation, prompt, signal } = input;
  const model = { ...input.generator.model };
  const limits = { ...input.generator.limits };
  const countTokens = input.generator.countTokens;
  const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
  const nonnegative = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!articleId?.trim() || !taskId?.trim() || !executionToken?.trim() || !nonnegative(generation) || generation > 2147483647 || !positive(contentRevision) || contentRevision > 2147483647 || (title !== null && typeof title !== 'string') || typeof content !== 'string' || !content.trim() || quality !== 'usable' || (limitation !== null && (typeof limitation !== 'string' || !validSummaryString(limitation))) || typeof prompt !== 'string' || !prompt.trim() || !signal || typeof signal.addEventListener !== 'function') throw new RangeError('invalid summary input');
  if (!model.provider?.trim() || !model.model?.trim() || typeof countTokens !== 'function' || !positive(limits.contextTokens) || !positive(limits.outputTokens) || !nonnegative(limits.framingTokens) || (limits.maxInputTokens !== undefined && !positive(limits.maxInputTokens))) return { kind: 'unsupported_context' };
  const request: GenerationRequest = { model, role: 'summary', system: prompt, user: JSON.stringify({ title, content, quality, limitation }) };
  const serialized = JSON.stringify(request);
  const size = countTokens(serialized);
  const total = size + limits.framingTokens + limits.outputTokens;
  if (!nonnegative(size) || !Number.isSafeInteger(total) || total > limits.contextTokens || (limits.maxInputTokens !== undefined && size + limits.framingTokens > limits.maxInputTokens)) return { kind: 'unsupported_context' };
  const outcome = await ai.generate(request, { bucket: 'interactive', taskId, signal });
  if (outcome.kind !== 'completed') return outcome;
  const text = outcome.value.text;
  if (!validSummaryText(text)) return { kind: 'invalid_output' };
  return { kind: 'completed', value: { articleId, taskId, executionToken, generation, text, contentRevision, limitation } };
}
