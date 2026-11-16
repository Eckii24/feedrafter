import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { KarakeepClient } from '../../src/server/adapters/karakeep/client.js';

const original = 'https://article.example/story?next=https%3A%2F%2Fevil.example%2F#part';
const bookmark = { id: 'bookmark-1', content: { type: 'link', url: original } };
const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  })));
});

describe('Karakeep preparatory client', () => {
  it.each(['https://user:pass@example.com', 'https://example.com/path', 'https://example.com?', 'https://example.com#', 'https://example.com\\@evil.test', 'ftp://example.com', 'https://example.com/../', 'https://example.com /'])('rejects non-authority base %s', baseUrl => {
    expect(() => new KarakeepClient({ baseUrl, token: 'token' })).toThrow('Invalid Karakeep configuration');
  });
  it.each(['', 'bad token', 'token\r\nX-Foo: bar'])('rejects invalid token %j', token => {
    expect(() => new KarakeepClient({ baseUrl: 'https://example.com', token })).toThrow('Invalid Karakeep configuration');
  });
  it('sends only original URL and bearer token to the fixed configured authority', async () => {
    const requests: Array<{ url: string; method: string; auth: string | undefined; body: string }> = [];
    const baseUrl = await listen(createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += String(chunk);
      requests.push({ url: req.url!, method: req.method!, auth: req.headers.authorization, body });
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.method === 'POST' ? bookmark : { exists: false }));
    }));
    const client = new KarakeepClient({ baseUrl, token: 'secret-token' });
    expect(await client.create(original)).toEqual({ kind: 'created', bookmark: { id: 'bookmark-1', url: original } });
    expect(await client.checkUrl(original)).toEqual({ kind: 'uncertain' });
    expect(requests[0]).toEqual({ url: '/api/v1/bookmarks', method: 'POST', auth: 'Bearer secret-token', body: JSON.stringify({ type: 'link', url: original }) });
    const lookup = new URL(requests[1]!.url, baseUrl);
    expect(lookup.pathname).toBe('/api/v1/bookmarks/check-url');
    expect([...lookup.searchParams]).toEqual([['url', original]]);
    expect(requests[1]).toMatchObject({ method: 'GET', auth: 'Bearer secret-token', body: '' });
  });
  it.each(['//evil.test/path', 'https://user:secret@evil.test/', 'file:///etc/passwd', 'https://good.test/\r\nX', ' https://good.test/'])('rejects invalid original URL without transport %j', async originalUrl => {
    let calls = 0;
    const client = new KarakeepClient({ baseUrl: 'http://localhost', token: 'token', transport: async () => { calls++; return new Response(); } });
    await expect(client.create(originalUrl)).rejects.toThrow('Invalid original URL');
    expect(calls).toBe(0);
  });
  it('does not follow redirects or leak credentials to a second authority', async () => {
    let leaked = false;
    const destination = await listen(createServer((_req, res) => { leaked = true; res.end(); }));
    const baseUrl = await listen(createServer((_req, res) => { res.writeHead(307, { Location: destination }); res.end(); }));
    const client = new KarakeepClient({ baseUrl, token: 'secret' });
    expect(await client.create(original)).toEqual({ kind: 'uncertain' });
    expect(await client.checkUrl(original)).toEqual({ kind: 'uncertain' });
    expect(leaked).toBe(false);
  });
  it.each([
    [200, bookmark, 'existing'], [201, bookmark, 'created'],
    [202, bookmark, 'uncertain'], [404, {}, 'uncertain'], [200, {}, 'uncertain'],
    [201, { ...bookmark, id: '' }, 'uncertain'], [201, { ...bookmark, id: 42 }, 'uncertain'],
    [201, { ...bookmark, content: { type: 'text', url: original } }, 'uncertain'],
    [201, { ...bookmark, content: { type: 'link', url: 'https://other.example' } }, 'uncertain'],
    [201, { ...bookmark, content: { type: 'link', url: original.split('#')[0] } }, 'uncertain'],
  ])('validates create status %s and response %j', async (status, value, kind) => {
    const client = new KarakeepClient({ baseUrl: 'https://configured.test', token: 'token', transport: async () => Response.json(value, { status: status as number }) });
    expect((await client.create(original)).kind).toBe(kind);
  });
  it.each([401, 403])('reports auth error for status %s without relying on a JSON body', async status => {
    const client = new KarakeepClient({ baseUrl: 'https://configured.test', token: 'token', transport: async () => new Response(null, { status }) });
    expect(await client.create(original)).toEqual({ kind: 'auth_error' });
    expect(await client.checkUrl(original)).toEqual({ kind: 'auth_error' });
  });
  it.each([
    [200, { exists: true, bookmark }], [200, { exists: false }], [200, bookmark],
    [200, {}], [404, { exists: false }], [500, { exists: false }],
  ])('never infers lookup presence or absence from status %s and body %j', async (status, body) => {
    const client = new KarakeepClient({ baseUrl: 'https://configured.test', token: 'token', transport: async () => Response.json(body, { status: status as number }) });
    expect(await client.checkUrl(original)).toEqual({ kind: 'uncertain' });
  });
  it('returns uncertain for invalid JSON and oversized response', async () => {
    for (const body of ['{', 'x'.repeat(1024 * 1024 + 1)]) {
      const client = new KarakeepClient({ baseUrl: 'https://configured.test', token: 'token', transport: async () => new Response(body, { status: 201 }) });
      expect(await client.create(original)).toEqual({ kind: 'uncertain' });
    }
  });
  it('bounds stalled requests and respects caller cancellation', async () => {
    const baseUrl = await listen(createServer(() => {}));
    const client = new KarakeepClient({ baseUrl, token: 'token', timeoutMs: 30 });
    expect(await client.create(original)).toEqual({ kind: 'uncertain' });
    const controller = new AbortController(); controller.abort();
    expect(await client.checkUrl(original, controller.signal)).toEqual({ kind: 'uncertain' });
  });
  it('times out while reading a response body', async () => {
    const baseUrl = await listen(createServer((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.write('{');
    }));
    const client = new KarakeepClient({ baseUrl, token: 'token', timeoutMs: 50 });
    expect(await client.create(original)).toEqual({ kind: 'uncertain' });
  });
});
