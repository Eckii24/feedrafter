import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { CatalogStore } from '../../src/server/adapters/postgres/catalog-store.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { buildHttpApp } from '../../src/server/http/app.js';
import { fallbackCategoryId } from '../../src/shared/taxonomy.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();
let container = '';
let database: ReturnType<typeof createDatabase>;
beforeAll(async () => {
  container = docker('run', '--detach', '--rm', '--pull=never', '--name', `scores-test-${randomUUID()}`, '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
  const address = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'));
  if (!address) throw new Error('Unexpected port');
  database = createDatabase(`postgresql://postgres:disposable-test-only@127.0.0.1:${address[1]}/feedrafter_test`);
  for (let i = 0; i < 100; i++) { try { await database.pool.query('select 1'); break; } catch { await delay(200); } }
  await migrateDatabase(database.pool);
}, 30000);
afterAll(async () => { try { if (database) await database.close(); } finally { if (container) docker('rm', '--force', container); } });

it('validates and soft-deletes score definitions without changing historical scores', async () => {
  const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [] });
  const headers = { host: 'localhost:3000' };
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object) => app.inject({ method, url: `/api/v1/scores${path}`, headers, ...(payload === undefined ? {} : { payload }) });
  const input = { name: 'Useful', description: 'Description', prompt: 'Prompt', active: true, includeTitle: true, includeContent: true, includeCategory: true, includeTagWeights: false, includeSourceWeight: false };
  try {
    await app.ready();
    const paths = app.swagger().paths!;
    expect(paths['/api/v1/scores']).toHaveProperty('post.requestBody');
    expect(paths['/api/v1/scores/{id}']).toHaveProperty('patch.requestBody');
    expect(paths['/api/v1/scores/{id}']).toHaveProperty('delete.responses.200');
    expect(paths['/api/v1/scores/{id}']).toHaveProperty('delete.requestBody', { required: true, content: { 'application/json': { schema: { type: 'object' } } } });
    for (const payload of [{ ...input, active: 'true' }, { ...input, includeTitle: 1 }, { ...input, name: '  ' }, { ...input, description: '' }, { ...input, prompt: 'x'.repeat(10001) }, { ...input, name: 'x\0y' }, { ...input, extra: 1 }, {}, []]) expect((await call('POST', '', payload)).statusCode).toBe(400);
    const tasksBefore = (await database.pool.query('select count(*)::int as n from processing_tasks')).rows[0].n;
    const created = await call('POST', '', input);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    expect((await call('GET', '')).json().items).toContainEqual(expect.objectContaining({ id, ...input, deletedAt: null }));
    for (const payload of [{}, { active: 1 }, { includeContent: 'false' }, { name: null }, { description: '   ' }, { value: 99 }]) expect((await call('PATCH', `/${id}`, payload)).statusCode).toBe(400);
    const updated = await call('PATCH', `/${id}`, { name: 'Edited', includeContent: false, includeTagWeights: true, includeSourceWeight: true });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: 'Edited', includeContent: false, includeTagWeights: true, includeSourceWeight: true });
    expect((await app.inject({ method: 'POST', url: '/api/v1/scores', headers: { ...headers, origin: 'http://evil.test' }, payload: input })).statusCode).toBe(403);
    const imports = new ImportStore(database.db);
    const context = await imports.ensureContext('scores', 'account');
    const [article] = await imports.importPage(context.id, [{ id: 'score-article', title: 'A', url: null, author: null, publishedAt: null, feedId: null, feedTitle: null }], new Date());
    await database.pool.query('insert into article_scores(article_id, score_id, value, calculated_at, content_revision, assignment_revision) values ($1, $2, 42, now(), 0, 0)', [article, id]);
    expect((await call('DELETE', `/${id}`)).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/scores/${id}`, headers: { ...headers, 'content-type': 'application/json' } })).statusCode).toBe(400);
    const deleted = await call('DELETE', `/${id}`, {});
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ active: false, deletedAt: expect.any(String) });
    expect((await call('DELETE', `/${id}`, {})).json().deletedAt).toBe(deleted.json().deletedAt);
    // Preserve the existing permissive handling of other valid JSON bodies.
    for (const payload of ['[]', '42', 'null', '"text"']) {
      const response = await app.inject({ method: 'DELETE', url: `/api/v1/scores/${id}`, headers: { ...headers, 'content-type': 'application/json' }, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json().deletedAt).toBe(deleted.json().deletedAt);
    }
    expect((await call('PATCH', `/${id}`, { active: true })).statusCode).toBe(409);
    expect(await new CatalogStore(database.db).saveScoreDefinition(id, input)).toBeNull();
    expect((await database.pool.query('select value from article_scores where score_id=$1', [id])).rows).toEqual([{ value: 42 }]);
    expect((await database.pool.query('select count(*)::int as n from processing_tasks')).rows[0].n).toBe(tasksBefore);
    expect((await call('GET', '')).json().items).toContainEqual(expect.objectContaining({ id, active: false, deletedAt: deleted.json().deletedAt }));
    expect((await call('PATCH', `/${randomUUID()}`, { active: true })).statusCode).toBe(404);
    expect((await call('DELETE', `/${randomUUID()}`, {})).statusCode).toBe(404);
  } finally { await app.close(); }
}, 30000);

it('persists category prompt overrides and rejects invalid or unavailable targets atomically', async () => {
  const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [] });
  const store = new CatalogStore(database.db);
  const score = await store.createScoreDefinition({ name: 'Overrides', description: 'Description', prompt: 'Global', active: true, includeTitle: true, includeContent: true, includeCategory: true, includeTagWeights: false, includeSourceWeight: false });
  const category = await store.createCategory(`Override ${randomUUID()}`);
  const archived = await store.createCategory(`Archived ${randomUUID()}`);
  await store.archiveCategory(archived.id, new Date());
  const base = `/api/v1/scores/${score.id}/category-prompts`;
  const call = (method: 'GET' | 'PUT' | 'DELETE', path: string, payload?: unknown) => app.inject({ method, url: path, headers: { host: 'localhost:3000' }, ...(payload === undefined ? {} : { payload: payload as object }) });
  try {
    await app.ready();
    const paths = app.swagger().paths!;
    expect(paths['/api/v1/scores/{id}/category-prompts']).toHaveProperty('get.responses.200');
    expect(paths['/api/v1/scores/{id}/category-prompts/{categoryId}']).toHaveProperty('put.requestBody');
    expect(paths['/api/v1/scores/{id}/category-prompts/{categoryId}']).toHaveProperty('delete.requestBody');
    const tasks = (await database.pool.query('select count(*)::int as n from processing_tasks')).rows[0].n;
    expect((await call('GET', base)).json().items).toEqual([]);
    for (const body of [{ prompt: '' }, { prompt: '  ' }, { prompt: 'x'.repeat(10001) }, { prompt: 'x\0y' }, { prompt: 12 }, { prompt: 'ok', extra: true }, {}, []]) expect((await call('PUT', `${base}/${category.id}`, body)).statusCode).toBe(400);
    expect((await call('PUT', `${base}/${category.id}`, { prompt: 'First' })).json()).toEqual({ scoreId: score.id, categoryId: category.id, prompt: 'First' });
    expect((await call('PUT', `${base}/${category.id}`, { prompt: 'Updated' })).statusCode).toBe(200);
    for (const id of [fallbackCategoryId, archived.id]) for (const method of ['PUT', 'DELETE'] as const) expect((await call(method, `${base}/${id}`, method === 'PUT' ? { prompt: 'Bad' } : {})).statusCode).toBe(400);
    for (const method of ['PUT', 'DELETE'] as const) expect((await call(method, `${base}/${randomUUID()}`, method === 'PUT' ? { prompt: 'Bad' } : {})).statusCode).toBe(404);
    expect((await call('PUT', `${base}/invalid`, { prompt: 'Bad' })).statusCode).toBe(400);
    expect((await call('GET', `/api/v1/scores/${randomUUID()}/category-prompts`)).statusCode).toBe(404);
    expect((await call('PUT', `/api/v1/scores/${randomUUID()}/category-prompts/${category.id}`, { prompt: 'Bad' })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/v1/scores/${randomUUID()}/category-prompts/${category.id}`, {})).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/scores/invalid/category-prompts')).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `${base}/${category.id}`, headers: { host: 'localhost:3000', origin: 'http://evil.test' }, payload: { prompt: 'Bad' } })).statusCode).toBe(403);
    expect((await call('DELETE', `${base}/${category.id}`)).statusCode).toBe(400);
    expect((await call('DELETE', `${base}/${category.id}`, { extra: true })).statusCode).toBe(400);
    expect((await call('GET', base)).json().items).toEqual([{ scoreId: score.id, categoryId: category.id, prompt: 'Updated' }]);
    expect((await new CatalogStore(database.db).scoreCategoryPromptsForScore(score.id))).toMatchObject({ result: 'ok', items: [{ scoreId: score.id, categoryId: category.id, prompt: 'Updated' }] });
    expect((await call('DELETE', `${base}/${category.id}`, {})).json()).toEqual({ removed: true });
    expect((await call('DELETE', `${base}/${category.id}`, {})).statusCode).toBe(200);
    await call('PUT', `${base}/${category.id}`, { prompt: 'Preserved' });
    await store.archiveCategory(category.id, new Date());
    expect((await call('DELETE', `${base}/${category.id}`, {})).statusCode).toBe(400);
    expect((await call('GET', base)).json().items).toEqual([{ scoreId: score.id, categoryId: category.id, prompt: 'Preserved' }]);
    await store.deleteScoreDefinition(score.id, new Date());
    expect((await call('GET', base)).statusCode).toBe(409);
    expect((await call('PUT', `${base}/${category.id}`, { prompt: 'Bad' })).statusCode).toBe(409);
    expect((await call('DELETE', `${base}/${category.id}`, {})).statusCode).toBe(409);
    expect((await database.pool.query('select prompt from score_category_prompts where score_id = $1', [score.id])).rows).toEqual([{ prompt: 'Preserved' }]);
    expect((await database.pool.query('select count(*)::int as n from processing_tasks')).rows[0].n).toBe(tasks);
  } finally { await app.close(); }
}, 30000);
