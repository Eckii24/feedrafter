import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { buildHttpApp } from '../../src/server/http/app.js';
import { weight } from '../../src/server/domain/preferences.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
beforeAll(async () => { db = await createUsageDatabase(); await migrateDatabase(db.pool); }, 30000);
afterAll(async () => { if (db) await db.dispose(); });

it('administers preferences, including detached votes, search, sorting, cursors and merged offsets', async () => {
  const app = await buildHttpApp({ db: db.db, pool: db.pool, origin: 'http://localhost:3000', trustedProxies: [] });
  const headers = { host: 'localhost:3000' };
  const get = (url: string) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers });
  const patch = (url: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/v1${url}`, headers, payload });
  try {
    expect((await get('/settings/preferences')).json()).toEqual({ halfLifeDays: 90 });
    for (const halfLifeDays of [0, -1, '90', null]) expect((await patch('/settings/preferences', { halfLifeDays })).statusCode).toBe(400);
    const epoch = (await db.pool.query('select revision from catalog_epoch')).rows[0].revision;
    expect((await patch('/settings/preferences', { halfLifeDays: 30 })).json()).toEqual({ halfLifeDays: 30 });
    expect((await get('/settings/preferences')).json()).toEqual({ halfLifeDays: 30 });
    expect((await db.pool.query('select revision from catalog_epoch')).rows[0].revision).toBe(epoch + 1);
    const context = (await db.pool.query("insert into import_contexts(instance,account) values ('admin','account') returning id")).rows[0].id;
    const source = (await db.pool.query("insert into sources(context_id,external_feed_id,title) values ($1,'feed','Admin Feed') returning id", [context])).rows[0].id;
    const article = (await db.pool.query("insert into articles(context_id,freshrss_id,source_id,imported_at) values ($1,'admin',$2,now()) returning id", [context, source])).rows[0].id;
    const tags = (await db.pool.query("insert into tags(label,key) values ('Admin Alpha',''),('Admin Beta',''),('Admin Gamma','') returning id,label")).rows;
    const alpha = tags.find(r => r.label === 'Admin Alpha').id;
    const beta = tags.find(r => r.label === 'Admin Beta').id;
    const gamma = tags.find(r => r.label === 'Admin Gamma').id;
    const votedAt = new Date(Date.now() - 30 * 86_400_000);
    await db.pool.query('insert into tag_votes values ($1,$2,1,$3),($1,$4,-1,$3)', [article, alpha, votedAt, beta]);
    await db.pool.query('insert into source_votes values ($1,$2,1,$3)', [article, source, votedAt]);
    const lock = await db.pool.connect();
    let pending: ReturnType<typeof patch> | undefined;
    try {
      await lock.query('begin');
      await lock.query('select revision from catalog_epoch where id=1 for update');
      pending = patch(`/tags/${alpha}/preference`, { manualOffset: 4.25 });
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        waiting = Boolean((await db.pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select revision from catalog_epoch%'")).rowCount);
        if (!waiting) await delay(20);
      }
      expect(waiting).toBe(true);
      expect((await db.pool.query('select manual_offset from tags where id=$1', [alpha])).rows[0].manual_offset).toBe(0);
    } finally { await lock.query('rollback'); lock.release(); }
    expect((await pending!).json()).toEqual({ id: alpha, manualOffset: 4.25 });
    expect((await patch(`/sources/${source}/preference`, { manualOffset: -3 })).statusCode).toBe(200);
    expect((await patch(`/tags/${alpha}/preference`, { manualOffset: '1' })).statusCode).toBe(400);
    expect((await patch(`/tags/${randomUUID()}/preference`, { manualOffset: 1 })).statusCode).toBe(404);
    expect((await patch(`/sources/${randomUUID()}/preference`, { manualOffset: 1 })).statusCode).toBe(404);
    const page = (await get('/preferences/tags?query=admin&sort=weight&direction=desc&limit=1')).json();
    expect(page.items[0]).toMatchObject({ id: alpha, manualOffset: 4.25, positive: 1, negative: 0 });
    expect(page.items[0].weight).toBe(weight(4.25, [{ value: 1, votedAt }], new Date(page.asOf), 30));
    expect(page.items[0].weight).toBeCloseTo(4.75, 5);
    const second = (await get(`/preferences/tags?query=admin&sort=weight&direction=desc&limit=1&cursor=${page.nextCursor}`)).json();
    expect(second.asOf).toBe(page.asOf);
    expect(second.items[0].id).toBe(gamma);
    const third = (await get(`/preferences/tags?query=admin&sort=weight&direction=desc&limit=1&cursor=${second.nextCursor}`)).json();
    expect(third.items[0].id).toBe(beta);
    expect(third.nextCursor).toBeNull();
    expect((await get(`/preferences/tags?query=other&sort=weight&direction=desc&cursor=${page.nextCursor}`)).statusCode).toBe(400);
    expect((await get('/preferences/tags?cursor=bad')).statusCode).toBe(400);
    expect((await get('/preferences/tags?limit=101')).statusCode).toBe(400);
    expect((await get('/preferences/tags?query=%00')).statusCode).toBe(400);
    const names = (await get('/preferences/tags?query=admin&sort=name&limit=1')).json();
    const nextName = (await get(`/preferences/tags?query=admin&sort=name&limit=1&cursor=${names.nextCursor}`)).json();
    expect([names.items[0].id, nextName.items[0].id]).toEqual([alpha, beta]);
    const counts = (await get('/preferences/tags?query=admin&sort=negative&direction=desc')).json();
    expect(counts.items[0]).toMatchObject({ id: beta, negative: 1 });
    const feed = (await get('/preferences/sources?query=ADMIN')).json();
    expect(feed.items[0]).toMatchObject({ id: source, manualOffset: -3, positive: 1, negative: 0 });
    expect(feed.items[0].weight).toBe(weight(-3, [{ value: 1, votedAt }], new Date(feed.asOf), 30));
    expect(feed.items[0].weight).toBeCloseTo(-2.5, 5);
    expect((await patch('/settings/preferences', { halfLifeDays: 0.001 })).statusCode).toBe(200);
    expect((await get('/preferences/tags?query=admin')).json().items.find((item: { id: string }) => item.id === alpha).weight).toBe(4.25);
    expect((await patch('/settings/preferences', { halfLifeDays: Number.MIN_VALUE })).statusCode).toBe(200);
    expect((await get('/preferences/tags?query=admin')).statusCode).toBe(200);
    await patch('/settings/preferences', { halfLifeDays: 45 });
    expect((await get(`/preferences/tags?query=admin&sort=weight&direction=desc&limit=1&cursor=${page.nextCursor}`)).statusCode).toBe(400);
    expect((await patch(`/tags/${beta}/preference`, { manualOffset: 2 })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/tags/merge', headers, payload: { targetId: alpha, sourceIds: [beta] } })).statusCode).toBe(200);
    expect((await get('/preferences/tags?query=admin%20alpha')).json().items[0]).toMatchObject({ id: alpha, manualOffset: 6.25 });
  } finally { await app.close(); }
}, 30000);
