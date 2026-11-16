import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { normalizeContext } from '@earendil-works/pi-ai';
import { expect, it, vi } from 'vitest';
import { createPiSessionFactory } from '../../src/server/adapters/pi/sessions.js';

const observed = vi.hoisted(() => ({ created: undefined as import('@earendil-works/pi-coding-agent').CreateAgentSessionResult | undefined }));
vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return { ...actual, createAgentSession: async (...args: Parameters<typeof actual.createAgentSession>) => {
    const result = await actual.createAgentSession(...args); observed.created = result; return result;
  } };
});

const model = { provider: 'openai', model: 'gpt-4.1-mini' };
const options = { model, role: 'summary' as const, system: 'fixture' };
const scope = () => ({ bucket: 'automatic' as const, signal: new AbortController().signal });

it('constructs an isolated session but fails closed for dispatch and compaction', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network forbidden'); });
  try {
    const factory = await createPiSessionFactory([{ role: 'summary', primary: model, fallback: null }]);
    const result = await factory.createRestrictedSession(options, scope());
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('expected session');
    const session = result.value;
    const sdk = observed.created?.session;
    if (!sdk || !sdk.model) throw new Error('expected SDK session');
    expect(sdk.getActiveToolNames()).toEqual([]);
    expect(sdk.getCallableToolNames()).toEqual([]);
    expect(sdk.settingsManager.getCacheWarmingMode()).toBe('off');
    expect(sdk.settingsManager.getCompactionEnabled()).toBe(false);
    expect(sdk.settingsManager.getRetryEnabled()).toBe(false);
    expect(sdk.settingsManager.getProviderRetrySettings().maxRetries).toBe(0);
    expect(sdk.settingsManager.getTransport()).toBe('sse');
    expect(sdk.systemPrompt).toContain('fixture');
    // Even an accidental internal SDK dispatch cannot reach its original producer.
    const guarded = await sdk.agent.streamFunction(sdk.model, normalizeContext({ messages: [] }));
    expect((await guarded.result()).errorMessage).toBe('Invocation failed');
    expect(Object.keys(session).sort()).toEqual(['abort', 'compact', 'dispose', 'prompt']);
    expect(await session.prompt('hello', scope())).toEqual({ kind: 'paused_configuration' });
    expect(await session.compact(scope())).toEqual({ kind: 'paused_configuration' });
    await session.dispose(); await session.dispose();
    await expect(session.prompt('hello', scope())).rejects.toThrow();
    await expect(factory.createRestrictedSession({ ...options, model: { ...model, model: 'other' } }, scope())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});

it('validates the selected branch before the SDK explicit model can mask a restored mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feedrafter-session-restore-'));
  const sessions = join(dir, 'sessions'); await mkdir(sessions);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network forbidden'); });
  try {
    const manager = SessionManager.create(dir, sessions);
    manager.appendModelChange(model.provider, model.model);
    manager.appendMessage({ role: 'user', content: 'fixture', timestamp: Date.now() });
    const file = manager.getSessionFile();
    if (!file) throw new Error('missing fixture file');
    const factory = await createPiSessionFactory([{ role: 'summary', primary: model, fallback: null }]);
    // Test seam only: production uses in-memory sessions and accepts no path.
    const inMemory = vi.spyOn(SessionManager, 'inMemory').mockImplementation(() => SessionManager.open(file, sessions, dir));
    const restored = await factory.createRestrictedSession(options, scope());
    expect(restored.kind).toBe('completed');
    if (restored.kind === 'completed') await restored.value.dispose();
    const mismatch = SessionManager.open(file, sessions, dir);
    mismatch.appendModelChange('missing-provider', 'missing-model');
    await expect(factory.createRestrictedSession(options, scope())).rejects.toThrow('Session model mismatch');
    const noSelection = SessionManager.create(dir, sessions);
    noSelection.appendMessage({ role: 'user', content: 'fixture', timestamp: Date.now() });
    const missingFile = noSelection.getSessionFile();
    if (!missingFile) throw new Error('missing second fixture file');
    inMemory.mockImplementationOnce(() => SessionManager.open(missingFile, sessions, dir));
    await expect(factory.createRestrictedSession(options, scope())).rejects.toThrow('Session model mismatch');
    expect(fetch).not.toHaveBeenCalled();
    inMemory.mockRestore();
  } finally { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); }
});
