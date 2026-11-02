import { describe, expect, it, vi } from 'vitest';
import { buildHttpApp, type HttpDependencies } from '../../src/server/http/app.js';

const id = '00000000-0000-4000-8000-000000000001';
describe('mail API validation and origin', () => {
  it('rejects invalid or cross-site writes before accessing storage', async () => {
    const connect = vi.fn();
    const deps = { db: {}, pool: { connect, query: vi.fn() }, origin: 'http://localhost:3000', trustedProxies: [] } as unknown as HttpDependencies;
    const app = await buildHttpApp(deps);
    const headers = { host: 'localhost:3000' };
    try {
      const url = `/api/v1/articles/${id}/mail-selection`;
      expect((await app.inject({ method: 'PUT', url, headers, payload: { selected: 'false' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PUT', url, headers, payload: { selected: false, extra: true } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PUT', url, headers: { ...headers, origin: 'http://evil.test' }, payload: { selected: true } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PUT', url, headers: { ...headers, 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBe(400);
      const ack = '/api/v1/mail-queue/acknowledgements';
      for (const articleIds of [[], ['bad'], Array(101).fill(id)]) expect((await app.inject({ method: 'POST', url: ack, headers, payload: { articleIds } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: ack, headers, payload: { articleIds: id } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: ack, headers, payload: { articleIds: [1] } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: ack, headers: { ...headers, 'sec-fetch-site': 'cross-site' }, payload: { articleIds: [id] } })).statusCode).toBe(403);
      expect(connect).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
