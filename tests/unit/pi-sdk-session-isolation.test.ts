import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import { createEmptyResourceLoader } from '../../src/server/adapters/pi/resource-loader.js';

it('characterizes pinned Pi exact custom tools and empty resources across controlled restore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feedrafter-pi-session-'));
  const cwd = join(dir, 'project'); const agentDir = join(dir, 'agent'); const sessionDir = join(dir, 'sessions');
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network forbidden'); });
  const tool: ToolDefinition = {
    name: 'web_fetch', label: 'Fetch', description: 'fixture only', parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'fixture' }], details: {} }),
  };
  try {
    await mkdir(join(cwd, '.pi'), { recursive: true }); await mkdir(agentDir); await mkdir(sessionDir);
    await writeFile(join(cwd, 'AGENTS.md'), 'hostile instructions');
    await writeFile(join(cwd, '.pi', 'settings.json'), JSON.stringify({ defaultTools: ['bash'], cacheWarming: 'idle' }));
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const model = runtime.getPhysicalModel('openai', 'gpt-4.1-mini');
    expect(model).toBeDefined();
    if (!model) throw new Error('missing fixture model');
    const make = (sessionManager: SessionManager, tools: string[]) => createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, sessionManager,
      settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, transport: 'sse' }),
      resourceLoader: createEmptyResourceLoader('fixture system prompt'), tools, customTools: [tool],
    });
    const manager = SessionManager.create(cwd, sessionDir);
    const created = await make(manager, ['web_fetch']);
    expect(created.modelFallbackMessage).toBeUndefined();
    expect(created.session.getActiveToolNames()).toEqual(['web_fetch']);
    expect(created.session.getCallableToolNames()).toEqual(['web_fetch']);
    expect(created.session.settingsManager.getCacheWarmingMode()).toBe('off');
    expect(created.session.settingsManager.getCompactionEnabled()).toBe(false);
    expect(created.session.settingsManager.getRetryEnabled()).toBe(false);
    expect(created.session.settingsManager.getProviderRetrySettings().maxRetries).toBe(0);
    expect(created.session.settingsManager.getTransport()).toBe('sse');
    expect(created.session.systemPrompt).toContain('fixture system prompt');
    expect(created.session.systemPrompt).not.toContain('hostile instructions');
    manager.appendMessage({ role: 'user', content: 'fixture', timestamp: Date.now() });
    const file = manager.getSessionFile(); expect(file).toBeDefined();
    created.session.dispose();
    if (!file) throw new Error('missing fixture session');
    const restored = await make(SessionManager.open(file, sessionDir, cwd), ['web_fetch']);
    expect(restored.modelFallbackMessage).toBeUndefined();
    expect(restored.session.getActiveToolNames()).toEqual(['web_fetch']);
    expect(restored.session.getCallableToolNames()).toEqual(['web_fetch']);
    expect(restored.session.systemPrompt).not.toContain('hostile instructions');
    restored.session.dispose();
    // Supplying an explicit model suppresses Pi's restore fallback warning even
    // when the persisted branch selected a different, unavailable model.
    // An application restore boundary must validate the branch independently.
    const mismatched = SessionManager.open(file, sessionDir, cwd);
    mismatched.appendModelChange('missing-provider', 'missing-model');
    const overridden = await make(SessionManager.open(file, sessionDir, cwd), ['web_fetch']);
    expect(overridden.modelFallbackMessage).toBeUndefined();
    expect(overridden.session.model?.provider).toBe('openai');
    expect(overridden.session.model?.id).toBe('gpt-4.1-mini');
    overridden.session.dispose();
    const empty = await make(SessionManager.inMemory(cwd), []);
    expect(empty.session.getActiveToolNames()).toEqual([]);
    expect(empty.session.getCallableToolNames()).toEqual([]);
    empty.session.dispose();
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});
