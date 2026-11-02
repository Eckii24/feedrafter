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
  container = docker('run', '--detach', '--rm', '--pull=never', '--name', `catalog-test-${randomUUID()}`, '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
  const address = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'));
  if (!address) throw new Error('Unexpected port');
  database = createDatabase(`postgresql://postgres:disposable-test-only@127.0.0.1:${address[1]}/feedrafter_test`);
  for (let i = 0; i < 100; i++) { try { await database.pool.query('select 1'); break; } catch { await delay(200); } }
  await migrateDatabase(database.pool);
}, 30000);
afterAll(async () => { try { if (database) await database.close(); } finally { if (container) docker('rm', '--force', container); } });

it('administers catalog with validation, collision handling and preserved assignments', async () => {
  const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [] });
  const headers = { host: 'localhost:3000' };
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Record<string, unknown>) => app.inject({ method, url: `/api/v1/${url}`, headers, ...(payload === undefined ? {} : { payload }) });
  try {
    await app.ready();
    const paths = (app.swagger() as unknown as { paths: Record<string, Record<string, { requestBody?: { content: { 'application/json': { schema: unknown } } }; parameters?: unknown[]; responses: Record<string, { content?: { 'application/json': { schema: unknown } } }> }>> }).paths;
    for (const kind of ['categories', 'tags']) {
      const list = paths[`/api/v1/${kind}`]!;
      const item = paths[`/api/v1/${kind}/{id}`]!;
      const record = { type: 'object', required: kind === 'tags' ? ['id', 'label', 'key', 'archivedAt'] : ['id', 'label', 'archivedAt'], properties: { id: { type: 'string', format: 'uuid' }, label: { type: 'string' }, ...(kind === 'tags' ? { key: { type: 'string' } } : {}), archivedAt: { type: 'string', nullable: true } } };
      const labelBody = { type: 'object', additionalProperties: false, required: ['label'], properties: { label: { type: 'string', description: expect.any(String) } } };
      expect(list.get!.responses['200']!.content!['application/json'].schema).toEqual({ type: 'object', required: ['items'], properties: { items: { type: 'array', items: record } } });
      expect(list.post!.requestBody!.content['application/json'].schema).toEqual(labelBody);
      expect(list.post!.responses['201']!.content!['application/json'].schema).toEqual(record);
      expect(list.post!.responses).not.toHaveProperty('200');
      expect(item.patch!.requestBody!.content['application/json'].schema).toEqual({ oneOf: [labelBody, { type: 'object', additionalProperties: false, required: ['archived'], properties: { archived: { enum: [true] } } }] });
      expect(item.patch!.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'id', in: 'path', required: true })]));
      expect(item.patch!.responses['200']!.content!['application/json'].schema).toEqual(record);
      for (const [operation, codes] of [[list.get!, ['403', '500']], [list.post!, ['400', '403', '409', '500']], [item.patch!, ['400', '403', '404', '409', '500']]] as const) {
        for (const code of codes) expect(operation.responses[code]!.content!['application/json'].schema).toMatchObject({ type: 'object', required: ['error'] });
      }
      for (const payload of [{ label: '  ' }, { label: 'x'.repeat(201) }, { label: 4 }, {}, { label: 'x', extra: 1 }]) expect((await call('POST', kind, payload)).statusCode).toBe(400);
      const created = await call('POST', kind, { label: `  Sample ${kind}  ` });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().id as string;
      expect(created.json().label).toBe(`Sample ${kind}`);
      expect((await call('POST', kind, { label: `sample ${kind}` })).statusCode).toBe(409);
      expect((await call('PATCH', `${kind}/${id}`, { label: `Renamed ${kind}` })).statusCode).toBe(200);
      expect((await call('PATCH', `${kind}/${id}`, { label: ' ' })).statusCode).toBe(400);
      expect((await call('PATCH', `${kind}/${id}`, { archived: false })).statusCode).toBe(400);
      expect((await call('PATCH', `${kind}/${id}`, { label: 4 })).statusCode).toBe(400);
      expect((await call('PATCH', `${kind}/${id}`, { archived: 'true' })).statusCode).toBe(400);
      const archived = await call('PATCH', `${kind}/${id}`, { archived: true });
      expect(archived.statusCode).toBe(200);
      expect((await call('PATCH', `${kind}/${id}`, { archived: true })).json().archivedAt).toBe(archived.json().archivedAt);
      expect((await call('GET', kind)).json().items.find((item: { id: string }) => item.id === id)).toMatchObject({ label: `Renamed ${kind}`, archivedAt: expect.any(String) });
      expect((await call('POST', kind, { label: `renamed ${kind}` })).statusCode).toBe(409);
      expect((await call('PATCH', `${kind}/${randomUUID()}`, { archived: true })).statusCode).toBe(404);
    }
    expect((await call('PATCH', `categories/${fallbackCategoryId}`, { archived: true })).statusCode).toBe(400);
    expect((await call('PATCH', `categories/${fallbackCategoryId}`, { label: 'Fallback renamed' })).statusCode).toBe(200);
    expect((await call('POST', 'tags', { label: 'Straße　  Ａ' })).statusCode).toBe(201);
    expect((await call('POST', 'tags', { label: 'STRASSE A' })).statusCode).toBe(409);
    const otherTag = (await call('POST', 'tags', { label: 'Other' })).json();
    expect((await call('PATCH', `tags/${otherTag.id}`, { label: 'STRASSE A' })).statusCode).toBe(409);
    expect((await call('PATCH', `categories/${randomUUID()}`, { label: 'Nicht zugeordnet' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/tags', headers: { ...headers, origin: 'http://evil.test' }, payload: { label: 'No' } })).statusCode).toBe(403);
    const tag = (await call('POST', 'tags', { label: 'Assigned' })).json();
    const imports = new ImportStore(database.db);
    const context = await imports.ensureContext('catalog', 'account');
    const [articleId, secondArticle] = await imports.importPage(context.id, [{ id: 'a', title: 'A', url: null, author: null, publishedAt: null, feedId: null, feedTitle: null }, { id: 'b', title: 'B', url: null, author: null, publishedAt: null, feedId: null, feedTitle: null }], new Date());
    const store = new CatalogStore(database.db);
    const article = articleId!;
    expect(await store.attachTag(article, tag.id)).toBe(true);
    await call('PATCH', `tags/${tag.id}`, { archived: true });
    expect(await store.attachTag(secondArticle!, tag.id)).toBe(false);
    expect((await store.listArticleTags(article)).map(item => item.id)).toContain(tag.id);
  } finally { await app.close(); }
}, 30000);
