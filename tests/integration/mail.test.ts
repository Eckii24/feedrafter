import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { MailStore } from '../../src/server/adapters/postgres/mail-store.js';
import { buildHttpApp } from '../../src/server/http/app.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();
let container = '';
let database: ReturnType<typeof createDatabase>;
let app: Awaited<ReturnType<typeof buildHttpApp>>;
let ids: string[];
const headers = { host: 'localhost:3000' };
const entry = { title: 'Article', url: 'https://example.test/article', author: 'Author', publishedAt: null, feedId: 'feed/test', feedTitle: 'Feed' };

beforeAll(async () => {
  container = docker('run', '--detach', '--rm', '--pull=never', '--name', `feedrafter-mail-${randomUUID()}`, '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
  const match = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'));
  if (!match) throw new Error('Unexpected PostgreSQL port');
  database = createDatabase(`postgresql://postgres:disposable-test-only@127.0.0.1:${match[1]}/feedrafter_test`);
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await database.pool.query('select 1'); ready = true; break; } catch { await delay(200); } }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  const folder = await mkdtemp(join(tmpdir(), 'feedrafter-old-migrations-'));
  try {
    await mkdir(join(folder, 'meta'));
    const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, 3);
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const name of ['0000_import.sql', '0001_enrichment.sql', '0002_budget_settings.sql']) await copyFile(`drizzle/${name}`, join(folder, name));
    await migrateDatabase(database.pool, folder);
    const context = randomUUID();
    await database.pool.query('insert into import_contexts (id, instance, account) values ($1, $2, $3)', [context, 'legacy', 'account']);
    await database.pool.query("insert into articles (context_id, freshrss_id, imported_at) values ($1, 'legacy', now())", [context]);
    await migrateDatabase(database.pool);
    expect((await database.pool.query("select mail_state, mail_selected_at from articles where freshrss_id = 'legacy'")).rows[0]).toEqual({ mail_state: 'not_selected', mail_selected_at: null });
  } finally { await rm(folder, { recursive: true, force: true }); }
  const store = new ImportStore(database.db);
  const context = await store.ensureContext('mail-test', 'account');
  ids = await store.importPage(context.id, Array.from({ length: 6 }, (_, i) => ({ ...entry, id: `mail-${i}` })), new Date());
  app = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [] });
}, 30000);
afterAll(async () => { try { if (app) await app.close(); if (database) await database.close(); } finally { if (container) docker('rm', '--force', container); } });

describe('mail queue contract', () => {
  it('validates API, preserves read state, exposes bounded ordered content, and acknowledges mixed input idempotently', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect((await app.inject({ url: '/api/v1/health/ready', headers })).statusCode).toBe(200);
      const openapi = (await app.inject({ url: '/api/v1/openapi.json', headers })).json();
      expect(openapi.paths['/api/v1/mail-queue'].get.responses['200']).toBeDefined();
      expect(openapi.paths['/api/v1/mail-queue/acknowledgements'].post.responses['200']).toBeDefined();
      const acknowledgementsBefore = (await database.pool.query('select * from freshrss_acknowledgements order by id')).rows;
      const put = (id: string, selected: unknown) => app.inject({ method: 'PUT', url: `/api/v1/articles/${id}/mail-selection`, headers, payload: { selected } });
      const ack = (articleIds: unknown[]) => app.inject({ method: 'POST', url: '/api/v1/mail-queue/acknowledgements', headers, payload: { articleIds } });
      expect((await put(ids[0]!, 'true')).statusCode).toBe(400);
      expect((await ack([])).statusCode).toBe(400);
      expect((await ack(Array(101).fill(ids[0]))).statusCode).toBe(400);
      expect((await ack(['invalid'])).statusCode).toBe(400);
      expect((await app.inject({ method: 'PUT', url: `/api/v1/articles/${ids[0]}/mail-selection`, headers: { ...headers, origin: 'http://evil.test' }, payload: { selected: true } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/mail-queue/acknowledgements', headers: { ...headers, 'sec-fetch-site': 'cross-site' }, payload: { articleIds: [ids[0]] } })).statusCode).toBe(403);
      for (const id of ids.slice(0, 3)) expect((await put(id, true)).statusCode).toBe(200);
      await database.pool.query("update articles set mail_selected_at = '2026-01-01 00:00:00.123456+00' where id = any($1::uuid[])", [ids.slice(0, 3)]);
      await database.pool.query("insert into article_contents (article_id, revision, text, quality, limitation, captured_at) values ($1, 1, 'partial text', 'limited', 'paywall', now()), ($2, 1, 'complete text', 'usable', null, now())", [ids[0], ids[2]]);
      await app.inject({ method: 'PATCH', url: `/api/v1/articles/${ids[1]}`, headers, payload: { isRead: true } });
      const get = (url: string) => app.inject({ url, headers });
      const collected = [];
      let cursor: string | null = null;
      do {
        const response = await get(`/api/v1/mail-queue?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
        expect(response.statusCode).toBe(200);
        collected.push(...response.json().items); cursor = response.json().nextCursor;
      } while (cursor);
      expect(collected.map(x => x.id)).toEqual(ids.slice(0, 3).sort());
      expect(collected.find(x => x.id === ids[0]).content).toMatchObject({ status: 'limited', text: 'partial text', limitation: 'paywall' });
      expect(collected.find(x => x.id === ids[2]).content).toMatchObject({ status: 'available', text: 'complete text' });
      expect(collected.find(x => x.id === ids[1])).toMatchObject({ content: { status: 'missing', text: null }, transcript: { status: 'missing', text: null }, summary: { status: 'missing', text: null }, sourceTitle: 'Feed' });
      for (const query of ['limit=0', 'limit=101', 'cursor=invalid']) expect((await get(`/api/v1/mail-queue?${query}`)).statusCode).toBe(400);
      const unknown = randomUUID();
      const first = await ack([ids[0]!, ids[0]!.toUpperCase(), ids[3]!, unknown]);
      expect(first.json()).toEqual({ confirmed: [ids[0]], alreadyConfirmed: [], rejected: [{ id: ids[3], code: 'NOT_SELECTED' }, { id: unknown, code: 'NOT_FOUND' }] });
      expect((await get('/api/v1/mail-queue?limit=100')).json().items.map((item: { id: string }) => item.id)).toEqual(ids.slice(1, 3).sort());
      expect((await ack([ids[0]!, ids[1]!, ids[2]!, ids[3]!, unknown])).json()).toEqual({ confirmed: [ids[1], ids[2]], alreadyConfirmed: [ids[0]], rejected: [{ id: ids[3], code: 'NOT_SELECTED' }, { id: unknown, code: 'NOT_FOUND' }] });
      expect((await ack([ids[0]!, ids[1]!, ids[2]!])).json()).toEqual({ confirmed: [], alreadyConfirmed: [ids[0], ids[1], ids[2]], rejected: [] });
      expect((await get('/api/v1/mail-queue?limit=100')).json().items).toEqual([]);
      expect((await put(ids[0]!, false)).statusCode).toBe(409);
      expect((await put(ids[0]!, true)).json().error.code).toBe('MAIL_ALREADY_SENT');
      expect((await get(`/api/v1/articles/${ids[1]}`)).json()).toMatchObject({ isRead: true, mailState: 'sent' });
      expect((await get(`/api/v1/articles/${ids[0]}`)).json()).toMatchObject({ isRead: false, mailState: 'sent' });
      expect((await database.pool.query('select * from freshrss_acknowledgements order by id')).rows).toEqual(acknowledgementsBefore);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  it('retries an acknowledgement deadlocked by a concurrent reimport', async () => {
    const imports = new ImportStore(database.db);
    const context = await imports.ensureContext('mail-deadlock', 'account');
    const entries = [0, 1].map(i => ({ ...entry, id: `deadlock-${i}` }));
    const imported = await imports.importPage(context.id, entries, new Date());
    const ordered = imported.map((id, i) => ({ id, entry: entries[i]! })).sort((a, b) => a.id.localeCompare(b.id));
    const low = ordered[0]!, high = ordered[1]!;
    const name = `mail-ack-${randomUUID()}`;
    const ackPool = new pg.Pool({ connectionString: database.pool.options.connectionString, application_name: name, options: '-c deadlock_timeout=100ms -c statement_timeout=10000' });
    const mail = new MailStore(ackPool);
    try {
      await mail.select(low.id, true);
      await mail.select(high.id, true);
      const freshRssBefore = (await database.pool.query('select * from freshrss_acknowledgements where context_id = $1 order by id', [context.id])).rows;
      let ack: Promise<Awaited<ReturnType<MailStore['acknowledge']>>> | undefined;
      await database.db.transaction(async tx => {
        await tx.execute(sql.raw("set local deadlock_timeout = '5s'"));
        await imports.importPageInTransaction(tx, context.id, [high.entry], new Date());
        ack = mail.acknowledge([low.id, high.id]);
        // Attach a handler immediately: the old implementation rejects during the import.
        void ack.catch(() => {});
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          const result = await database.pool.query("select 1 from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock' and query like 'select id, mail_state%'", [name]);
          if (result.rowCount) { waiting = true; break; }
          await delay(20);
        }
        expect(waiting).toBe(true);
        await imports.importPageInTransaction(tx, context.id, [low.entry], new Date());
      });
      expect(await ack).toEqual({ confirmed: [low.id, high.id], alreadyConfirmed: [], rejected: [] });
      expect((await database.pool.query('select id, mail_state from articles where id = any($1::uuid[]) order by id', [[low.id, high.id]])).rows)
        .toEqual([{ id: low.id, mail_state: 'sent' }, { id: high.id, mail_state: 'sent' }]);
      expect(await mail.acknowledge([low.id, high.id])).toEqual({ confirmed: [], alreadyConfirmed: [low.id, high.id], rejected: [] });
      expect((await database.pool.query('select * from freshrss_acknowledgements where context_id = $1 order by id', [context.id])).rows).toEqual(freshRssBefore);
    } finally { await ackPool.end(); }
  }, 20000);

  it('serializes unselect and acknowledgement on the same article row', async () => {
    const store = new MailStore(database.pool);
    const names = [`mail-race-first-${randomUUID()}`, `mail-race-second-${randomUUID()}`];
    const pools = names.map(application_name => new pg.Pool({ connectionString: database.pool.options.connectionString, application_name, options: '-c statement_timeout=10000' }));
    const [firstStore, secondStore] = pools.map(pool => new MailStore(pool)) as [MailStore, MailStore];
    const waitForLock = async (name: string) => {
      for (let i = 0; i < 200; i++) {
        const waiting = await database.pool.query("select 1 from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'", [name]);
        if (waiting.rowCount) return;
        await delay(20);
      }
      throw new Error(`${name} did not wait for a lock`);
    };
    try {
      for (const [id, winner] of [[ids[4]!, 'unselect'], [ids[5]!, 'ack']] as const) {
        await store.select(id, true);
        const client = await database.pool.connect();
        try {
          await client.query('begin');
          await client.query('select id from articles where id = $1 for update', [id]);
          const first = winner === 'unselect' ? firstStore.select(id, false) : firstStore.acknowledge([id]);
          void first.catch(() => {});
          await waitForLock(names[0]!);
          const second = winner === 'unselect' ? secondStore.acknowledge([id]) : secondStore.select(id, false);
          void second.catch(() => {});
          await waitForLock(names[1]!);
          await client.query('commit');
          const [firstResult, secondResult] = await Promise.all([first, second]);
          if (winner === 'unselect') {
            expect(firstResult).toBe('not_selected');
            expect(secondResult).toEqual({ confirmed: [], alreadyConfirmed: [], rejected: [{ id, code: 'NOT_SELECTED' }] });
          } else {
            expect(firstResult).toEqual({ confirmed: [id], alreadyConfirmed: [], rejected: [] });
            expect(secondResult).toBe('sent');
          }
        } finally { await client.query('rollback'); client.release(); }
      }
    } finally { await Promise.all(pools.map(pool => pool.end())); }
  });
});
