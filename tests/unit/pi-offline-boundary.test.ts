import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import { createPiClassifier } from '../../src/server/adapters/pi/classifier.js';
import type { UsageService } from '../../src/server/application/usage.js';

it('preflights the real private Pi runtime offline without credential resolution or commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feedrafter-pi-offline-'));
  const originalKey = process.env.TYPESAFE_API_KEY;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network forbidden'); });
  const connect = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => { throw new Error('network forbidden'); });
  const commands = (['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'] as const)
    .map(name => vi.spyOn(childProcess, name).mockImplementation(() => { throw new Error('commands forbidden'); }));
  syncBuiltinESMExports();
  const checkAuth = vi.spyOn(ModelRuntime.prototype, 'checkAuth').mockImplementation(() => { throw new Error('auth check forbidden'); });
  const getAuth = vi.spyOn(ModelRuntime.prototype, 'getAuth').mockImplementation(() => { throw new Error('auth resolution forbidden'); });
  const refresh = vi.spyOn(ModelRuntime.prototype, 'refresh').mockImplementation(() => { throw new Error('refresh forbidden'); });
  const create = ModelRuntime.create.bind(ModelRuntime);
  const createSpy = vi.spyOn(ModelRuntime, 'create').mockImplementation(options => create({ ...options, authPath: join(dir, 'auth.json') }));
  const usage = { executeAttempt: vi.fn(async () => ({ kind: 'paused_budget', reason: 'daily_limit' })) } as unknown as UsageService;
  const model = { provider: 'typesafe', model: 'jev-latest' };
  const input = { model, role: 'quality' as const, state: {}, questions: { b: { type: 'bool' as const, instructions: '', criteria: { true: '', false: '' } } } };
  const scope = { bucket: 'classifier' as const, signal: new AbortController().signal };
  try {
    delete process.env.TYPESAFE_API_KEY;
    const classifier = await createPiClassifier(usage, [{ role: 'quality', primary: model, fallback: null }]);
    expect(await classifier.classify(input, scope)).toEqual({ kind: 'paused_auth' });
    process.env.TYPESAFE_API_KEY = '  \t';
    expect(await classifier.classify(input, scope)).toEqual({ kind: 'paused_auth' });
    process.env.TYPESAFE_API_KEY = 'fixture-only-key';
    expect(await classifier.classify(input, scope)).toEqual({ kind: 'paused_budget', reason: 'daily_limit' });
    expect(usage.executeAttempt).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
    expect(checkAuth).not.toHaveBeenCalled(); expect(getAuth).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
    for (const command of commands) expect(command).not.toHaveBeenCalled();
  } finally {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = originalKey;
    createSpy.mockRestore(); checkAuth.mockRestore(); getAuth.mockRestore(); refresh.mockRestore(); fetch.mockRestore(); connect.mockRestore();
    for (const command of commands) command.mockRestore();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});
