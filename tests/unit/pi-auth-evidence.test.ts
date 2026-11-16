import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ModelsError } from '@earendil-works/pi-ai';
import { expect, it, vi } from 'vitest';
import type { UsageService } from '../../src/server/application/usage.js';
import { createPiClassifier, createPiGenerator } from '../../src/server/adapters/pi/runtime.js';

it('retains only typed auth evidence through Pi-style error conversion for both capabilities', async () => {
  const getAuth = vi.fn();
  const c = { id: 'jev-latest', provider: 'typesafe', type: 'classifier', api: 'typesafe-system-one', baseUrl: 'https://api.typesafe.ai/v1', input: ['text'] };
  const g = { id: 'gpt-4.1-mini', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', input: ['text'] };
  const runtime = {
    getAuth, getError: () => undefined, listCredentials: async () => [], getProviderAuthStatus: () => ({ configured: true }),
    getModelOfType: () => c, getPhysicalModel: () => g,
    async classify() { try { await runtime.getAuth(); } catch { return { stopReason: 'error', errorMessage: 'flattened secret' }; } },
    stream() { return { async result() { try { await runtime.getAuth(); } catch { return { stopReason: 'error', errorMessage: 'flattened secret', content: [] }; } } }; },
  };
  const create = vi.spyOn(ModelRuntime, 'create').mockResolvedValue(runtime as unknown as ModelRuntime);
  let observed: unknown;
  const usage = { async executeAttempt(_intent: unknown, scope: { signal: AbortSignal }, invoke: (signal: AbortSignal, permit: { consume(): void }) => Promise<unknown>) {
    observed = await invoke(scope.signal, { consume() {} }); return { kind: 'paused_auth' };
  } } as unknown as UsageService;
  try {
    const classifier = await createPiClassifier(usage, [{ role: 'quality', primary: { provider: c.provider, model: c.id }, fallback: null }]);
    const generator = await createPiGenerator(usage, [{ role: 'summary', primary: { provider: g.provider, model: g.id }, fallback: null }]);
    const cs = { bucket: 'classifier' as const, signal: new AbortController().signal };
    const gs = { bucket: 'automatic' as const, signal: new AbortController().signal };
    const classification = { model: { provider: c.provider, model: c.id }, role: 'quality' as const, state: {}, questions: { b: { type: 'bool' as const, instructions: '', criteria: { true: '', false: '' } } } };
    const generation = { model: { provider: g.provider, model: g.id }, role: 'summary' as const, system: '', user: '' };
    for (const code of ['auth', 'oauth'] as const) {
      getAuth.mockRejectedValue(new ModelsError(code, 'private-fixture-secret'));
      await classifier.classify(classification, cs);
      expect(observed).toMatchObject({ kind: 'failure', failureKind: 'auth', terminal: { status: 'failed', outcomeCode: 'provider_auth' } });
      expect(JSON.stringify(observed)).not.toContain('secret');
      await generator.generate(generation, gs);
      expect(observed).toMatchObject({ kind: 'failure', failureKind: 'auth', terminal: { status: 'failed', outcomeCode: 'provider_auth' } });
      expect(JSON.stringify(observed)).not.toContain('secret');
    }
    getAuth.mockRejectedValue(new Error('private-fixture-secret'));
    await classifier.classify(classification, cs); expect(observed).toMatchObject({ kind: 'uncertain' });
    await generator.generate(generation, gs); expect(observed).toMatchObject({ kind: 'uncertain' });
  } finally { create.mockRestore(); }
});
