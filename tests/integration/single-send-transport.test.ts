import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSingleSendFetch } from '../../src/server/adapters/pi/single-send-transport.js';

const listen = (server: Server) => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
const close = (server: Server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
const permit = () => { let count = 0; return { consume() { if (count++) throw new Error('permit used'); }, count: () => count }; };
const transport = (url: string, p = permit(), signal = new AbortController().signal, maxResponseBytes = 1024, timeoutMs = 2000) => createSingleSendFetch({ url, permit: p, signal, maxResponseBytes, timeoutMs });
const post = { method: 'POST' };
let base: string; let target: string; let secure: string;
let requests = 0; let targets = 0;
let received: { host: string | undefined; auth: string | undefined; contentType: string | undefined; body: string };
let held: ServerResponse | undefined;
let firstChunk!: () => void;
const server = createServer((req, res) => {
  requests++;
  if (req.url === '/redirect') { res.writeHead(302, { location: `${target}/stolen` }); res.end(); return; }
  if (req.url?.startsWith('/status/')) { res.writeHead(Number(req.url.split('/')[2])); res.end('status'); return; }
  if (req.url === '/abort') { held = res; return; }
  if (req.url === '/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: one\n\n'); held = res; firstChunk(); return; }
  if (req.url === '/overflow') { res.end('0123456789'); return; }
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => { received = { host: req.headers.host, auth: req.headers.authorization, contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString() }; res.end('ok'); });
});
const destination = createServer((_req, res) => { targets++; res.end(); });
let tlsServer: ReturnType<typeof createSecureServer>;
let directory: string;
const originalCAs = getCACertificates('default');
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'single-send-tls-'));
  const key = join(directory, 'key.pem'); const cert = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  tlsServer = createSecureServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) => { requests++; res.end('secure'); });
  [base, target, secure] = await Promise.all([listen(server), listen(destination), listen(tlsServer)]);
  secure = secure.replace('http:', 'https:');
  setDefaultCACertificates([...originalCAs, readFileSync(cert, 'utf8')]);
});
afterAll(async () => { held?.destroy(); setDefaultCACertificates(originalCAs); await Promise.all([close(server), close(destination), close(tlsServer)]); rmSync(directory, { recursive: true, force: true }); });

describe('single-send transport', () => {
  it('validates route and method before permit and wire, then preserves request and rejects another call', async () => {
    const p = permit(); const url = `${base}/v1?x=1`; const send = transport(url, p); const before = requests;
    await expect(send(`${base}/v1?x=2`, post)).rejects.toThrow('route');
    await expect(send(url)).rejects.toThrow('route');
    expect(p.count()).toBe(0); expect(requests).toBe(before);
    const response = await send(url, { method: 'POST', headers: { host: 'evil.example', authorization: 'Bearer secret', 'content-type': 'application/json' }, body: '{"hi":1}' });
    expect(send.bodyCompleted).toBe(false);
    expect(await response.text()).toBe('ok');
    expect(send.bodyCompleted).toBe(true);
    expect(received).toEqual({ host: new URL(base).host, auth: 'Bearer secret', contentType: 'application/json', body: '{"hi":1}' });
    await expect(send(url, post)).rejects.toThrow('already used');
    expect(p.count()).toBe(1); expect(requests - before).toBe(1);
  });
  it('keeps a completed receipt after cleanup abort and never completes a cancelled body', async () => {
    const controller = new AbortController(); const url = `${base}/v1`; const send = transport(url, permit(), controller.signal);
    expect(await (await send(url, post)).text()).toBe('ok');
    expect(send.bodyCompleted).toBe(true); controller.abort(); expect(send.bodyCompleted).toBe(true);
    const streamUrl = `${base}/stream`; const started = new Promise<void>(resolve => { firstChunk = resolve; });
    const cancelled = transport(streamUrl); const response = await cancelled(streamUrl, post); await started;
    const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
    expect(cancelled.bodyCompleted).toBe(false);
  });
  it('does not open a connection when the signal or permit is unavailable', async () => {
    const before = requests; const url = `${base}/v1`; const p = permit();
    const controller = new AbortController(); controller.abort();
    await expect(transport(url, p, controller.signal)(url, post)).rejects.toThrow();
    expect(p.count()).toBe(0);
    await expect(transport(url, { ...p, consume() { throw new Error('revoked'); } })(url, post)).rejects.toThrow('revoked');
    expect(requests).toBe(before);
  });
  it('does not follow redirects', async () => {
    const before = requests; const previous = targets; const url = `${base}/redirect`;
    expect((await transport(url)(url, post)).status).toBe(302);
    expect(requests - before).toBe(1); expect(targets).toBe(previous);
  });
  it.each([421, 429, 500, 503])('returns %i without retry', async status => {
    const url = `${base}/status/${status}`; const before = requests;
    const response = await transport(url)(url, post); expect(response.status).toBe(status); await response.text();
    expect(requests - before).toBe(1);
  });
  it('terminates an aborted request and a timeout without retry', async () => {
    for (const timeout of [false, true]) {
      const controller = new AbortController(); const url = `${base}/abort`; const before = requests;
      const pending = transport(url, permit(), controller.signal, 1024, timeout ? 100 : 2000)(url, post);
      if (!timeout) { while (requests === before) await new Promise(resolve => setTimeout(resolve, 1)); controller.abort(); }
      await expect(pending).rejects.toThrow(); expect(requests - before).toBe(1);
    }
  });
  it('bounds response bytes without retry', async () => {
    const url = `${base}/overflow`; const before = requests;
    const send = transport(url, permit(), undefined, 5);
    const response = await send(url, post);
    await expect(response.text()).rejects.toThrow('exceeds limit'); expect(send.bodyCompleted).toBe(false); expect(requests - before).toBe(1);
  });
  it('streams SSE before completion and enforces the cumulative limit', async () => {
    const url = `${base}/stream`; const started = new Promise<void>(resolve => { firstChunk = resolve; }); const before = requests;
    const response = await transport(url, permit(), undefined, 15)(url, post); await started;
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: one\n\n');
    held!.write('data: two\n\n');
    await expect(reader.read()).rejects.toThrow('exceeds limit'); expect(requests - before).toBe(1);
  });
  it('aborts a response stream after headers without retry', async () => {
    const controller = new AbortController(); const url = `${base}/stream`; const before = requests;
    const started = new Promise<void>(resolve => { firstChunk = resolve; });
    const response = await transport(url, permit(), controller.signal)(url, post); await started;
    const reader = response.body!.getReader(); await reader.read();
    const pending = reader.read(); controller.abort();
    await expect(pending).rejects.toThrow(); expect(requests - before).toBe(1);
  });
  it('uses verified TLS and rejects an untrusted certificate', async () => {
    const url = `${secure}/v1`; const before = requests;
    expect(await (await transport(url)(url, post)).text()).toBe('secure');
    setDefaultCACertificates(originalCAs);
    try { await expect(transport(url)(url, post)).rejects.toThrow(); }
    finally { setDefaultCACertificates([...originalCAs, readFileSync(join(directory, 'cert.pem'), 'utf8')]); }
    expect(requests - before).toBe(1);
  });
});
