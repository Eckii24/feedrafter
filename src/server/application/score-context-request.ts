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

/** Opt-in for a local runtime; does not enforce network isolation. maxRequestBytes
 * bounds UTF-8 JSON.stringify(request), not transport bytes. The caller supplies
 * context and positive output/framing reserves. One token per byte is only an
 * assumption, not verified tokenization or a guarantee against context overflow. */
export type UnverifiedLocalModel = Readonly<{
  kind: 'unverified';
  model: ModelReference;
  limits: Readonly<{ contextTokens: number; outputTokens: number; framingTokens: number; maxRequestBytes: number }>;
}>;
export type RequestModel = VerifiedModel | UnverifiedLocalModel;

export function validateRequestModel(model: RequestModel): void {
  if (!model || typeof model !== 'object') throw new RangeError('invalid request model limits');
  if ('kind' in model) {
    const limits = model.limits;
    const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
    if (model.kind !== 'unverified' || !model.model?.provider?.trim() || !model.model.model?.trim() || !limits || !positive(limits.contextTokens) || !positive(limits.outputTokens) || !positive(limits.framingTokens) || !positive(limits.maxRequestBytes) || !Number.isSafeInteger(limits.outputTokens + limits.framingTokens) || limits.outputTokens + limits.framingTokens > limits.contextTokens || !Number.isSafeInteger(limits.maxRequestBytes + limits.framingTokens)) throw new RangeError('invalid unverified local model limits');
  } else validateVerifiedModel(model);
}

export function copyRequestModel(model: RequestModel): RequestModel {
  if (model && 'kind' in model) return { ...model, model: { ...model.model }, limits: { ...model.limits } };
  return { ...model, model: { ...model?.model }, limits: { ...model?.limits } };
}

/** Planner uses bytes as a conservative estimate, never as verified token counts. */
export function requestPlannerLimits(model: RequestModel): ContextInput['limits'] {
  validateRequestModel(model);
  if ('kind' in model) return { contextTokens: model.limits.contextTokens, outputTokens: model.limits.outputTokens, framingTokens: model.limits.framingTokens, maxInputTokens: model.limits.maxRequestBytes + model.limits.framingTokens };
  return model.limits;
}

export function measureRequest(model: RequestModel, request: object): { serialized: string; inputTokens: number; fits: boolean } {
  validateRequestModel(model);
  if (!('kind' in model)) return measureVerifiedRequest(model, request);
  const serialized = JSON.stringify(request);
  const inputTokens = Buffer.byteLength(serialized, 'utf8');
  const { contextTokens, outputTokens, framingTokens, maxRequestBytes } = model.limits;
  const total = inputTokens + framingTokens + outputTokens;
  if (!Number.isSafeInteger(total)) throw new RangeError('invalid request size');
  return { serialized, inputTokens, fits: inputTokens <= maxRequestBytes && total <= contextTokens };
}

/** Render only selected non-content metadata and host-resolved evidence. */
export function renderFinalEvidenceState(article: ContextInput['article'], fields: ContextInput['fields'], evidence: readonly (Omit<ChunkEvidence, 'refs'> & { id: string; refs: ChunkEvidence['refs'] })[]): JsonObject {
  return { ...selectContext(article, { ...fields, includeContent: false }), evidence: evidence.map(item => ({ id: item.id, questionId: item.questionId, polarity: item.polarity, text: item.text, refs: item.refs.map(ref => ({ chunkId: ref.chunkId, start: ref.start, end: ref.end, quote: ref.quote })) })) };
}

/** Render the exact classifier envelope used for scoring. */
export function renderScoreRequest(model: ModelReference, prompt: string, state: JsonObject): ClassificationRequest {
  return { model, role: 'scores', state, questions: { score: { type: 'score', instructions: prompt, criteria: ['0', '25', '50', '75', '100'] } } };
}
