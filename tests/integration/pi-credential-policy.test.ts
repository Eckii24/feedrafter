import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPiClassifier } from '../../src/server/adapters/pi/runtime.js';
import type { UsageService } from '../../src/server/application/usage.js';
import { loadConfig } from '../../src/server/config.js';

it('uses the required TypeSafe file, never executes copied commands, and preserves Pi OAuth rotation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-policy-'));
  const authPath = join(dir, 'auth.json'); const secretPath = join(dir, 'typesafe'); const marker = join(dir, 'executed');
  const oldKey = process.env.TYPESAFE_API_KEY;
  const token = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.fixture`;
  writeFileSync(secretPath, 'file-key\n', { mode: 0o600 });
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/test', APP_ORIGIN: 'http://localhost:3000', LOCAL_PROCESSING_ENABLED: 'true', LOCAL_EXCLUSIVE_DB_ACK: 'true', LOCAL_UNVERIFIED_SIZING_ACK: 'true', LOCAL_CODEX_COST_ACK: 'true', LOCAL_CLASSIFIER_DAILY: '1', LOCAL_CLASSIFIER_CONCURRENCY: '1', LOCAL_AUTOMATIC_DAILY: '1', LOCAL_AUTOMATIC_CONCURRENCY: '1', TYPESAFE_API_KEY_FILE: secretPath });
  process.env.TYPESAFE_API_KEY = config.localProcessing!.typesafeKey;
  writeFileSync(authPath, JSON.stringify({ typesafe: { type: 'api_key', key: 'conflicting-key' }, openai: { type: 'api_key', key: `!touch ${marker}` }, 'openai-codex': { type: 'oauth', access: token, refresh: 'fixture-refresh', expires: 1, accountId: 'fixture' } }));
  let runtime: ModelRuntime | undefined;
  const create = ModelRuntime.create.bind(ModelRuntime);
  const spy = vi.spyOn(ModelRuntime, 'create').mockImplementation(async options => runtime = await create({ ...options, authPath }));
  const logs = (['log', 'warn', 'error'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}));
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url) !== 'https://auth.openai.com/oauth/token') throw new Error('Unexpected network');
    return Response.json({ access_token: token, refresh_token: 'fixture-rotated', expires_in: 3600 });
  });
  try {
    await createPiClassifier({} as UsageService, []);
    expect((await runtime!.getAuth('typesafe'))?.auth.apiKey).toBe('file-key');
    await expect(runtime!.getAuth('openai')).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
    const stored = JSON.parse(readFileSync(authPath, 'utf8'));
    stored.typesafe.key = `!touch ${marker}`;
    writeFileSync(authPath, JSON.stringify(stored));
    expect((await runtime!.getAuth('typesafe'))?.auth.apiKey).toBe('file-key');
    expect(existsSync(marker)).toBe(false);
    expect((await runtime!.getAuth('openai-codex'))?.source).toBe('OAuth');
    expect(network).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(authPath, 'utf8'))['openai-codex'].refresh).toBe('fixture-rotated');
    expect(existsSync(marker)).toBe(false);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore(); network.mockRestore(); for (const log of logs) log.mockRestore();
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
    rmSync(dir, { recursive: true, force: true });
  }
});
