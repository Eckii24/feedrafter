import { ModelRuntime, type CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent';
import type { ClassifierModel, ClassifierApi, Model, Api } from '@earendil-works/pi-ai';
import { modelRoleNames, type ModelReference, type ModelRole, type ModelRoleSettings } from '../../../shared/settings.js';
import type { ReservationIntent } from '../../domain/usage.js';
import type { AiScope, ClassificationAnswer, ClassificationQuestion, ClassificationRequest, GenerationRequest, SessionOptions } from '../../ports/ai.js';

const runtimeOptions: CreateModelRuntimeOptions = {
  authPath: '/data/pi-auth/auth.json', modelsPath: '/data/pi-auth/models.json',
  modelsStorePath: '/data/pi-auth/catalog.json', allowModelNetwork: false, refreshOnCreate: false,
};

/** Call once at the application composition boundary; pass this instance to every Pi adapter. */
export function createPiRuntime(create: (options: CreateModelRuntimeOptions) => Promise<ModelRuntime> = (options) => ModelRuntime.create(options)): Promise<ModelRuntime> {
  return create({ ...runtimeOptions });
}

/** Offline candidate presence only, not validity; credential resolution belongs to dispatch. */
export async function preflightConfiguredAuth(runtime: ModelRuntime, provider: string): Promise<'configured' | 'paused_auth' | 'paused_configuration'> {
  try {
    if (runtime.getError()) return 'paused_configuration';
    const credentials = await runtime.listCredentials();
    const environmentPresent = provider === 'typesafe' && !!process.env.TYPESAFE_API_KEY?.trim();
    return credentials.some((entry) => entry.providerId === provider) || runtime.getProviderAuthStatus(provider).configured || environmentPresent ? 'configured' : 'paused_auth';
  } catch {
    return 'paused_configuration';
  }
}

export type PhysicalSelection =
  | { kind: 'classifier'; model: ClassifierModel<ClassifierApi>; intent: ReservationIntent }
  | { kind: 'generation'; model: Model<Api>; intent: ReservationIntent };

/** Pure catalog/mapping preflight. Never resolves auth, refreshes catalogs or dispatches. */
export function selectPhysicalModel(runtime: ModelRuntime, mappings: readonly ModelRoleSettings[], reference: ModelReference, role: ModelRole, scope: AiScope, kind: 'classifier' | 'generation'): PhysicalSelection {
  if (!reference || typeof reference.provider !== 'string' || !reference.provider.trim() || typeof reference.model !== 'string' || !reference.model.trim()
    || !(modelRoleNames as readonly string[]).includes(role) || role === 'transcription'
    || !scope || !scope.signal || typeof scope.signal.addEventListener !== 'function'
    || (scope.taskId !== undefined && typeof scope.taskId !== 'string') || (scope.turnId !== undefined && typeof scope.turnId !== 'string')
    || (kind === 'classifier' ? scope.bucket !== 'classifier' : kind !== 'generation' || !['automatic', 'interactive'].includes(scope.bucket))) throw new RangeError('Invalid AI selection or scope');
  const mapping = mappings.filter((entry) => entry.role === role);
  if (mapping.length !== 1 || !mapping[0]?.primary || ![mapping[0].primary, mapping[0].fallback].some((item) => item?.provider === reference.provider && item.model === reference.model)) throw new RangeError('Unmapped AI model');
  const intent: ReservationIntent = { ...reference, role, bucket: scope.bucket, ...(scope.taskId === undefined ? {} : { taskId: scope.taskId }), ...(scope.turnId === undefined ? {} : { turnId: scope.turnId }) };
  if (kind === 'classifier') {
    const model = runtime.getModelOfType('classifier', reference.provider, reference.model);
    if (!model || model.provider !== reference.provider || model.id !== reference.model || !model.input.includes('text')) throw new RangeError('Unsupported classifier model');
    return { kind, model, intent };
  }
  const model = runtime.getPhysicalModel(reference.provider, reference.model);
  if (!model || model.provider !== reference.provider || model.id !== reference.model || !model.input.includes('text')) throw new RangeError('Unsupported generation model');
  return { kind, model, intent };
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function json(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || (!Array.isArray(value) && !record(value)) || seen.has(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every((item) => json(item, seen));
  seen.delete(value);
  return valid;
}
const strings = (value: unknown): value is Record<string, string> => record(value) && Object.values(value).every((item) => typeof item === 'string');
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const sameKeys = (a: object, b: object) => { const x = Object.keys(a); const y = Object.keys(b); return x.length === y.length && x.every((key) => Object.hasOwn(b, key)); };

/** Reject provider controls and non-text inputs before admission. */
export function validateGenerationRequest(request: GenerationRequest | SessionOptions, kind: 'generation' | 'session'): void {
  if (!record(request) || (kind === 'generation'
    ? !sameKeys(request, { model: 0, role: 0, system: 0, user: 0 }) || !('user' in request) || typeof request.user !== 'string'
    : kind !== 'session' || !sameKeys(request, { model: 0, role: 0, system: 0 })) || typeof request.system !== 'string') throw new RangeError('Invalid generation input');
}

/** Validate before admission. Images and other provider-specific inputs are not accepted. */
export function validateClassificationRequest(request: ClassificationRequest): void {
  if (!record(request) || !sameKeys(request, { model: 0, role: 0, state: 0, questions: 0 }) || !record(request.state) || !json(request.state) || !record(request.questions) || !Object.keys(request.questions).length || Object.keys(request.questions).some((key) => !key.trim())) throw new RangeError('Invalid classification context');
  for (const question of Object.values(request.questions)) {
    if (!record(question) || !sameKeys(question, { type: 0, instructions: 0, criteria: 0 }) || typeof question.instructions !== 'string') throw new RangeError('Invalid classification question');
    if (question.type === 'bool') {
      if (!strings(question.criteria) || !sameKeys(question.criteria, { true: '', false: '' })) throw new RangeError('Invalid bool criteria');
    } else if (question.type === 'choice') {
      if (!strings(question.criteria) || !Object.keys(question.criteria).length) throw new RangeError('Invalid choice criteria');
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || !question.criteria.every((item: unknown) => typeof item === 'string')) throw new RangeError('Invalid score criteria');
    } else throw new RangeError('Invalid classification question type');
  }
}

/** Validate complete answers, retaining score criteria and the native expected-level index. */
export function validateClassificationAnswers(questions: Record<string, ClassificationQuestion>, answers: unknown): Record<string, ClassificationAnswer> {
  validateClassificationRequest({ model: { provider: '', model: '' }, role: 'quality', state: {}, questions });
  if (!record(answers) || !sameKeys(questions, answers)) throw new RangeError('Invalid answer keys');
  const result: Record<string, ClassificationAnswer> = Object.create(null) as Record<string, ClassificationAnswer>;
  for (const [key, question] of Object.entries(questions)) {
    const answer = answers[key];
    if (!record(answer) || answer.type !== question.type) throw new RangeError('Invalid answer type');
    if (question.type === 'bool') {
      if (!probability(answer.probability)) throw new RangeError('Invalid bool probability');
      result[key] = { type: 'bool', probability: answer.probability };
    } else if (question.type === 'choice') {
      if (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice) || !probability(answer.confidence)
        || !record(answer.probabilities) || !sameKeys(question.criteria, answer.probabilities) || !Object.values(answer.probabilities).every(probability)) throw new RangeError('Invalid choice answer');
      result[key] = { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: { ...answer.probabilities } as Record<string, number> };
    } else {
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1 || !probability(answer.confidence)) throw new RangeError('Invalid score answer');
      result[key] = { type: 'score', score: answer.score, confidence: answer.confidence, criteria: [...question.criteria] };
    }
  }
  return result;
}
