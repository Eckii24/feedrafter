import { expect, it, vi } from 'vitest';
import { buildHttpApp, type HttpDependencies } from '../../src/server/http/app.js';

const id = '00000000-0000-4000-8000-000000000001';
const failedTaskId = '00000000-0000-4000-8000-000000000002';
it('requires an explicit failed task and forwards it exactly once to the retry service', async () => {
  const retryPreparation = vi.fn(async () => [{ articleId: id, kind: 'failed' as const, prepareTaskId: failedTaskId }]);
  const app = await buildHttpApp({ db: {}, pool: {}, origin: 'http://localhost:3000', trustedProxies: [], retryPreparation } as unknown as HttpDependencies);
  const post = (payload: object) => app.inject({ method: 'POST', url: `/api/v1/articles/${id}/processing/retry`, headers: { host: 'localhost:3000', origin: 'http://localhost:3000' }, payload });
  try {
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ failedTaskId: 'bad' })).statusCode).toBe(400);
    expect(retryPreparation).not.toHaveBeenCalled();
    const response = await post({ failedTaskId });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'failed', prepareTaskId: failedTaskId });
    expect(retryPreparation).toHaveBeenCalledOnce();
    expect(retryPreparation).toHaveBeenCalledWith([{ articleId: id, failedTaskId }]);
  } finally { await app.close(); }
});
