import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateClassificationAnswers, validateClassificationRequest, validateGenerationRequest } from '../../src/server/adapters/pi/runtime.js';
import { createPiClassifier } from '../../src/server/adapters/pi/classifier.js';
import { createPiGenerator } from '../../src/server/adapters/pi/generator.js';
import type { UsageService } from '../../src/server/application/usage.js';
import type { ClassificationQuestion, ClassificationRequest } from '../../src/server/ports/ai.js';

const questions: Record<string, ClassificationQuestion> = {
  b: { type: 'bool', instructions: 'bool', criteria: { true: 'yes', false: 'no' } },
  c: { type: 'choice', instructions: 'choice', criteria: { a: 'A', b: 'B' } },
  s: { type: 'score', instructions: 'score', criteria: ['low', 'mid', 'high'] },
};
const request: ClassificationRequest = { model: { provider: 'p', model: 'm' }, role: 'quality', state: { text: 'hello', nested: [1, null] }, questions };
const answers = () => ({ b: { type: 'bool', probability: 0 }, c: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 1 }, s: { type: 'score', score: 1, confidence: 0.5 } });
const ref = { provider: 'test', model: 'model' };
afterEach(() => vi.restoreAllMocks());

describe('shared Pi runtime boundary', () => {
  it('constructs one private runtime and exports only admitted capabilities', async () => {
    const classifierModel = { id: 'jev-latest', provider: 'typesafe', type: 'classifier', api: 'typesafe-system-one', baseUrl: 'https://api.typesafe.ai/v1', input: ['text'] };
    const chatModel = { id: 'gpt-4.1-mini', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', input: ['text'] };
    const originalRead = vi.fn<(provider: string) => Promise<undefined>>().mockResolvedValue(undefined);
    const store = { read: originalRead, modify: vi.fn(async () => ({ type: 'api_key', key: '!fixture-command' })) };
    const runtime = { credentials: { store }, getAuth: vi.fn(), getError: vi.fn(), listCredentials: vi.fn(async () => []), getProviderAuthStatus: vi.fn(() => ({ configured: false })), getModelOfType: vi.fn(() => classifierModel), getPhysicalModel: vi.fn(() => chatModel) } as unknown as ModelRuntime;
    const getAuth = runtime.getAuth;
    const create = vi.spyOn(ModelRuntime, 'create').mockResolvedValue(runtime);
    const usage = { executeAttempt: vi.fn(async () => ({ kind: 'paused_budget', reason: 'daily_limit' })) } as unknown as UsageService;
    const c = { provider: 'typesafe', model: 'jev-latest' }; const g = { provider: 'openai', model: 'gpt-4.1-mini' };
    const [classifier, generator] = await Promise.all([createPiClassifier(usage, [{ role: 'quality', primary: c, fallback: null }]), createPiGenerator(usage, [{ role: 'summary', primary: g, fallback: null }])]);
    expect(Object.keys(classifier)).toEqual(['classify']);
    expect(Object.keys(generator)).toEqual(['generate']);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ authPath: '/data/pi-auth/auth.json', modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    await expect(store.read('openai')).rejects.toThrow('Command credentials are disabled');
    expect(originalRead).not.toHaveBeenCalled();
    expect(store.modify).toHaveBeenCalledOnce();
    const boundary = await import('../../src/server/adapters/pi/runtime.js');
    expect(boundary).not.toHaveProperty('createPiRuntime');
    expect(boundary).not.toHaveProperty('selectPhysicalModel');
    expect(boundary).not.toHaveProperty('preflightConfiguredAuth');
    expect(boundary).not.toHaveProperty('getAuth');
    const classifierScope = { bucket: 'classifier' as const, signal: new AbortController().signal };
    const generationScope = { bucket: 'automatic' as const, signal: new AbortController().signal };
    const original = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
    try {
      expect(await classifier.classify({ ...request, model: c }, classifierScope)).toEqual({ kind: 'paused_auth' });
      process.env.TYPESAFE_API_KEY = ' \t';
      expect(await classifier.classify({ ...request, model: c }, classifierScope)).toEqual({ kind: 'paused_auth' });
      process.env.TYPESAFE_API_KEY = 'fixture-only-key';
      expect(await classifier.classify({ ...request, model: c }, classifierScope)).toEqual({ kind: 'paused_budget', reason: 'daily_limit' });
      const fallback = await createPiClassifier(usage, [{ role: 'quality', primary: { ...c, model: 'other' }, fallback: c }]);
      expect(await fallback.classify({ ...request, model: c }, classifierScope)).toEqual({ kind: 'paused_budget', reason: 'daily_limit' });
      const duplicate = await createPiClassifier(usage, [{ role: 'quality', primary: c, fallback: null }, { role: 'quality', primary: c, fallback: null }]);
      await expect(duplicate.classify({ ...request, model: c }, classifierScope)).rejects.toThrow();
      await expect(classifier.classify({ ...request, model: { ...c, model: 'unmapped' } }, classifierScope)).rejects.toThrow();
      await expect(classifier.classify({ ...request, model: c, role: 'transcription' }, classifierScope)).rejects.toThrow();
      await expect(classifier.classify({ ...request, model: c }, generationScope)).rejects.toThrow();
      vi.mocked(runtime.getPhysicalModel).mockReturnValueOnce(undefined);
      await expect(generator.generate({ model: g, role: 'summary', system: '', user: '' }, generationScope)).rejects.toThrow();
      vi.mocked(runtime.getPhysicalModel).mockReturnValueOnce({ ...chatModel, input: ['image'] } as never);
      await expect(generator.generate({ model: g, role: 'summary', system: '', user: '' }, generationScope)).rejects.toThrow();
      expect(getAuth).not.toHaveBeenCalled(); expect(usage.executeAttempt).toHaveBeenCalledTimes(2);
    } finally { if (original === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = original; }
  });
});

describe('classification validation', () => {
  it('accepts native score endpoints and fractional levels, preserving the criteria', () => {
    validateClassificationRequest(request);
    for (const score of [0, 0.5, 2]) {
      const result = validateClassificationAnswers(questions, { ...answers(), s: { type: 'score', score, confidence: 1 } });
      expect(result.s).toEqual({ type: 'score', score, confidence: 1, criteria: ['low', 'mid', 'high'] });
    }
  });
  it('allows text only and rejects provider controls for generation and sessions', () => {
    const generation = { model: ref, role: 'summary' as const, system: 'system', user: 'user' };
    validateGenerationRequest(generation, 'generation');
    validateGenerationRequest({ model: ref, role: 'chat', system: 'system' }, 'session');
    expect(() => validateGenerationRequest({ ...generation, images: [] } as never, 'generation')).toThrow();
    expect(() => validateGenerationRequest({ ...generation, maxRetries: 2 } as never, 'generation')).toThrow();
    expect(() => validateGenerationRequest({ model: ref, role: 'summary', system: 'system' } as never, 'generation')).toThrow();
  });
  it('rejects malformed state and questions before admission', () => {
    for (const state of [null, [], { n: Infinity }, { n: undefined }]) expect(() => validateClassificationRequest({ ...request, state } as never)).toThrow();
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => validateClassificationRequest({ ...request, state: cycle } as never)).toThrow();
    expect(() => validateClassificationRequest({ ...request, questions: {} })).toThrow();
    expect(() => validateClassificationRequest({ ...request, questions: { '': questions.b! } })).toThrow();
    expect(() => validateClassificationRequest({ ...request, questions: { s: { type: 'score', instructions: '', criteria: ['one'] } } })).toThrow();
    expect(() => validateClassificationRequest({ ...request, images: [] } as never)).toThrow();
  });
  it('rejects missing/extra keys, wrong types, invalid choices, probabilities and scores', () => {
    const bad = [
      { ...answers(), x: {} }, { ...answers(), b: undefined }, { ...answers(), b: { type: 'choice' } },
      { ...answers(), b: { type: 'bool', probability: NaN } }, { ...answers(), b: { type: 'bool', probability: 1.01 } },
      { ...answers(), c: { ...answers().c, choice: 'other' } }, { ...answers(), c: { ...answers().c, probabilities: { a: 1 } } },
      { ...answers(), c: { ...answers().c, probabilities: { a: 1, b: -0.1 } } }, { ...answers(), c: { ...answers().c, confidence: Infinity } },
      ...[-0.01, 2.01, NaN, Infinity].map((score) => ({ ...answers(), s: { type: 'score', score, confidence: 1 } })),
      { ...answers(), s: { type: 'score', score: 1, confidence: -1 } },
    ];
    for (const response of bad) expect(() => validateClassificationAnswers(questions, response)).toThrow();
    expect(() => validateClassificationAnswers(questions, { c: answers().c, s: answers().s })).toThrow();
  });
});
