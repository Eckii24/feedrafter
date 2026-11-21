import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';
const base = { DATABASE_URL: 'postgresql://localhost/test', APP_ORIGIN: 'http://localhost:3000' };
describe('configuration', () => {
  it('keeps optional FreshRSS disabled and rejects empty or malformed inputs', () => {
    expect(loadConfig(base).fresh).toBeUndefined();
    for (const env of [{ PORT: '' }, { PORT: '0' }, { APP_ORIGIN: 'http://user:secret@localhost/' }, { TRUSTED_PROXIES: '1.2.3.4/33' }, { FRESHRSS_ENABLED: 'true' }, { FRESHRSS_ENABLED: 'yes' }]) expect(() => loadConfig({ ...base, ...env })).toThrow();
  });
  it('requires every local processing acknowledgement and explicit nonnegative caps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feedrafter-local-'));
    try {
      const path = join(dir, 'key'); writeFileSync(path, 'synthetic-key\n', { mode: 0o600 });
      const env = { ...base, LOCAL_PROCESSING_ENABLED: 'true', LOCAL_EXCLUSIVE_DB_ACK: 'true', LOCAL_UNVERIFIED_SIZING_ACK: 'true', LOCAL_CODEX_COST_ACK: 'true', LOCAL_CLASSIFIER_DAILY: '10', LOCAL_CLASSIFIER_CONCURRENCY: '1', LOCAL_AUTOMATIC_DAILY: '5', LOCAL_AUTOMATIC_CONCURRENCY: '1', TYPESAFE_API_KEY_FILE: path };
      expect(loadConfig(base).localProcessing).toBeUndefined();
      expect(loadConfig(env).localProcessing).toEqual({ classifierDaily: 10, classifierConcurrency: 1, automaticDaily: 5, automaticConcurrency: 1, typesafeKey: 'synthetic-key' });
      for (const key of ['LOCAL_EXCLUSIVE_DB_ACK', 'LOCAL_UNVERIFIED_SIZING_ACK', 'LOCAL_CODEX_COST_ACK', 'LOCAL_CLASSIFIER_DAILY', 'LOCAL_CLASSIFIER_CONCURRENCY', 'LOCAL_AUTOMATIC_DAILY', 'LOCAL_AUTOMATIC_CONCURRENCY', 'TYPESAFE_API_KEY_FILE'] as const) expect(() => loadConfig({ ...env, [key]: '' })).toThrow();
      expect(() => loadConfig({ ...env, LOCAL_CLASSIFIER_DAILY: '-1' })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('validates optional Karakeep authority and exclusive secret sources', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feedrafter-karakeep-'));
    try {
      const path = join(dir, 'token'); writeFileSync(path, 'fixture-token\n');
      const env = { ...base, KARAKEEP_ENABLED: 'true', KARAKEEP_BASE_URL: 'http://127.0.0.1:3001', KARAKEEP_TOKEN_FILE: path };
      expect(loadConfig(base).karakeep).toBeUndefined();
      expect(loadConfig(env).karakeep).toEqual({ baseUrl: env.KARAKEEP_BASE_URL, token: 'fixture-token' });
      expect(loadConfig({ ...base, KARAKEEP_ENABLED: 'true', KARAKEEP_BASE_URL: 'https://keep.example', KARAKEEP_TOKEN: 'fixture-token' }).karakeep?.token).toBe('fixture-token');
      for (const patch of [{ KARAKEEP_TOKEN: 'other' }, { KARAKEEP_BASE_URL: 'https://keep.example/path' }, { KARAKEEP_BASE_URL: 'https://user@keep.example' }, { KARAKEEP_TOKEN_FILE: 'relative' }, { KARAKEEP_ENABLED: 'yes' }]) expect(() => loadConfig({ ...env, ...patch })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('loads an explicitly enabled FreshRSS secret file and rejects competing secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feedrafter-config-'));
    try {
      const path = join(dir, 'password'); writeFileSync(path, 'test-secret\n');
      const env = { ...base, FRESHRSS_ENABLED: 'true', FRESHRSS_BASE_URL: 'https://rss.example/api/greader.php', FRESHRSS_EMAIL: 'test', FRESHRSS_API_PASSWORD_FILE: path };
      expect(loadConfig(env).fresh?.password).toBe('test-secret');
      expect(() => loadConfig({ ...env, FRESHRSS_API_PASSWORD: 'other' })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
