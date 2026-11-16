import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { SourcePermissionStore } from '../../src/server/adapters/postgres/source-permission-store.js';
import { buildHttpApp } from '../../src/server/http/app.js';
import { prepareArticle } from '../../src/server/application/prepare-article.js';
import type { ContentStore } from '../../src/server/adapters/postgres/content-store.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let store: SourcePermissionStore;
let first: string;
let second: string;
let legacy: Record<string, unknown>[];

beforeAll(async () => {
  db = await createUsageDatabase();
  // Install the exact 0000–0008 SQL and migrator history before upgrading.
  const migrations = readMigrationFiles({ migrationsFolder: './drizzle' });
  await db.pool.query('create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)');
  for (const migration of migrations.slice(0, 9)) {
    for (const statement of migration.sql) await db.pool.query(statement);
    await db.pool.query('insert into drizzle.__drizzle_migrations(hash,created_at) values ($1,$2)', [migration.hash, migration.folderMillis]);
  }
  const contexts = (await db.pool.query("insert into import_contexts(instance,account) values ('permissions','one'),('permissions','two') returning id")).rows;
  first = (await db.pool.query("insert into sources(context_id,external_feed_id,title) values ($1,'same','First') returning id", [contexts[0]!.id])).rows[0].id;
  second = (await db.pool.query("insert into sources(context_id,external_feed_id,title) values ($1,'same','Second') returning id", [contexts[1]!.id])).rows[0].id;
  legacy = (await db.pool.query('select * from sources order by id')).rows;
  const app = await buildHttpApp({ db: db.db, pool: db.pool, origin: 'http://localhost:3000', trustedProxies: [] });
  try {
    const ready = async () => (await app.inject({ url: '/api/v1/health/ready', headers: { host: 'localhost:3000' } })).statusCode;
    expect(await ready()).toBe(503);
    await migrateDatabase(db.pool);
    expect(await ready()).toBe(200);
  } finally { await app.close(); }
  store = new SourcePermissionStore(db.pool);
}, 30000);
afterAll(async () => { if (db) await db.dispose(); });

describe('source permissions PostgreSQL store', () => {
  it('upgrades 0008 without altering sources, seeds exactly four hosts and reruns safely', async () => {
    const rows = (await db.pool.query('select * from sources order by id')).rows;
    expect(rows).toEqual(legacy.map(row => ({ ...row, permission_override: null })));
    const seeds = [
      { host: 'm.youtube.com', allowed: true }, { host: 'www.youtube.com', allowed: true },
      { host: 'youtu.be', allowed: true }, { host: 'youtube.com', allowed: true },
    ];
    expect(await store.listHostRules()).toEqual(seeds);
    const versions = (await db.pool.query('select * from drizzle.__drizzle_migrations order by id')).rows;
    expect(versions).toHaveLength(10);
    await migrateDatabase(db.pool);
    expect((await db.pool.query('select * from drizzle.__drizzle_migrations order by id')).rows).toEqual(versions);
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      await client.query("update source_permission_host_rules set allowed=false where host='youtube.com'");
      const seed = (await readFile('drizzle/0009_source_permissions.sql', 'utf8')).split('--> statement-breakpoint')[2]!;
      await client.query(seed);
      expect((await client.query("select allowed from source_permission_host_rules where host='youtube.com'")).rows[0].allowed).toBe(false);
    } finally { await client.query('rollback'); client.release(); }
  });

  it('exposes and updates permissions through the guarded API', async () => {
    const app = await buildHttpApp({ db: db.db, pool: db.pool, origin: 'http://localhost:3000', trustedProxies: [] });
    const headers = { host: 'localhost:3000', origin: 'http://localhost:3000' };
    const list = () => app.inject({ url: '/api/v1/settings/source-permissions', headers });
    const patch = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/v1/sources/${id}/fallback-permission`, headers, payload });
    const put = (payload: object, origin = headers.origin) => app.inject({ method: 'PUT', url: '/api/v1/settings/source-permissions/host', headers: { ...headers, origin }, payload });
    try {
      const initial = await list();
      expect(initial.statusCode).toBe(200);
      expect(initial.json().hostRules).toEqual([
        { host: 'm.youtube.com', allowed: true }, { host: 'www.youtube.com', allowed: true },
        { host: 'youtu.be', allowed: true }, { host: 'youtube.com', allowed: true },
      ]);
      expect(initial.json().sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: first, externalFeedId: 'same', title: 'First', override: null }),
        expect.objectContaining({ id: second, externalFeedId: 'same', title: 'Second', override: null }),
      ]));
      expect((await patch(first, { override: false })).json()).toEqual({ ok: true });
      expect(await store.resolve(first, 'youtube.com')).toBe(false);
      expect(await store.resolve(second, 'youtube.com')).toBe(true);
      expect((await list()).json().sources).toContainEqual(expect.objectContaining({ id: first, override: false }));
      expect((await patch(first, { override: null })).statusCode).toBe(200);
      expect(await store.resolve(first, 'youtube.com')).toBe(true);
      expect((await list()).json().sources).toContainEqual(expect.objectContaining({ id: first, override: null }));
      const rule = await put({ host: 'BÜCHER.Example.', allowed: true });
      expect(rule.statusCode).toBe(200);
      expect(rule.json()).toEqual({ host: 'xn--bcher-kva.example', allowed: true });
      expect((await list()).json().hostRules).toContainEqual({ host: 'xn--bcher-kva.example', allowed: true });
      expect(await store.resolve(first, 'bücher.example')).toBe(true);
      expect(await store.resolve(first, 'sub.bücher.example')).toBe(false);
      const before = await store.listHostRules();
      for (const host of ['https://youtube.com', '*.youtube.com', 'localhost']) {
        const response = await put({ host, allowed: true });
        expect(response.statusCode).toBe(400);
        expect(response.json().error).toMatchObject({ code: 'INVALID_REQUEST', message: 'Invalid request' });
        expect(response.body).not.toContain(host);
      }
      expect((await put({ host: 'other.example', allowed: true }, 'http://attacker.test')).statusCode).toBe(403);
      expect(await store.listHostRules()).toEqual(before);
      expect((await patch(randomUUID(), { override: true })).statusCode).toBe(404);
      expect((await patch('not-a-uuid', { override: true })).statusCode).toBe(400);
      for (const payload of [{}, { override: 'false' }, { override: false, extra: 1 }]) expect((await patch(first, payload)).statusCode).toBe(400);
      for (const payload of [{ host: 'other.example' }, { host: 'other.example', allowed: 'true' }, { host: 'other.example', allowed: true, extra: 1 }]) expect((await put(payload)).statusCode).toBe(400);
      expect(await store.listHostRules()).toEqual(before);
    } finally { await app.close(); }
  });

  it('uses exact canonical hosts, source overrides and reset-to-inherit with source isolation', async () => {
    expect(await store.resolve(first, 'YouTube.COM.')).toBe(true);
    expect(await store.resolve(first, 'sub.youtube.com')).toBe(false);
    expect(await store.resolve(first, 'youtube.com.evil.example')).toBe(false);
    expect(await store.resolve(first, null)).toBe(false);
    expect(await store.resolve(first, 'https://youtube.com')).toBe(false);
    expect(await store.setSourceOverride(first, false)).toBe(true);
    expect(await store.resolve(first, 'youtube.com')).toBe(false);
    expect(await store.resolve(second, 'youtube.com')).toBe(true);
    expect(await store.setSourceOverride(first, true)).toBe(true);
    expect(await store.resolve(first, null)).toBe(true);
    expect(await store.resolve(first, 'https://youtube.com')).toBe(true);
    expect(await store.setSourceOverride(first, null)).toBe(true);
    expect(await store.resolve(first, 'youtube.com')).toBe(true);
    expect(await store.resolve(first, null)).toBe(false);
    expect(await store.listSources()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first, externalFeedId: 'same', title: 'First', override: null }),
      expect.objectContaining({ id: second, externalFeedId: 'same', title: 'Second', override: null }),
    ]));
  });

  it('resolves the actual article source and fails closed for missing articles, sources and invalid hosts', async () => {
    const articles = (await db.pool.query<{ id: string }>(
      "insert into articles(context_id, source_id, freshrss_id, imported_at) select context_id, id, 'permission-article', now() from sources where id = any($1::uuid[]) returning id",
      [[first, second]],
    )).rows;
    const bySource = await db.pool.query<{ id: string; source_id: string }>('select id, source_id from articles where id = any($1::uuid[])', [articles.map(a => a.id)]);
    const article = bySource.rows.find(a => a.source_id === first)!.id;
    const other = bySource.rows.find(a => a.source_id === second)!.id;
    const unsourced = (await db.pool.query<{ id: string }>("insert into articles(context_id, freshrss_id, imported_at) select context_id, 'unsourced', now() from sources where id=$1 returning id", [first])).rows[0]!.id;
    expect(await store.resolveForArticle(article, 'YouTube.COM.')).toBe(true);
    expect(await store.resolveForArticle(article, 'sub.youtube.com')).toBe(false);
    expect(await store.resolveForArticle(article, 'other.example')).toBe(false);
    await store.setSourceOverride(first, false);
    expect(await store.resolveForArticle(article, 'youtube.com')).toBe(false);
    expect(await store.resolveForArticle(other, 'youtube.com')).toBe(true);
    await store.setSourceOverride(first, true);
    expect(await store.resolveForArticle(article, 'https://youtube.com')).toBe(false);
    expect(await store.resolveForArticle(unsourced, 'youtube.com')).toBe(true);
    await store.upsertHostRule('unsourced-denied.example', false);
    expect(await store.resolveForArticle(unsourced, 'unsourced-denied.example')).toBe(false);
    expect(await store.resolveForArticle(unsourced, 'unsourced-absent.example')).toBe(false);
    expect(await store.resolveHost('YOUTUBE.COM.')).toBe(true);
    expect(await store.resolveHost('sub.youtube.com')).toBe(false);
    expect(await store.resolveHost('unsourced-denied.example')).toBe(false);
    expect(await store.resolveHost('unsourced-absent.example')).toBe(false);
    await store.upsertHostRule('BÜCHER.example', true);
    expect(await store.resolveHost('BÜCHER.Example.')).toBe(true);
    expect(await store.resolveHost('xn--bcher-kva.example')).toBe(true);
    expect(await store.resolveForArticle(randomUUID(), 'youtube.com')).toBe(false);
    expect(await store.resolveForArticle('invalid', 'youtube.com')).toBe(false);
    await store.setSourceOverride(first, null);
  });

  it('gates preparation through the persisted article source and original host', async () => {
    const article = (await db.pool.query<{ id: string }>("select id from articles where source_id=$1 and freshrss_id='permission-article'", [first])).rows[0]!.id;
    const text = 'A detailed report with substantial independent factual information. '.repeat(30);
    const fallback = { extract: vi.fn(async () => ({ text, sourceUrl: 'https://youtube.com/article' })) };
    const publishTask = vi.fn<ContentStore['publishTask']>(async () => 1);
    const deps = {
      content: { publishTask }, permission: store, fallback,
      web: { get: async () => ({ status: 200, finalUrl: 'https://other.example/article', headers: { 'content-type': 'text/html' }, body: Buffer.from(`<html><body><article><p>${text}</p></article></body></html>`) }) },
      classifier: { classify: vi.fn().mockResolvedValueOnce({ probability: 0.2, usable: false }).mockResolvedValueOnce({ probability: 0.2, usable: false }).mockResolvedValueOnce({ probability: 0.2, usable: false }).mockResolvedValueOnce({ probability: 1, usable: true }) },
    };
    const input = { context: { articleId: article, taskId: 'task', action: 'prepare' as const, generation: 1, executionToken: 'token', expectedContentRevision: 0 }, originalUrl: 'https://youtube.com/article' };
    await store.setSourceOverride(first, false);
    expect((await prepareArticle(deps, input)).status).toBe('failed');
    expect(publishTask.mock.calls[0]![1]).toMatchObject({ kind: 'failure', errorCode: 'fallback_permission_denied' });
    expect(fallback.extract).not.toHaveBeenCalled();
    await store.setSourceOverride(first, null);
    expect((await prepareArticle(deps, { ...input, context: { ...input.context, articleId: randomUUID() } })).status).toBe('failed');
    expect(fallback.extract).not.toHaveBeenCalled();
    expect((await prepareArticle(deps, input)).status).toBe('succeeded');
    expect(fallback.extract).toHaveBeenCalledOnce();
  });

  it('upserts arbitrary true and false exact-host rules', async () => {
    expect(await store.upsertHostRule('BÜCHER.Example.', true)).toEqual({ host: 'xn--bcher-kva.example', allowed: true });
    expect(await store.resolve(first, 'bücher.example')).toBe(true);
    expect(await store.resolve(first, 'sub.bücher.example')).toBe(false);
    expect(await store.upsertHostRule('BÜCHER.example', false)).toEqual({ host: 'xn--bcher-kva.example', allowed: false });
    expect(await store.resolve(first, 'bücher.example')).toBe(false);
    expect(await store.setSourceOverride(first, true)).toBe(true);
    expect(await store.resolve(first, 'bücher.example')).toBe(true);
    expect(await store.setSourceOverride(first, null)).toBe(true);
  });

  it('rejects invalid writes and safely handles invalid or unknown source ids and hosts', async () => {
    for (const host of ['', '*.youtube.com', 'https://youtube.com', '127.0.0.1', 'foo.local', 'youtube.com:443']) {
      await expect(store.upsertHostRule(host, true)).rejects.toThrow('Invalid permission host');
      expect(await store.resolve(first, host)).toBe(false);
    }
    await expect(store.upsertHostRule('youtube.com', 'true' as unknown as boolean)).rejects.toThrow('Invalid permission rule');
    await expect(store.setSourceOverride(first, 'false' as unknown as boolean)).rejects.toThrow('Invalid permission override');
    for (const id of [randomUUID(), 'not-a-uuid']) {
      expect(await store.setSourceOverride(id, true)).toBe(false);
      expect(await store.resolve(id, 'youtube.com')).toBeNull();
    }
    expect(await store.resolve(second, 'youtube.com')).toBe(true);
  });
});
