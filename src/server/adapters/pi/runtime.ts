import { AsyncLocalStorage } from 'node:async_hooks';
import { ModelsError, type CredentialStore } from '@earendil-works/pi-ai';
import { UsageService, type InvokeResult } from '../../application/usage.js';
import type { TerminalUsage } from '../../domain/usage.js';
import type { AiOutcome, ClassificationResult, GenerationResult } from '../../ports/ai.js';
import type { InputTokenCount, InputTokenCounter } from '../../ports/input-token-counter.js';
import { createSingleSendFetch } from './single-send-transport.js';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent';
import { AdmittedStream } from './admitted-stream.js';
import { createEmptyResourceLoader } from './resource-loader.js';
import type { ClassifierModel, ClassifierApi, Model, Api } from '@earendil-works/pi-ai';
import { modelRoleNames, type ModelReference, type ModelRole, type ModelRoleSettings } from '../../../shared/settings.js';
import type { ReservationIntent } from '../../domain/usage.js';
import type { AiScope, ClassificationAnswer, ClassificationQuestion, ClassificationRequest, GenerationRequest, RestrictedSession, SessionOptions } from '../../ports/ai.js';

const runtimeOptions: CreateModelRuntimeOptions = {
  // modelsPath:null also selects Pi's in-memory model store; modelsStorePath is ignored there.
  authPath: '/data/pi-auth/auth.json', modelsPath: null,
  allowModelNetwork: false, refreshOnCreate: false,
};

// The application owns one lazy runtime; adapters never accept an injected runtime.
let runtime: Promise<ModelRuntime> | undefined;
const authEvidence = new AsyncLocalStorage<{ failed: boolean; oauth?: boolean }>();
function createPiRuntime(): Promise<ModelRuntime> {
  return runtime ??= ModelRuntime.create({ ...runtimeOptions }).then((created) => {
    // Pi 1.4's writable AuthStorage.read executes !commands. Read raw credentials
    // under its existing lock instead; keep Pi's own modify path for OAuth rotation.
    // This private shape is pinned to Pi 1.4 and must fail closed if it changes.
    const store = (created as unknown as { credentials?: { store?: CredentialStore } }).credentials?.store;
    if (!store || typeof store.modify !== 'function' || typeof store.read !== 'function') throw new Error('Unsupported Pi credential storage');
    store.read = async (provider, options) => {
      const credential = await store.modify(provider, async () => undefined, options);
      if (credential?.type === 'api_key' && credential.key?.startsWith('!')) throw new Error('Command credentials are disabled');
      return credential;
    };
    // Pi flattens setup errors into response text. Capture only typed auth evidence
    // within the current admitted attempt, before Pi converts the exception.
    const original = created.getAuth.bind(created);
    created.getAuth = (async (...args: Parameters<ModelRuntime['getAuth']>) => {
      try {
        const provider = typeof args[0] === 'string' ? args[0] : args[0].provider;
        const key = provider === 'typesafe' ? process.env.TYPESAFE_API_KEY : undefined;
        const overrides = { ...args[1], ...(key === undefined ? {} : { apiKey: key }) };
        const result = typeof args[0] === 'string' ? await original(args[0], overrides) : await original(args[0], overrides);
        const evidence = authEvidence.getStore();
        if (!result) { if (evidence) evidence.failed = true; }
        else if (evidence && (typeof args[0] === 'string' ? args[0] : args[0].provider) === 'openai') evidence.oauth = result.source === 'OAuth' && typeof result.auth.apiKey === 'string' && !result.auth.apiKey.startsWith('sk-');
        return result;
      } catch (error) {
        if (error instanceof ModelsError && (error.code === 'oauth' || error.code === 'auth')) {
          const evidence = authEvidence.getStore(); if (evidence) evidence.failed = true;
        }
        throw error;
      }
    }) as typeof created.getAuth;
    return created;
  });
}

/** Offline candidate presence only, not validity; credential resolution belongs to dispatch. */
async function preflightConfiguredAuth(runtime: ModelRuntime, provider: string): Promise<'configured' | 'paused_auth' | 'paused_configuration'> {
  try {
    if (runtime.getError()) return 'paused_configuration';
    const credentials = await runtime.listCredentials();
    const environmentPresent = (provider === 'typesafe' && !!process.env.TYPESAFE_API_KEY?.trim())
      || (provider === 'openai' && !!process.env.OPENAI_API_KEY?.trim());
    return credentials.some((entry) => entry.providerId === provider) || runtime.getProviderAuthStatus(provider).configured || environmentPresent ? 'configured' : 'paused_auth';
  } catch {
    return 'paused_configuration';
  }
}

type PhysicalSelection =
  | { kind: 'classifier'; model: ClassifierModel<ClassifierApi>; intent: ReservationIntent }
  | { kind: 'generation'; model: Model<Api>; intent: ReservationIntent };

/** Pure catalog/mapping preflight. Never resolves auth, refreshes catalogs or dispatches. */
function selectPhysicalModel(runtime: ModelRuntime, mappings: readonly ModelRoleSettings[], reference: ModelReference, role: ModelRole, scope: AiScope, kind: 'classifier' | 'generation'): PhysicalSelection {
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


const classifierRoute = 'https://api.typesafe.ai/v1/systemone';
const wireUsage = (body: unknown) => {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const usage = raw.usage && typeof raw.usage === 'object' && !Array.isArray(raw.usage) ? raw.usage as Record<string, unknown> : {};
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : null;
  const inputTokens = count(usage.input_tokens); const outputTokens = count(usage.output_tokens);
  return { inputTokens, outputTokens, costUsd: null, tokensSource: inputTokens !== null || outputTokens !== null ? 'provider' as const : 'unknown' as const, costSource: 'unknown' as const };
};
const terminal = <T extends 'failed' | 'uncertain'>(status: T, outcomeCode: string, body: unknown): TerminalUsage & { status: T } => ({ ...wireUsage(body), status, outcomeCode });

/** Classifier-only capability. Pi objects and endpoint configuration never cross this boundary. */
export async function createPiClassifier(usage: UsageService, mappings: readonly ModelRoleSettings[]): Promise<{
  classify(request: ClassificationRequest, scope: AiScope): Promise<AiOutcome<ClassificationResult>>;
}> {
  const runtime = await createPiRuntime();
  const roles = structuredClone(mappings);
  return Object.freeze({
    async classify(input: ClassificationRequest, scope: AiScope): Promise<AiOutcome<ClassificationResult>> {
      validateClassificationRequest(input);
      const request = structuredClone(input);
      if (!['quality', 'category', 'scores'].includes(request.role)) throw new RangeError('Unsupported classifier role');
      const selection = selectPhysicalModel(runtime, roles, request.model, request.role, scope, 'classifier');
      if (selection.kind !== 'classifier') throw new RangeError('Unsupported classifier');
      const model = selection.model;
      if (model.provider !== 'typesafe' || model.id !== 'jev-latest' || model.type !== 'classifier'
        || model.api !== 'typesafe-system-one' || new URL('systemone', `${model.baseUrl.replace(/\/+$/u, '')}/`).href !== classifierRoute) throw new RangeError('Unsupported classifier route');
      const auth = await preflightConfiguredAuth(runtime, model.provider);
      if (auth !== 'configured') return { kind: auth };
      const result = await usage.executeAttempt(selection.intent, scope, async (signal, permit): Promise<InvokeResult<ClassificationResult>> => {
        let status: number | undefined;
        let body: unknown;
        const send = createSingleSendFetch({ url: classifierRoute, permit, signal, timeoutMs: 60000, maxResponseBytes: 1024 * 1024 });
        const fetch: typeof globalThis.fetch = async (url, init) => {
          const response = await send(url, init);
          status = response.status;
          if (response.ok) {
            try { body = await response.clone().json(); } catch { /* Pi handles malformed responses. */ }
          }
          return response;
        };
        const evidence = { failed: false };
        const response = await authEvidence.run(evidence, () => runtime.classify(model, { state: request.state, questions: request.questions }, { signal, maxRetries: 0, fetch }));
        if (evidence.failed) return { kind: 'failure', failureKind: 'auth', terminal: terminal('failed', 'provider_auth', body) };
        if (response.stopReason !== 'stop' || response.errorMessage) {
          if (status === 401 || status === 403) return { kind: 'failure', failureKind: 'auth', terminal: terminal('failed', 'provider_auth', body) };
          if ((status !== undefined && status >= 300) || body !== undefined) return { kind: 'failure', failureKind: 'provider', terminal: terminal('failed', 'provider_error', body) };
          return { kind: 'uncertain', terminal: terminal('uncertain', 'outcome_unknown', body) };
        }
        try {
          // Pi drops extra wire answer keys; validate them before trusting its normalized answers.
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RangeError('Invalid response');
          const raw = body as Record<string, unknown>;
          if (!raw.answers || typeof raw.answers !== 'object' || Array.isArray(raw.answers)
            || Object.keys(raw.answers).length !== Object.keys(request.questions).length
            || Object.keys(request.questions).some((key) => !Object.hasOwn(raw.answers as object, key))) throw new RangeError('Invalid answer keys');
          const answers = validateClassificationAnswers(request.questions, response.answers);
          // Pi synthesizes absent/malformed token fields and catalog-derived cost: use only wire evidence.
          const known = wireUsage(body);
          const { inputTokens, outputTokens } = known;
          return { kind: 'success', value: { answers, usage: known.tokensSource === 'unknown' ? null : { inputTokens, outputTokens, costUsd: null } }, terminal: { ...known, status: 'succeeded', outcomeCode: null } };
        } catch {
          return { kind: 'failure', failureKind: 'provider', terminal: terminal('failed', 'invalid_response', body) };
        }
      });
      return result.kind === 'completed' ? { kind: 'completed', value: result.value } : result;
    },
  });
}


/** Offline, fail-closed construction checkpoint. Dispatch and file restore are not yet enabled. */
export async function createPiSessionFactory(mappings: readonly ModelRoleSettings[]): Promise<{
  createRestrictedSession(options: SessionOptions, scope: AiScope): Promise<AiOutcome<RestrictedSession>>;
}> {
  const runtime = await createPiRuntime();
  const roles = structuredClone(mappings);
  return Object.freeze({
    async createRestrictedSession(input: SessionOptions, scope: AiScope): Promise<AiOutcome<RestrictedSession>> {
      validateGenerationRequest(input, 'session');
      const options = structuredClone(input);
      if (Buffer.byteLength(options.system) > 256 * 1024) throw new RangeError('Session input exceeds limit');
      const selection = selectPhysicalModel(runtime, roles, options.model, options.role, scope, 'generation');
      if (selection.kind !== 'generation') throw new RangeError('Unsupported generation model');
      const model = selection.model;
      if (model.provider !== 'openai' || model.id !== 'gpt-4.1-mini' || model.api !== 'openai-responses'
        || new URL('responses', `${model.baseUrl.replace(/\/+$/u, '')}/`).href !== 'https://api.openai.com/v1/responses') throw new RangeError('Unsupported generation route');
      if (scope.signal.aborted) throw new DOMException('Session creation aborted', 'AbortError');
      const cwd = '/data/pi-agent';
      const manager = SessionManager.inMemory(cwd);
      // An explicit SDK model suppresses its restore warning. Independently reject
      // a different branch selection before allowing the SDK to apply the override.
      const saved = manager.getBranch().filter((entry) => entry.type === 'model_change').at(-1);
      if ((!saved && manager.getSessionFile()) || (saved && (saved.provider !== model.provider || saved.modelId !== model.id))) throw new RangeError('Session model mismatch');
      const created = await createAgentSession({
        cwd, agentDir: cwd, modelRuntime: runtime, model, sessionManager: manager,
        settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, transport: 'sse' }),
        resourceLoader: createEmptyResourceLoader(options.system), tools: [], customTools: [],
      });
      const session = created.session;
      // Until per-invocation accounting and transport are implemented, even an
      // accidental internal SDK call must never reach the underlying producer.
      session.agent.streamFunction = () => new AdmittedStream({ api: model.api, provider: model.provider, model: model.id }, async () => { throw new Error('Session dispatch unavailable'); });
      if (created.modelFallbackMessage || session.model?.provider !== model.provider || session.model.id !== model.id
        || session.getActiveToolNames().length || session.getCallableToolNames().length || scope.signal.aborted) {
        session.dispose();
        if (scope.signal.aborted) throw new DOMException('Session creation aborted', 'AbortError');
        throw new RangeError('Invalid restricted session');
      }
      let disposed = false;
      const restricted: RestrictedSession = Object.freeze({
        async prompt(text: string, requestScope: AiScope) {
          if (disposed || typeof text !== 'string') throw new RangeError('Invalid session prompt');
          selectPhysicalModel(runtime, roles, options.model, options.role, requestScope, 'generation');
          if (requestScope.signal.aborted) throw new DOMException('Session prompt aborted', 'AbortError');
          return { kind: 'paused_configuration' as const };
        },
        abort() { if (!disposed) void session.abort().catch(() => {}); },
        async compact(requestScope: AiScope) {
          if (disposed) throw new RangeError('Session disposed');
          selectPhysicalModel(runtime, roles, options.model, options.role, requestScope, 'generation');
          if (requestScope.signal.aborted) throw new DOMException('Session compaction aborted', 'AbortError');
          return { kind: 'paused_configuration' as const };
        },
        async dispose() { if (!disposed) { disposed = true; session.dispose(); } },
      });
      return { kind: 'completed', value: restricted };
    },
  });
}

const generatorRoute = 'https://api.openai.com/v1/responses';
const codexRoute = 'https://chatgpt.com/backend-api/codex/responses';
const inputTokensRoute = 'https://api.openai.com/v1/responses/input_tokens';
const maxInputBytes = 256 * 1024;
const maxResponseBytes = 1024 * 1024;
const timeoutMs = 60000;
const generationRecord = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : null;

/** Unwired count-only capability; its reservation never records the count as usage. */
export async function createPiInputTokenCounter(usage: UsageService, mappings: readonly ModelRoleSettings[]): Promise<InputTokenCounter> {
  const runtime = await createPiRuntime();
  const roles = structuredClone(mappings);
  return Object.freeze({
    async count(input: GenerationRequest, scope: AiScope): Promise<AiOutcome<InputTokenCount>> {
      validateGenerationRequest(input, 'generation');
      if (!input.system || Buffer.byteLength(input.system) + Buffer.byteLength(input.user) > maxInputBytes) throw new RangeError('Invalid counting input');
      const request = structuredClone(input);
      // Pi omits an empty system message. Restrict this capability to the exact
      // two-message shape and reject text that Pi would sanitize differently.
      if (Buffer.from(request.system, 'utf8').toString('utf8') !== request.system || Buffer.from(request.user, 'utf8').toString('utf8') !== request.user) throw new RangeError('Invalid counting input');
      if (!record(request.model) || !sameKeys(request.model, { provider: 0, model: 0 }) || request.role !== 'summary' || scope?.bucket !== 'interactive') throw new RangeError('Unsupported counting scope or model');
      const selection = selectPhysicalModel(runtime, roles, request.model, request.role, scope, 'generation');
      if (selection.kind !== 'generation') throw new RangeError('Unsupported counting model');
      const model = selection.model;
      if (model.provider !== 'openai' || model.id !== 'gpt-4.1-mini' || model.api !== 'openai-responses' || model.reasoning
        || new URL('responses', `${model.baseUrl.replace(/\/+$/u, '')}/`).href !== generatorRoute
        || new URL('responses/input_tokens', `${model.baseUrl.replace(/\/+$/u, '')}/`).href !== inputTokensRoute) throw new RangeError('Unsupported counting route');
      // Never consult Pi credential storage or refresh OAuth; Pi treats non-sk keys as OAuth.
      const key = process.env.OPENAI_API_KEY;
      if (!key || key.length > 4096 || !/^sk-[\x21-\x7e]+$/u.test(key)) return { kind: 'paused_auth' };
      const payload = JSON.stringify({ model: model.id, input: [
        { role: 'system', content: request.system },
        { role: 'user', content: [{ type: 'input_text', text: request.user }] },
      ] });
      const result = await usage.executeAttempt(selection.intent, scope, async (signal, permit): Promise<InvokeResult<InputTokenCount>> => {
        const unknown = { inputTokens: null, outputTokens: null, costUsd: null, tokensSource: 'unknown' as const, costSource: 'unknown' as const };
        const send = createSingleSendFetch({ url: inputTokensRoute, permit, signal, timeoutMs, maxResponseBytes });
        const response = await send(inputTokensRoute, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: payload });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          return { kind: 'failure', failureKind: 'auth', terminal: { ...unknown, status: 'failed', outcomeCode: 'provider_auth' } };
        }
        const bytes = await response.arrayBuffer();
        if (!send.bodyCompleted || signal.aborted) return { kind: 'uncertain', terminal: { ...unknown, status: 'uncertain', outcomeCode: 'outcome_unknown' } };
        if (!response.ok) return { kind: 'failure', failureKind: 'provider', terminal: { ...unknown, status: 'failed', outcomeCode: 'provider_error' } };
        let body: unknown;
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { /* Invalid response. */ }
        const raw = generationRecord(body);
        const inputTokens = count(raw?.input_tokens);
        if (!raw || !sameKeys(raw, { object: 0, input_tokens: 0 }) || raw.object !== 'response.input_tokens' || inputTokens === null) {
          return { kind: 'failure', failureKind: 'provider', terminal: { ...unknown, status: 'failed', outcomeCode: 'invalid_response' } };
        }
        return { kind: 'success', value: { inputTokens }, terminal: { ...unknown, status: 'succeeded', outcomeCode: null } };
      });
      return result.kind === 'completed' ? { kind: 'completed', value: result.value } : result;
    },
  });
}

/** Dormant direct Codex capability; not wired into application composition. */
export function createPiCodexGenerator(usage: UsageService, mappings: readonly ModelRoleSettings[]) {
  return createGenerator(usage, mappings, 'codex');
}

/** One bounded generation attempt. Pi models and provider controls remain private. */
export function createPiGenerator(usage: UsageService, mappings: readonly ModelRoleSettings[]) {
  return createGenerator(usage, mappings, 'openai');
}

async function createGenerator(usage: UsageService, mappings: readonly ModelRoleSettings[], provider: 'openai' | 'codex'): Promise<{
  generate(request: GenerationRequest, scope: AiScope): Promise<AiOutcome<GenerationResult>>;
}> {
  const runtime = await createPiRuntime();
  const roles = structuredClone(mappings);
  return Object.freeze({
    async generate(input: GenerationRequest, scope: AiScope): Promise<AiOutcome<GenerationResult>> {
      validateGenerationRequest(input, 'generation');
      const request = structuredClone(input);
      if (Buffer.byteLength(request.system) + Buffer.byteLength(request.user) > maxInputBytes) throw new RangeError('Generation input exceeds limit');
      const selection = selectPhysicalModel(runtime, roles, request.model, request.role, scope, 'generation');
      if (selection.kind !== 'generation') throw new RangeError('Unsupported generation model');
      const model = selection.model;
      const route = provider === 'codex' ? codexRoute : generatorRoute;
      if (provider === 'codex'
        ? model.provider !== 'openai-codex' || model.id !== 'gpt-6-luna' || model.api !== 'openai-codex-responses' || model.baseUrl !== 'https://chatgpt.com/backend-api'
        : model.provider !== 'openai' || model.id !== 'gpt-4.1-mini' || model.api !== 'openai-responses'
          || new URL('responses', `${model.baseUrl.replace(/\/+$/u, '')}/`).href !== generatorRoute) throw new RangeError('Unsupported generation route');
      const auth = await preflightConfiguredAuth(runtime, model.provider);
      if (auth !== 'configured') return { kind: auth };
      const result = await usage.executeAttempt(selection.intent, scope, async (signal, permit): Promise<InvokeResult<GenerationResult>> => {
        let status: number | undefined;
        let terminalStatus: 'completed' | 'incomplete' | 'failed' | undefined;
        let terminalCount = 0;
        let malformedStream = false;
        let inputTokens: number | null = null;
        let outputTokens: number | null = null;
        let drain: Promise<void> | undefined;
        const send = createSingleSendFetch({ url: route, permit, signal, timeoutMs, maxResponseBytes });
        const fetch: typeof globalThis.fetch = async (url, init) => {
          // Pi/OpenAI aborts its private request signal when it stops parsing a
          // failed event. The attempt signal and transport timeout still govern
          // the bounded independent drain through HTTP EOF.
          const response = await send(url, { ...init, signal });
          status = response.status;
          if (response.ok && response.body) {
            // The OpenAI SDK stops at [DONE]. Drain the bounded tee independently so
            // that its sentinel cleanup cannot masquerade as HTTP message EOF.
            drain = response.clone().arrayBuffer().then((bytes) => {
              // Inspect the entire bounded wire stream, including events after Pi
              // stops on a failure or sentinel, before trusting terminal evidence.
              const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r\n|\r|\n/u);
              let data: string[] = [];
              const inspect = () => {
                if (!data.length) return;
                const payload = data.join('\n'); data = [];
                if (payload === '[DONE]') return;
                let raw: Record<string, unknown> | undefined;
                try { raw = generationRecord(JSON.parse(payload)); } catch { malformedStream = true; return; }
                if (!raw) { malformedStream = true; return; }
                if (raw.type !== 'response.completed' && raw.type !== 'response.incomplete' && raw.type !== 'response.failed' && !(provider === 'codex' && raw.type === 'response.done')) return;
                terminalCount++;
                const wireResponse = generationRecord(raw.response);
                const expected = raw.type === 'response.done' ? wireResponse?.status : raw.type.slice('response.'.length);
                if (wireResponse?.status === expected && (expected === 'completed' || expected === 'incomplete' || expected === 'failed')) {
                  terminalStatus = expected;
                  const wire = generationRecord(wireResponse?.usage);
                  inputTokens = count(wire?.input_tokens); outputTokens = count(wire?.output_tokens);
                } else terminalStatus = undefined;
              };
              for (const line of lines) {
                if (!line) inspect();
                else if (line === 'data' || line.startsWith('data:')) data.push(line === 'data' ? '' : line.slice(5).replace(/^ /u, ''));
              }
              inspect();
            }).catch(() => { malformedStream = true; });
          }
          return response;
        };
        const evidence: { failed: boolean; oauth?: boolean } = { failed: false };
        const response = await authEvidence.run(evidence, () => runtime.stream(model, { systemPrompt: request.system, messages: [{ role: 'user', content: [{ type: 'text', text: request.user }], timestamp: Date.now() }] }, {
          signal, fetch, transport: 'sse', maxRetries: 0, timeoutMs, maxTokens: 4096, cacheRetention: 'none',
          onPayload(payload) {
            const raw = generationRecord(payload);
            // Only Pi's confirmed OAuth path may omit the field; API keys must carry the cap.
            if (raw?.model !== model.id || raw.stream !== true || raw.tools !== undefined || (provider === 'codex'
              ? raw.store !== false || raw.max_output_tokens !== undefined
              : raw.max_output_tokens !== 4096 && !(raw.max_output_tokens === undefined && evidence.oauth === true))) throw new Error('Unsupported generation payload');
          },
        }).result().catch(() => undefined));
        await drain;
        if (!send.bodyCompleted || malformedStream || terminalCount !== 1 || !terminalStatus || signal.aborted) { inputTokens = null; outputTokens = null; }
        const known = { inputTokens, outputTokens, costUsd: null, tokensSource: inputTokens !== null || outputTokens !== null ? 'provider' as const : 'unknown' as const, costSource: 'unknown' as const };
        if (evidence.failed || status === 401 || status === 403) return { kind: 'failure', failureKind: 'auth', terminal: { ...known, status: 'failed', outcomeCode: 'provider_auth' } };
        if (status !== undefined && status >= 300) return { kind: 'failure', failureKind: 'provider', terminal: { ...known, status: 'failed', outcomeCode: 'provider_error' } };
        if (send.bodyCompleted && !malformedStream && terminalCount === 1 && !signal.aborted && (terminalStatus === 'failed' || terminalStatus === 'incomplete')) {
          return { kind: 'failure', failureKind: 'provider', terminal: { ...known, status: 'failed', outcomeCode: 'provider_error' } };
        }
        if (!send.bodyCompleted || malformedStream || terminalStatus !== 'completed' || terminalCount !== 1 || !response || response.stopReason !== 'stop' || response.errorMessage || response.content.some((item) => {
          if (item.type === 'text') return false;
          return provider !== 'codex' || item.type !== 'thinking' || typeof item.thinking !== 'string'
            || (item.thinkingSignature !== undefined && typeof item.thinkingSignature !== 'string')
            || Object.keys(item).some((key) => key !== 'type' && key !== 'thinking' && key !== 'thinkingSignature');
        })) {
          return { kind: 'uncertain', terminal: { ...known, status: 'uncertain', outcomeCode: 'outcome_unknown' } };
        }
        const text = response.content.map((item) => item.type === 'text' ? item.text : '').join('');
        return { kind: 'success', value: { text, usage: known.tokensSource === 'provider' ? { inputTokens, outputTokens, costUsd: null } : null }, terminal: { ...known, status: 'succeeded', outcomeCode: null } };
      });
      return result.kind === 'completed' ? { kind: 'completed', value: result.value } : result;
    },
  });
}
