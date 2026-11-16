import { get } from 'node:http';
import { describe, expect, it } from 'vitest';
import { buildHttpApp, type HttpDependencies } from '../../src/server/http/app.js';

const deps = { db: {}, pool: { query: async () => ({ rows: [{ ready: true }] }) }, origin: 'http://localhost:3000', trustedProxies: [] } as unknown as HttpDependencies;
describe('HTTP security and contracts', () => {
  it('rejects untrusted hosts, origins, cross-site and non-JSON writes', async () => {
    const app = await buildHttpApp(deps);
    try {
      const url = '/api/v1/articles/00000000-0000-4000-8000-000000000001';
      expect((await app.inject({ url: '/api/v1/health/live', headers: { host: 'attacker.test' } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/v1/health/live', headers: { host: 'localhost:3000', origin: 'http://attacker.test' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PATCH', url, headers: { host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }, payload: { isRead: true } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PATCH', url, headers: { host: 'localhost:3000', 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url, headers: { host: 'localhost:3000' }, payload: { isRead: true, surprise: 1 } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url, headers: { host: 'localhost:3000' }, payload: { isRead: 'true' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/v1/pipeline/runs', headers: { host: 'localhost:3000' }, payload: {} })).statusCode).toBe(503);
      const shell = await app.inject({ url: '/', headers: { host: 'localhost:3000' } });
      expect(shell.statusCode).toBe(200);
      expect(shell.body).toContain('<div id="root"></div>');
      expect(shell.headers['content-security-policy']).toContain("script-src 'self'");
      expect((await app.inject({ url: '/api/v1/not-a-route', headers: { host: 'localhost:3000' } })).statusCode).toBe(404);
      const health = await app.inject({ url: '/api/v1/health/live', headers: { host: 'localhost:3000' } });
      expect(health.statusCode).toBe(200);
      expect(health.headers['content-security-policy']).toContain("object-src 'none'");
      expect(health.headers['access-control-allow-origin']).toBeUndefined();
      const openapi = await app.inject({ url: '/api/v1/openapi.json', headers: { host: 'localhost:3000' } });
      expect(openapi.statusCode).toBe(200);
      expect(openapi.json().paths['/api/v1/articles']).toBeDefined();
    } finally { await app.close(); }
  });
  it('rejects malformed source-permission writes before database access', async () => {
    let queries = 0;
    const app = await buildHttpApp({ ...deps, pool: { query: async () => { queries++; throw new Error('unexpected database access'); } } } as unknown as HttpDependencies);
    const headers = { host: 'localhost:3000' };
    const id = '00000000-0000-4000-8000-000000000001';
    try {
      for (const [url, payload] of [
        [`/api/v1/sources/${id}/fallback-permission`, { override: 'false' }],
        [`/api/v1/sources/${id}/fallback-permission`, { override: null, extra: true }],
        ['/api/v1/sources/bad/fallback-permission', { override: true }],
      ] as const) expect((await app.inject({ method: 'PATCH', url, headers, payload })).statusCode).toBe(400);
      for (const payload of [{ host: 'example.com', allowed: 'true' }, { host: 'example.com', allowed: true, extra: true }, { host: '*.example.com', allowed: true }]) {
        expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/source-permissions/host', headers, payload })).statusCode).toBe(400);
      }
      expect(queries).toBe(0);
    } finally { await app.close(); }
  });
  it('bounds live SSE clients and accepts a replacement after disconnect', async () => {
    const app = await buildHttpApp(deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const responses: import('node:http').IncomingMessage[] = [];
    const connect = () => new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      get({ host: '127.0.0.1', port: address.port, path: '/api/v1/events', headers: { host: 'localhost:3000' } }, resolve).on('error', reject);
    });
    try {
      for (let i = 0; i < 100; i++) {
        const response = await connect(); responses.push(response);
        expect(response.statusCode).toBe(200);
      }
      const rejected = await connect();
      expect(rejected.statusCode).toBe(503);
      rejected.resume();
      responses.pop()!.destroy();
      let replacement: import('node:http').IncomingMessage | undefined;
      for (let i = 0; i < 50; i++) {
        const response = await connect();
        if (response.statusCode === 200) { replacement = response; responses.push(response); break; }
        response.resume();
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(replacement?.statusCode).toBe(200);
      expect(replacement?.headers['x-accel-buffering']).toBe('no');
    } finally {
      for (const response of responses) response.destroy();
      await app.close();
    }
  }, 15000);

  it.each(['write returns false', 'buffer over limit'] as const)('drops an SSE client on %s without blocking healthy clients', async mode => {
    const runId = '00000000-0000-4000-8000-000000000001';
    const app = await buildHttpApp({ ...deps, imports: {
      contextId: runId,
      jobs: { startImport: async () => ({ run: { id: runId, status: 'queued' }, reused: false }) },
    } } as unknown as HttpDependencies);
    let writes = 0;
    let slowResponse: import('node:http').ServerResponse | undefined;
    app.server.prependListener('request', (req, res) => {
      if (req.headers['x-test-slow'] !== 'yes') return;
      slowResponse = res;
      const original = res.write.bind(res);
      Object.defineProperty(res, 'write', { value: (chunk: string) => {
        writes++;
        if (writes > 1 && mode === 'write returns false') return false; // deterministic writable backpressure
        return original(chunk);
      } });
      if (mode === 'buffer over limit') Object.defineProperty(res, 'writableLength', { get: () => writes ? 16385 : 0 });
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const connect = (slow: boolean) => new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      get({ host: '127.0.0.1', port: address.port, path: '/api/v1/events', headers: { host: 'localhost:3000', ...(slow ? { 'x-test-slow': 'yes' } : {}) } }, resolve).on('error', reject);
    });
    let slow: import('node:http').IncomingMessage | undefined;
    let healthy: import('node:http').IncomingMessage | undefined;
    try {
      slow = await connect(true);
      await new Promise<void>(resolve => slow!.once('data', () => resolve()));
      healthy = await connect(false);
      await new Promise<void>(resolve => healthy!.once('data', () => resolve()));
      const closed = new Promise<void>(resolve => slow!.once('close', resolve));
      const changed = new Promise<string>(resolve => healthy!.once('data', chunk => resolve(String(chunk))));
      const start = () => app.inject({ method: 'POST', url: '/api/v1/pipeline/runs', headers: { host: 'localhost:3000' }, payload: {} });
      expect((await start()).statusCode).toBe(202);
      expect(await changed).toContain('pipeline.changed');
      await closed;
      expect(slowResponse?.destroyed).toBe(true);
      const expectedWrites = mode === 'write returns false' ? 2 : 1;
      expect(writes).toBe(expectedWrites);
      expect((await start()).statusCode).toBe(202);
      expect(writes).toBe(expectedWrites);
    } finally {
      slow?.destroy(); healthy?.destroy();
      await app.close();
    }
  }, 15000);

  it('serves SSE over an actual listener and closes on disconnect', async () => {
    const app = await buildHttpApp(deps);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    try {
      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        get({ host: '127.0.0.1', port: address.port, path: '/api/v1/events', headers: { host: 'localhost:3000' } }, resolve).on('error', reject);
      });
      expect(response.headers['content-type']).toContain('text/event-stream');
      const first = await new Promise<string>(resolve => response.once('data', chunk => resolve(String(chunk))));
      expect(first).toContain(': connected');
      const disconnected = new Promise<void>(resolve => response.once('close', resolve));
      await app.close();
      await disconnected;
    } finally { await app.close(); }
  });
});
