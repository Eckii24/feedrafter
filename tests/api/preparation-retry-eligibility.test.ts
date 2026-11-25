import { expect, it } from 'vitest';
import { buildHttpApp, type HttpDependencies } from '../../src/server/http/app.js';
const id = '00000000-0000-4000-8000-000000000001';
const task = '00000000-0000-4000-8000-000000000002';
it('exposes retry eligibility only for a completed failed prepare without conflicting work or content', async () => {
  let row: Record<string, unknown> = { kind: 'article', url: 'https://example.test', content_revision: 0, has_content: false, has_conflicting_task: false, task_id: task, action: 'prepare', generation: 1, state: 'failed', error_code: null, score_target_id: null, created_at: new Date(), updated_at: new Date(), ended_at: new Date() };
  const app = await buildHttpApp({ db: {}, pool: { query: async () => ({ rows: [row] }) }, origin: 'http://localhost:3000', trustedProxies: [], retryPreparation: async () => [] } as unknown as HttpDependencies);
  const get = async () => (await app.inject({ url: `/api/v1/articles/${id}/processing`, headers: { host: 'localhost:3000' } })).json().retryFailedTaskId;
  try {
    expect(await get()).toBe(task);
    for (const override of [{ state: 'running' }, { ended_at: null }, { has_content: true }, { has_conflicting_task: true }, { content_revision: 1 }, { generation: 0 }]) {
      const previous = row; row = { ...row, ...override }; expect(await get()).toBeNull(); row = previous;
    }
  } finally { await app.close(); }
});
