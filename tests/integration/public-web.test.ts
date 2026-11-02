import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { getCACertificates, setDefaultCACertificates, type TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicWeb, pinnedTransport } from '../../src/server/adapters/web/request.js';

const key = readFileSync('tests/fixtures/public-web/test-key.pem');
const cert = readFileSync('tests/fixtures/public-web/test-cert.pem');
const originalCAs = getCACertificates('default');
const requests: Array<{ host: string | undefined; cookie: string | undefined; authorization: string | undefined; encoding: string | undefined }> = [];
let sni: string | false | null = false;
const http = createHttpServer((req, res) => {
  requests.push({ host: req.headers.host, cookie: req.headers.cookie, authorization: req.headers.authorization, encoding: req.headers['accept-encoding'] });
  if (req.url === '/broken') { res.writeHead(200, { 'content-length': '100' }); res.write('partial'); setImmediate(() => res.destroy()); return; }
  if (req.url === '/redirect') { res.writeHead(302, { location: 'http://second.example/final', 'set-cookie': 'secret=fixture' }); res.end(); return; }
  res.end('fixture');
});
const https = createHttpsServer({ key, cert }, (req, res) => {
  sni = (req.socket as TLSSocket).servername;
  requests.push({ host: req.headers.host, cookie: req.headers.cookie, authorization: req.headers.authorization, encoding: req.headers['accept-encoding'] });
  res.end('secure fixture');
});
const listen = (server: typeof http | typeof https) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
let httpPort: number; let httpsPort: number;
beforeAll(async () => { [httpPort, httpsPort] = await Promise.all([listen(http), listen(https)]); setDefaultCACertificates([...originalCAs, cert.toString()]); });
afterAll(async () => { setDefaultCACertificates(originalCAs); await Promise.all([new Promise<void>(resolve => http.close(() => resolve())), new Promise<void>(resolve => https.close(() => resolve()))]); });

describe('local pinned transport', () => {
  it('connects to the pinned address and sends hostname Host without credentials', async () => {
    const url = new URL(`http://fixture.example:${httpPort}/`);
    const response = await pinnedTransport(url, '127.0.0.1', AbortSignal.timeout(2000));
    const chunks: Buffer[] = []; for await (const chunk of response.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('fixture');
    expect(requests.at(-1)).toEqual({ host: `fixture.example:${httpPort}`, cookie: undefined, authorization: undefined, encoding: 'gzip, deflate, br' });
  });
  it('preserves TLS SNI and verifies hostname and certificate', async () => {
    const response = await pinnedTransport(new URL(`https://fixture.example:${httpsPort}/`), '127.0.0.1', AbortSignal.timeout(2000));
    for await (const chunk of response.body) { void chunk; }
    expect(sni).toBe('fixture.example');
    expect(requests.at(-1)?.host).toBe(`fixture.example:${httpsPort}`);
    await expect(pinnedTransport(new URL(`https://wrong.example:${httpsPort}/`), '127.0.0.1', AbortSignal.timeout(2000))).rejects.toThrow();
  });
  it('does not forward cookies or authorization across redirects', async () => {
    requests.length = 0;
    const resolved: string[] = [];
    const web = createPublicWeb({ resolver: async host => { resolved.push(host); return ['8.8.8.8']; }, transport: async (url, _address, signal) => {
      const local = new URL(url); local.port = String(httpPort);
      return pinnedTransport(local, '127.0.0.1', signal);
    } });
    expect((await web.get('http://fixture.example/redirect')).body.toString()).toBe('fixture');
    expect(resolved).toEqual(['fixture.example', 'second.example']);
    expect(requests).toHaveLength(2);
    expect(requests.map(request => [request.host, request.cookie, request.authorization])).toEqual([
      [`fixture.example:${httpPort}`, undefined, undefined], [`second.example:${httpPort}`, undefined, undefined],
    ]);
  });
  it('does not report a prematurely closed response as success', async () => {
    const web = createPublicWeb({ resolver: async () => ['8.8.8.8'], transport: async (url, _address, signal) => {
      const local = new URL(url); local.port = String(httpPort);
      return pinnedTransport(local, '127.0.0.1', signal);
    } });
    await expect(web.get('http://fixture.example/broken')).rejects.toThrow();
  });
});
