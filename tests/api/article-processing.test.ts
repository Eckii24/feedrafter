import { expect, it } from 'vitest';
import { buildHttpApp, type HttpDependencies } from '../../src/server/http/app.js';

const id = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';
it('exposes durable preparation diagnostics and first-time eligibility without private task results', async () => {
  let rows: Record<string, unknown>[] = [];
  const pool = { query: async () => ({ rows }) };
  const app = await buildHttpApp({ db: {}, pool, origin: 'http://localhost:3000', trustedProxies: [], processArticles: async () => [] } as unknown as HttpDependencies);
  const get = () => app.inject({ url: `/api/v1/articles/${id}/processing`, headers: { host: 'localhost:3000' } });
  try {
    expect((await get()).statusCode).toBe(404);
    rows = [{ kind: 'article', url: 'https://example.test', content_revision: 0, task_id: null }];
    expect((await get()).json()).toEqual({ eligibility: 'eligible', retryFailedTaskId: null, tasks: [] });
    rows = [{ ...rows[0], task_id: taskId, action: 'prepare', generation: 1, state: 'failed', error_code: 'content_unusable', score_target_id: null, created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z'), ended_at: null, result: { secret: 'private' } }];
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ eligibility: 'already_started', retryFailedTaskId: null, tasks: [{ id: taskId, action: 'prepare', generation: 1, state: 'failed', errorCode: 'content_unusable', scoreTargetId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', endedAt: null }] });
    expect(response.body).not.toContain('private');
    rows = [{ kind: 'video', url: 'https://example.test/video', content_revision: 0, task_id: null }];
    expect((await get()).json().eligibility).toBe('eligible');
    rows = [{ kind: 'video', url: null, content_revision: 0, task_id: null }];
    expect((await get()).json().eligibility).toBe('ineligible');
    rows = [{ kind: 'article', url: null, content_revision: 0, task_id: null }];
    expect((await get()).json().eligibility).toBe('ineligible');
    rows = [{ kind: 'article', url: 'https://example.test', content_revision: 1, task_id: null }];
    expect((await get()).json().eligibility).toBe('already_started');
  } finally { await app.close(); }
});
