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
