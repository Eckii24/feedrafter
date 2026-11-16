import type { ModelReference } from '../../shared/settings.js';
import type { ClassificationRequest, JsonObject } from '../ports/ai.js';
import type { ChunkEvidence } from '../domain/context-reduction.js';
import { selectContext, type ContextInput } from './prepare-context.js';

/** Limits verified for the actual model, including provider framing overhead. */
export type VerifiedModel = Readonly<{
  model: ModelReference;
  limits: Readonly<{ contextTokens: number; outputTokens: number; framingTokens: number; maxInputTokens?: number }>;
  countTokens: (serializedAiRequest: string) => number;
}>;

export function validateVerifiedModel(model: VerifiedModel): void {
  const limits = model?.limits;
  const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
  const nonnegative = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!model?.model?.provider?.trim() || !model.model.model?.trim() || typeof model.countTokens !== 'function' || !limits || !positive(limits.contextTokens) || !positive(limits.outputTokens) || !nonnegative(limits.framingTokens) || (limits.maxInputTokens !== undefined && !positive(limits.maxInputTokens)) || !Number.isSafeInteger(limits.outputTokens + limits.framingTokens) || limits.outputTokens + limits.framingTokens > limits.contextTokens) throw new RangeError('unknown or invalid verified model limits');
}

/** Measure the exact request object, without reconstructing its property order. */
export function measureVerifiedRequest(model: VerifiedModel, request: object): { serialized: string; inputTokens: number; fits: boolean } {
  validateVerifiedModel(model);
  const serialized = JSON.stringify(request);
  const inputTokens = model.countTokens(serialized);
  const { contextTokens, outputTokens, framingTokens, maxInputTokens } = model.limits;
  const framed = inputTokens + framingTokens;
  const total = framed + outputTokens;
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(framed) || !Number.isSafeInteger(total)) throw new RangeError('invalid request size');
  return { serialized, inputTokens, fits: total <= contextTokens && (maxInputTokens === undefined || framed <= maxInputTokens) };
}

/** Render only selected non-content metadata and host-resolved evidence. */
export function renderFinalEvidenceState(article: ContextInput['article'], fields: ContextInput['fields'], evidence: readonly (Omit<ChunkEvidence, 'refs'> & { id: string; refs: ChunkEvidence['refs'] })[]): JsonObject {
  return { ...selectContext(article, { ...fields, includeContent: false }), evidence: evidence.map(item => ({ id: item.id, questionId: item.questionId, polarity: item.polarity, text: item.text, refs: item.refs.map(ref => ({ chunkId: ref.chunkId, start: ref.start, end: ref.end, quote: ref.quote })) })) };
}

/** Render the exact classifier envelope used for scoring. */
export function renderScoreRequest(model: ModelReference, prompt: string, state: JsonObject): ClassificationRequest {
  return { model, role: 'scores', state, questions: { score: { type: 'score', instructions: prompt, criteria: ['0', '25', '50', '75', '100'] } } };
}
