import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { zstdDecompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPiCodexGenerator } from '../../src/server/adapters/pi/runtime.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { PostgresUsageAdmissionStore } from '../../src/server/adapters/postgres/usage-admission-store.js';
import { UsageService } from '../../src/server/application/usage.js';
import { systemClock } from '../../src/server/domain/clock.js';
import { createUsageDatabase } from '../helpers/usage-database.js';

const interception = vi.hoisted(() => ({ port: 0 }));
vi.mock('node:https', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:https')>();
  return { ...original, request: ((url: URL, options: import('node:https').RequestOptions, callback: (res: import('node:http').IncomingMessage) => void) => {
    if (url.href !== 'https://chatgpt.com/backend-api/codex/responses' || !interception.port) throw new Error('Unexpected external request');
    return original.request(new URL(`https://127.0.0.1:${interception.port}${url.pathname}`), { ...options, servername: 'chatgpt.com' }, callback);
  }) as typeof original.request };
});

const model = { provider: 'openai-codex', model: 'gpt-6-luna' };
const request = { model, role: 'summary' as const, system: 'system', user: 'hello' };
const scope = () => ({ bucket: 'automatic' as const, signal: new AbortController().signal });
const token = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fixture`;
const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let generator: Awaited<ReturnType<typeof createPiCodexGenerator>>;
let dir: string;
let server: ReturnType<typeof createServer>;
let restoreCreate: () => void;
let network: ReturnType<typeof vi.spyOn>;
let accepted = 0;
let lastPayload: Record<string, unknown>;
const pending: ServerResponse[] = [];
const waiting: Array<(response: ServerResponse) => void> = [];
const next = () => pending.length ? Promise.resolve(pending.shift()!) : new Promise<ServerResponse>(resolve => waiting.push(resolve));
const originalCAs = getCACertificates('default');
const rows = async () => (await db.pool.query('select status, input_tokens, output_tokens, cost_usd, cost_source from usage_ledger order by occurred_at, id')).rows;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pi-codex-'));
  const key = join(dir, 'key.pem'); const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=chatgpt.com', '-addext', 'subjectAltName=DNS:chatgpt.com'], { stdio: 'ignore' });
  setDefaultCACertificates([...originalCAs, readFileSync(cert, 'utf8')]);
  server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    accepted++; const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const bytes = Buffer.concat(chunks);
      lastPayload = JSON.parse((req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString()) as Record<string, unknown>;
      const resolve = waiting.shift(); if (resolve) resolve(res); else pending.push(res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  interception.port = (server.address() as AddressInfo).port;
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Unexpected network'); });
  const create = ModelRuntime.create.bind(ModelRuntime);
  const spy = vi.spyOn(ModelRuntime, 'create').mockImplementation(options => create({ ...options, authPath: join(dir, 'auth.json') }));
  restoreCreate = () => spy.mockRestore();
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: token, refresh: 'fixture-refresh', expires: 1, accountId: 'fixture-account' } }));
  db = await createUsageDatabase(); await migrateDatabase(db.pool);
  generator = await createPiCodexGenerator(new UsageService(new PostgresUsageAdmissionStore(db.pool, systemClock)), [{ role: 'summary', primary: model, fallback: null }]);
}, 30000);
afterAll(async () => {
  interception.port = 0; restoreCreate?.(); network?.mockRestore(); setDefaultCACertificates(originalCAs);
  server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await db?.dispose(); if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('dormant Codex OAuth generation', () => {
  it('refreshes through Pi and persists rotation; one admitted TLS inference send', async () => {
    const beforeRows = (await rows()).length;
    let rowsDuringRefresh = -1;
    network.mockImplementation(async (url: string | URL | Request) => {
      if (String(url) !== 'https://auth.openai.com/oauth/token') throw new Error('Unexpected network');
      rowsDuringRefresh = (await rows()).length;
      return Response.json({ access_token: token, refresh_token: 'rotated-fixture', expires_in: 3600 });
    });
    const before = accepted;
    const attempt = generator.generate(request, scope());
    const response = await next();
    expect(network).toHaveBeenCalledOnce(); expect(rowsDuringRefresh).toBe(beforeRows + 1);
    expect(lastPayload).toMatchObject({ model: 'gpt-6-luna', stream: true, store: false });
    expect(lastPayload).not.toHaveProperty('max_output_tokens'); expect(lastPayload).not.toHaveProperty('tools');
    expect(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))['openai-codex'].refresh).toBe('rotated-fixture');
    expect((await rows()).at(-1)).toMatchObject({ status: 'reserved' });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: 'private reasoning' }], encrypted_content: 'private metadata' };
    response.end(event({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: reasoning.id, summary: [] } })
      + event({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'private reasoning' })
      + event({ type: 'response.output_item.done', output_index: 0, item: reasoning })
      + event({ type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg', role: 'assistant', content: [] } })
      + event({ type: 'response.output_text.delta', output_index: 1, delta: 'hello' })
      + event({ type: 'response.done', response: { status: 'completed', output: [reasoning], usage: { input_tokens: 3, output_tokens: 2 } } }));
    expect(await attempt).toEqual({ kind: 'completed', value: { text: 'hello', usage: { inputTokens: 3, outputTokens: 2, costUsd: null } } });
    expect(accepted - before).toBe(1);
    expect((await rows()).at(-1)).toMatchObject({ status: 'succeeded', input_tokens: 3, output_tokens: 2, cost_usd: null, cost_source: 'unknown' });
  });
  it.each([
    ['tool call', { type: 'function_call', id: 'fc', call_id: 'call', name: 'unexpected', arguments: '{}' }],
    ['invalid reasoning', { type: 'reasoning', id: 'rs_invalid', summary: {} }],
  ])('rejects %s from Pi as uncertain', async (_label, item) => {
    const before = accepted; const count = (await rows()).length;
    const attempt = generator.generate(request, scope());
    const rejection = expect(attempt).rejects.toMatchObject({ kind: 'uncertain' });
    const response = await next(); response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(event({ type: 'response.output_item.added', output_index: 0, item })
      + event({ type: 'response.output_item.done', output_index: 0, item })
      + event({ type: 'response.done', response: { status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 2 } } }));
    await rejection;
    expect(accepted - before).toBe(1); expect((await rows()).length).toBe(count + 1);
    expect((await rows()).at(-1)).toMatchObject({ status: 'uncertain', input_tokens: 3, output_tokens: 2 });
  });
  it.each([
    { type: 'thinking', thinking: 42 },
    { type: 'thinking', thinking: 'private', thinkingSignature: 42 },
    { type: 'thinking', thinking: 'private', unexpected: true },
    { type: 'image', data: 'unexpected' },
  ])('rejects malformed or unexpected Pi block %#', async block => {
    const original = ModelRuntime.prototype.stream;
    const spy = vi.spyOn(ModelRuntime.prototype, 'stream').mockImplementation(function (this: ModelRuntime, ...args) {
      const stream = original.apply(this, args); const result = stream.result.bind(stream);
      stream.result = async () => { const message = await result(); message.content.push(block as never); return message; };
      return stream;
    });
    try {
      const before = accepted; const attempt = generator.generate(request, scope());
      const rejection = expect(attempt).rejects.toMatchObject({ kind: 'uncertain' });
      const response = await next(); response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(event({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg', role: 'assistant', content: [] } })
        + event({ type: 'response.output_text.delta', output_index: 0, delta: 'hello' })
        + event({ type: 'response.done', response: { status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 2 } } }));
      await rejection; expect(accepted - before).toBe(1);
      expect((await rows()).at(-1)).toMatchObject({ status: 'uncertain', input_tokens: 3, output_tokens: 2 });
    } finally { spy.mockRestore(); }
  });
  it.each([421, 302, 429, 500])('never replays or redirects HTTP %i', async status => {
    const before = accepted; const count = (await rows()).length;
    const attempt = generator.generate(request, scope());
    const rejection = expect(attempt).rejects.toMatchObject({ kind: 'provider' });
    const response = await next();
    expect((await rows()).at(-1)).toMatchObject({ status: 'reserved' });
    response.writeHead(status, { location: 'https://chatgpt.com/redirect', 'content-type': 'text/plain' }); response.end('fixture');
    await rejection;
    expect(accepted - before).toBe(1); expect((await rows()).length).toBe(count + 1);
  });
  it('treats a truncated stream as uncertain with unknown usage', async () => {
    const before = accepted; const count = (await rows()).length;
    const attempt = generator.generate(request, scope());
    const rejection = expect(attempt).rejects.toMatchObject({ kind: 'uncertain' });
    const response = await next(); response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(event({ type: 'response.output_text.delta', output_index: 0, delta: 'partial' }));
    await rejection;
    expect(accepted - before).toBe(1); expect((await rows()).length).toBe(count + 1);
    expect((await rows()).at(-1)).toMatchObject({ status: 'uncertain', input_tokens: null, output_tokens: null, cost_usd: null });
  });
  it('denies budget before inference or auth traffic', async () => {
    await db.pool.query("update budget_settings set daily_requests=0 where bucket='automatic'");
    try {
      const before = accepted; const count = (await rows()).length; network.mockClear();
      expect(await generator.generate(request, scope())).toEqual({ kind: 'paused_budget', reason: 'daily_limit' });
      expect(accepted).toBe(before); expect((await rows()).length).toBe(count); expect(network).not.toHaveBeenCalled();
    } finally { await db.pool.query("update budget_settings set daily_requests=2000 where bucket='automatic'"); }
  });
  it('rejects unsupported catalog model before reservation', async () => {
    const before = accepted; const count = (await rows()).length;
    const other = { provider: 'openai-codex', model: 'gpt-6-sol' };
    const capability = await createPiCodexGenerator(new UsageService(new PostgresUsageAdmissionStore(db.pool, systemClock)), [{ role: 'summary', primary: other, fallback: null }]);
    await expect(capability.generate({ ...request, model: other }, scope())).rejects.toThrow('route');
    expect(accepted).toBe(before); expect((await rows()).length).toBe(count);
  });
  it('sanitizes refresh failure and pauses subsequent attempts without inference', async () => {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: token, refresh: 'fixture-refresh', expires: 1, accountId: 'fixture-account' } }));
    network.mockClear(); network.mockImplementation(async (url: string | URL | Request) => {
      if (String(url) !== 'https://auth.openai.com/oauth/token') throw new Error('Unexpected network');
      return new Response('secret-fixture', { status: 401 });
    });
    const before = accepted; const count = (await rows()).length;
    await expect(generator.generate(request, scope())).rejects.toMatchObject({ kind: 'auth', message: 'Usage attempt auth' });
    expect(await generator.generate(request, scope())).toEqual({ kind: 'paused_auth' });
    expect(network).toHaveBeenCalledOnce(); expect(accepted).toBe(before); expect((await rows()).length).toBe(count + 1);
    expect((await rows()).at(-1)).toMatchObject({ status: 'failed', cost_usd: null });
  });
});
