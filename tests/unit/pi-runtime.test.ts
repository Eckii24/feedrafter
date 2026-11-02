import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiRuntime, preflightConfiguredAuth, selectPhysicalModel, validateClassificationAnswers, validateClassificationRequest, validateGenerationRequest } from '../../src/server/adapters/pi/runtime.js';
import type { ClassificationQuestion, ClassificationRequest } from '../../src/server/ports/ai.js';
import type { ModelRoleSettings } from '../../src/shared/settings.js';

const questions: Record<string, ClassificationQuestion> = {
  b: { type: 'bool', instructions: 'bool', criteria: { true: 'yes', false: 'no' } },
  c: { type: 'choice', instructions: 'choice', criteria: { a: 'A', b: 'B' } },
  s: { type: 'score', instructions: 'score', criteria: ['low', 'mid', 'high'] },
};
const request: ClassificationRequest = { model: { provider: 'p', model: 'm' }, role: 'quality', state: { text: 'hello', nested: [1, null] }, questions };
const answers = () => ({ b: { type: 'bool', probability: 0 }, c: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 1 }, s: { type: 'score', score: 1, confidence: 0.5 } });
const scope = (bucket: 'classifier' | 'automatic' | 'interactive') => ({ bucket, signal: new AbortController().signal });
const ref = { provider: 'test', model: 'model' };
const mapping: ModelRoleSettings[] = [{ role: 'quality', primary: ref, fallback: null }];
afterEach(() => vi.restoreAllMocks());

describe('shared Pi runtime', () => {
  it('constructs one injected runtime with only the fixed offline paths/options', async () => {
    const runtime = {} as ModelRuntime;
    const create = vi.fn(async () => runtime);
    expect(await createPiRuntime(create)).toBe(runtime);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ authPath: '/data/pi-auth/auth.json', modelsPath: '/data/pi-auth/models.json', modelsStorePath: '/data/pi-auth/catalog.json', allowModelNetwork: false, refreshOnCreate: false });
  });

  it('constructs the real pinned runtime and performs capability lookups without network or personal discovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feedrafter-pi-'));
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network forbidden'); });
    const connect = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => { throw new Error('network forbidden'); });
    const refresh = vi.spyOn(ModelRuntime.prototype, 'refresh').mockResolvedValue({ aborted: false, errors: new Map() });
    const classify = vi.spyOn(ModelRuntime.prototype, 'classify');
    const stream = vi.spyOn(ModelRuntime.prototype, 'stream');
    try {
      const runtime = await createPiRuntime((options) => ModelRuntime.create({ ...options, authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'catalog.json') }));
      const classifier = runtime.getModelsOfType('classifier')[0];
      const chat = runtime.getModelsOfType('chat')[0];
      expect(classifier).toBeDefined(); expect(chat).toBeDefined();
      if (!classifier || !chat) throw new Error('missing built-in catalog');
      const c = { provider: classifier.provider, model: classifier.id };
      const g = { provider: chat.provider, model: chat.id };
      expect(selectPhysicalModel(runtime, [{ role: 'quality', primary: c, fallback: null }], c, 'quality', scope('classifier'), 'classifier').intent.bucket).toBe('classifier');
      expect(selectPhysicalModel(runtime, [{ role: 'summary', primary: g, fallback: null }], g, 'summary', scope('interactive'), 'generation').intent.bucket).toBe('interactive');
      expect(refresh).not.toHaveBeenCalled();
      const route = vi.fn(() => ({ model: chat, thinkingLevel: 'off' as const }));
      runtime.registerVirtualModel({ provider: 'test-virtual', id: 'route', name: 'route', route });
      const virtual = { provider: 'test-virtual', model: 'route' };
      expect(runtime.getModel(virtual.provider, virtual.model)).toBeDefined();
      expect(() => selectPhysicalModel(runtime, [{ role: 'summary', primary: virtual, fallback: null }], virtual, 'summary', scope('automatic'), 'generation')).toThrow();
      expect(route).not.toHaveBeenCalled(); expect(refresh).toHaveBeenCalledOnce();
      const image = runtime.getModelsOfType('image').find((item) => !runtime.getPhysicalModel(item.provider, item.id));
      expect(image).toBeDefined();
      if (!image) throw new Error('missing image-only model');
      const imageRef = { provider: image.provider, model: image.id };
      expect(() => selectPhysicalModel(runtime, [{ role: 'summary', primary: imageRef, fallback: null }], imageRef, 'summary', scope('automatic'), 'generation')).toThrow();
      expect(await runtime.listCredentials()).toEqual([]);
      expect(await preflightConfiguredAuth(runtime, 'unconfigured-test-provider')).toBe('paused_auth');
      expect(fetch).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
      expect(classify).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('recognizes only nonblank TypeSafe environment presence without network, commands or auth resolution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feedrafter-pi-auth-'));
    const oldKey = process.env.TYPESAFE_API_KEY;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network forbidden'); });
    const connect = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => { throw new Error('network forbidden'); });
    const commands = (['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'] as const)
      .map((name) => vi.spyOn(childProcess, name).mockImplementation(() => { throw new Error('commands forbidden'); }));
    syncBuiltinESMExports();
    const checkAuth = vi.spyOn(ModelRuntime.prototype, 'checkAuth').mockImplementation(() => { throw new Error('auth check forbidden'); });
    const getAuth = vi.spyOn(ModelRuntime.prototype, 'getAuth').mockImplementation(() => { throw new Error('auth resolution forbidden'); });
    const refresh = vi.spyOn(ModelRuntime.prototype, 'refresh').mockImplementation(() => { throw new Error('refresh forbidden'); });
    try {
      delete process.env.TYPESAFE_API_KEY;
      const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false });
      expect(await preflightConfiguredAuth(runtime, 'typesafe')).toBe('paused_auth');
      process.env.TYPESAFE_API_KEY = '  \t';
      expect(await preflightConfiguredAuth(runtime, 'typesafe')).toBe('paused_auth');
      process.env.TYPESAFE_API_KEY = 'fixture-only-key';
      expect(await preflightConfiguredAuth(runtime, 'typesafe')).toBe('configured');
      expect(await preflightConfiguredAuth(runtime, 'other-provider')).toBe('paused_auth');
      expect(fetch).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
      expect(checkAuth).not.toHaveBeenCalled(); expect(getAuth).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
      for (const command of commands) expect(command).not.toHaveBeenCalled();
    } finally {
      if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
      for (const command of commands) command.mockRestore();
      syncBuiltinESMExports();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports offline auth presence without resolving credentials', async () => {
    const runtime = { getError: vi.fn(), listCredentials: vi.fn(async () => [{ providerId: 'p', type: 'oauth' }]), getProviderAuthStatus: vi.fn(() => ({ configured: false })) } as unknown as ModelRuntime;
    expect(await preflightConfiguredAuth(runtime, 'p')).toBe('configured');
    expect(await preflightConfiguredAuth(runtime, 'missing')).toBe('paused_auth');
    vi.mocked(runtime.getProviderAuthStatus).mockReturnValueOnce({ configured: true, source: 'models_json_key' });
    expect(await preflightConfiguredAuth(runtime, 'configured')).toBe('configured');
    vi.mocked(runtime.listCredentials).mockRejectedValueOnce(new Error('secret'));
    expect(await preflightConfiguredAuth(runtime, 'p')).toBe('paused_configuration');
  });

  it('rejects wrong kind, unmapped/fallback, transcription and overridden buckets before admission', () => {
    const classifier = { id: 'model', provider: 'test', type: 'classifier', input: ['text'] };
    const chat = { id: 'model', provider: 'test', input: ['text'] };
    const runtime = { getModelOfType: vi.fn(() => classifier), getPhysicalModel: vi.fn(() => chat) } as unknown as ModelRuntime;
    expect(selectPhysicalModel(runtime, mapping, ref, 'quality', scope('classifier'), 'classifier').intent).toEqual({ ...ref, role: 'quality', bucket: 'classifier' });
    const fallback = { provider: 'test', model: 'fallback' };
    vi.mocked(runtime.getModelOfType).mockReturnValueOnce({ ...classifier, id: 'fallback' } as never);
    expect(selectPhysicalModel(runtime, [{ role: 'quality', primary: ref, fallback }], fallback, 'quality', scope('classifier'), 'classifier').intent.model).toBe('fallback');
    expect(() => selectPhysicalModel(runtime, mapping, ref, 'quality', scope('automatic'), 'classifier')).toThrow();
    expect(() => selectPhysicalModel(runtime, mapping, ref, 'quality', scope('classifier'), 'generation')).toThrow();
    expect(() => selectPhysicalModel(runtime, mapping, { ...ref, model: 'fallback' }, 'quality', scope('classifier'), 'classifier')).toThrow();
    expect(() => selectPhysicalModel(runtime, mapping, ref, 'transcription', scope('classifier'), 'classifier')).toThrow();
    expect(() => selectPhysicalModel(runtime, [...mapping, ...mapping], ref, 'quality', scope('classifier'), 'classifier')).toThrow();
    vi.mocked(runtime.getModelOfType).mockReturnValueOnce(undefined);
    expect(() => selectPhysicalModel(runtime, mapping, ref, 'quality', scope('classifier'), 'classifier')).toThrow();
    vi.mocked(runtime.getPhysicalModel).mockReturnValueOnce(undefined);
    expect(() => selectPhysicalModel(runtime, mapping, ref, 'quality', scope('automatic'), 'generation')).toThrow();
    vi.mocked(runtime.getPhysicalModel).mockReturnValueOnce({ ...chat, input: ['image'] } as never);
    expect(() => selectPhysicalModel(runtime, mapping, ref, 'quality', scope('automatic'), 'generation')).toThrow();
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
