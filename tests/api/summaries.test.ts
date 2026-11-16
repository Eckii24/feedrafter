import { createRequire } from 'node:module';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { buildHttpApp, type HttpDependencies } from '../../src/server/http/app.js';

const addFormats = createRequire(import.meta.url)('ajv-formats') as typeof import('ajv-formats').default;
const id = '00000000-0000-4000-8000-000000000001';
const saved = { articleId: id, text: 'Saved', contentRevision: 1, limitation: null as string | null, completedAt: new Date('2026-01-02T03:04:05Z') };

describe('read-only summary API', () => {
  it('distinguishes absent articles, missing, current, limited and outdated summaries', async () => {
    let rows: { revision: number; summary: typeof saved | null }[] = [];
    const db = { select: () => ({ from: () => ({ leftJoin: () => ({ where: async () => rows }) }) }) };
    const app = await buildHttpApp({ db, pool: {}, origin: 'http://localhost:3000', trustedProxies: [] } as unknown as HttpDependencies);
    try {
      const headers = { host: 'localhost:3000' };
      const schema = (await app.inject({ url: '/api/v1/openapi.json', headers })).json().paths['/api/v1/articles/{id}/summary'].get.responses['200'].content['application/json'].schema;
      const ajv = new Ajv(); addFormats(ajv); const validate = ajv.compile(schema);
      const get = () => app.inject({ url: `/api/v1/articles/${id}/summary`, headers });
      expect((await get()).statusCode).toBe(404);
      for (const [row, expected] of [
        [{ revision: 1, summary: null }, { status: 'missing' }],
        [{ revision: 1, summary: saved }, { status: 'current', text: 'Saved', contentRevision: 1, limitation: null, completedAt: saved.completedAt.toISOString() }],
        [{ revision: 1, summary: { ...saved, limitation: 'fallback' } }, { status: 'limited', text: 'Saved', contentRevision: 1, limitation: 'fallback', completedAt: saved.completedAt.toISOString() }],
        [{ revision: 2, summary: { ...saved, limitation: 'fallback' } }, { status: 'outdated', text: 'Saved', contentRevision: 1, limitation: 'fallback', completedAt: saved.completedAt.toISOString() }],
      ] as const) {
        rows = [row];
        const response = await get();
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(expected);
        expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
      }
      expect(validate({ status: 'missing', text: 'x' })).toBe(false);
      expect(validate({ status: 'current' })).toBe(false);
      expect(validate({ status: 'current', text: 'Saved', contentRevision: 1, limitation: 'fallback', completedAt: saved.completedAt.toISOString() })).toBe(false);
      expect((await app.inject({ url: '/api/v1/articles/not-a-uuid/summary', headers })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: `/api/v1/articles/${id}/summary`, headers, payload: {} })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
