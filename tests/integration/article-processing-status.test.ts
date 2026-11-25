import { expect, it } from 'vitest';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { buildHttpApp } from '../../src/server/http/app.js';

it('reads persisted automatic preparation history from PostgreSQL without exposing task payloads', async () => {
  const f = await createUsageDatabase();
  let app: Awaited<ReturnType<typeof buildHttpApp>> | undefined;
  try {
    await migrateDatabase(f.pool);
    const store = new ImportStore(f.db);
    const context = await store.ensureContext('status-fixture', 'synthetic');
    const [article] = await store.importPageWithIdentities(context.id, [{ id: 'status-test', title: 'Synthetic', url: 'https://example.com/article', author: null, publishedAt: null, feedId: null, feedTitle: null }], new Date());
    if (!article) throw new Error('Fixture import failed');
    app = await buildHttpApp({ db: f.db, pool: f.pool, origin: 'http://localhost:3000', trustedProxies: [], processArticles: async () => [], retryPreparation: async () => [] });
    const get = () => app!.inject({ url: `/api/v1/articles/${article.id}/processing`, headers: { host: 'localhost:3000' } });
    expect((await get()).json()).toEqual({ eligibility: 'eligible', retryFailedTaskId: null, tasks: [] });
    await f.pool.query("insert into processing_tasks(article_id, action, generation, state, error_code, result, created_at, updated_at) values ($1, 'prepare', 1, 'failed', 'interrupted', $2, now(), now())", [article.id, { automaticImport: { version: 1 }, secret: 'private-data' }]);
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ eligibility: 'already_started', tasks: [{ action: 'prepare', state: 'failed', errorCode: 'interrupted' }] });
    expect(response.body).not.toContain('private-data');
    expect(response.json().retryFailedTaskId).toBeNull();
    const completed = await f.pool.query("update processing_tasks set ended_at=now() where article_id=$1 returning id", [article.id]);
    expect((await get()).json().retryFailedTaskId).toBe(completed.rows[0].id);
    await f.pool.query("insert into processing_tasks(article_id, action, generation, state, created_at, updated_at) values ($1, 'karakeep', 1, 'running', now(), now())", [article.id]);
    expect((await get()).json().retryFailedTaskId).toBeNull();
  } finally { await app?.close(); await f.dispose(); }
}, 60000);
