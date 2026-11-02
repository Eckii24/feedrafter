import { describe, expect, it, vi } from 'vitest';
import { buildHttpApp, type HttpDependencies } from '../../src/server/http/app.js';

const id = '00000000-0000-4000-8000-000000000001';
describe('feedback API validation', () => {
  it('rejects malformed and cross-site writes without database access', async () => {
    const connect = vi.fn();
    const app = await buildHttpApp({ db: {}, pool: { connect, query: vi.fn() }, origin: 'http://localhost:3000', trustedProxies: [] } as unknown as HttpDependencies);
    const url = `/api/v1/articles/${id}/feedback`;
    const headers = { host: 'localhost:3000' };
    try {
      for (const payload of [
        { value: '1', targets: [{ type: 'tag', id }] },
        { value: 1, targets: [] },
        { value: 1, targets: [{ type: 'article', id }] },
        { value: 1, targets: [{ type: 'tag', id: 'bad' }] },
        { value: 1, targets: [{ type: 'tag', id, extra: true }] },
        { value: 1, targets: [{ type: 'tag', id }], extra: true },
      ]) expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'http://evil.test' }, payload: { value: 1, targets: [{ type: 'tag', id }] } })).statusCode).toBe(403);
      expect(connect).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
