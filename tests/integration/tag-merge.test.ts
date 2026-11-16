import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { PreferenceStore } from '../../src/server/adapters/postgres/preference-store.js';
import { CatalogStore } from '../../src/server/adapters/postgres/catalog-store.js';
import { TagMergeStore } from '../../src/server/adapters/postgres/tag-merge-store.js';
import { buildHttpApp } from '../../src/server/http/app.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
beforeAll(async () => { db = await createUsageDatabase(); }, 30000);
afterAll(async () => { if (db) await db.dispose(); });

async function article() {
  const imports = new ImportStore(db.db);
  const context = await imports.ensureContext('merge', 'account');
  return (await imports.importPage(context.id, [{ id: randomUUID(), title: 'Article', url: null, author: null, publishedAt: null, feedId: 'feed', feedTitle: 'Feed' }], new Date()))[0]!;
}
async function tag(offset = 0) {
  return (await db.pool.query<{ id: string }>('insert into tags(label, key, manual_offset) values ($1, $2, $3) returning id', [randomUUID(), '', offset])).rows[0]!.id;
}
async function waitForLock(fragment: string) {
  for (let i = 0; i < 200; i++) {
    const r = await db.pool.query("select 1 from pg_stat_activity where pid <> pg_backend_pid() and datname = current_database() and wait_event_type = 'Lock' and position($1 in query) > 0", [fragment]);
    if (r.rowCount) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for lock: ${fragment}`);
}

it('upgrades 0005, retains existing data and validates defaults and constraints', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'merge-old-'));
  try {
    await mkdir(join(folder, 'meta'));
    const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.slice(0, 6);
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) await copyFile(`drizzle/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`));
    await migrateDatabase(db.pool, folder);
    await db.pool.query('insert into app_settings (id) values (1)');
    const context = (await db.pool.query("insert into import_contexts(instance,account) values ('legacy','account') returning id")).rows[0].id;
    const source = (await db.pool.query("insert into sources(context_id,external_feed_id) values ($1,'feed') returning id", [context])).rows[0].id;
    const id = (await db.pool.query("insert into articles(context_id,freshrss_id,source_id,imported_at) values ($1,'legacy',$2,now()) returning id", [context, source])).rows[0].id;
    const oldTag = (await db.pool.query("insert into tags(label,key) values ('old migration tag','') returning id")).rows[0].id;
    await db.pool.query('insert into tag_votes values ($1,$2,1,now())', [id, oldTag]);
    const app = await buildHttpApp({ db: db.db, pool: db.pool, origin: 'http://localhost:3000', trustedProxies: [] });
    try {
      expect((await app.inject({ url: '/api/v1/health/ready', headers: { host: 'localhost:3000' } })).statusCode).toBe(503);
      await migrateDatabase(db.pool); await migrateDatabase(db.pool);
      expect((await app.inject({ url: '/api/v1/health/ready', headers: { host: 'localhost:3000' } })).statusCode).toBe(200);
      await db.pool.query('delete from catalog_epoch');
      expect((await app.inject({ url: '/api/v1/health/ready', headers: { host: 'localhost:3000' } })).statusCode).toBe(503);
      await db.pool.query('insert into catalog_epoch default values');
    } finally { await app.close(); }
    expect((await db.pool.query('select manual_offset from tags where id=$1', [oldTag])).rows[0].manual_offset).toBe(0);
    expect((await db.pool.query('select manual_offset from sources limit 1')).rows[0].manual_offset).toBe(0);
    expect((await db.pool.query('select preference_half_life_days from app_settings where id=1')).rows[0].preference_half_life_days).toBe(90);
    expect((await db.pool.query('select value from tag_votes where article_id=$1 and tag_id=$2', [id, oldTag])).rows[0].value).toBe(1);
    for (const value of ['NaN', 'Infinity', '-Infinity']) {
      await expect(db.pool.query('update tags set manual_offset=$1 where id=$2', [value, oldTag])).rejects.toThrow();
      await expect(db.pool.query('update sources set manual_offset=$1', [value])).rejects.toThrow();
      await expect(db.pool.query('update app_settings set preference_half_life_days=$1', [value])).rejects.toThrow();
    }
    await expect(db.pool.query('update app_settings set preference_half_life_days=0')).rejects.toThrow();
    await db.pool.query('update app_settings set preference_half_life_days=45');
    await db.pool.query('update sources set manual_offset=2 where id=$1', [source]);
    const imports = new ImportStore(db.db);
    await imports.saveSettings({ importEnabled: true, importIntervalSeconds: 60, nextImportAt: null });
    expect((await imports.getSettings()).preferenceHalfLifeDays).toBe(45);
    await imports.importPage(context, [{ id: 'legacy', title: 'Changed', url: null, author: null, publishedAt: null, feedId: 'feed', feedTitle: 'Changed' }], new Date());
    expect((await db.pool.query('select manual_offset from sources where id=$1', [source])).rows[0].manual_offset).toBe(2);
  } finally { await rm(folder, { recursive: true, force: true }); }
}, 30000);

it('merges original votes once, detached votes, associations, offsets and fences atomically via API', async () => {
  const app = await buildHttpApp({ db: db.db, pool: db.pool, origin: 'http://localhost:3000', trustedProxies: [] });
  const headers = { host: 'localhost:3000' };
  const post = (targetId: string, sourceIds: string[]) => app.inject({ method: 'POST', url: '/api/v1/tags/merge', headers, payload: { targetId, sourceIds } });
  try {
    for (const reverse of [false, true]) {
      const [target, a, b, c] = await Promise.all([tag(2), tag(3), tag(-4), tag(0.5)]);
      const [voted, detached, noVote] = await Promise.all([article(), article(), article()]);
      await db.pool.query('insert into article_tags values ($1,$2),($1,$3),($1,$4),($5,$3)', [voted, target, a, b, noVote]);
      await db.pool.query("insert into tag_votes values ($1,$2,1,'2020-01-01'),($1,$3,1,'2021-01-01'),($1,$4,-1,'2022-01-01'),($1,$5,-1,'2023-01-01'),($6,$3,0,'2024-01-01')", [voted, target, a, b, c, detached]);
      const epoch = (await db.pool.query('select revision from catalog_epoch')).rows[0].revision;
      expect((await post(target, reverse ? [c, b, a] : [a, b, c])).statusCode).toBe(200);
      const rows = (await db.pool.query('select article_id,value,voted_at from tag_votes where tag_id=$1 order by article_id', [target])).rows;
      expect(rows).toHaveLength(2);
      expect(rows.find(r => r.article_id === voted)).toMatchObject({ value: 0, voted_at: new Date('2023-01-01') });
      expect(rows.find(r => r.article_id === detached)).toMatchObject({ value: 0, voted_at: new Date('2024-01-01') });
      expect((await db.pool.query('select article_id from article_tags where tag_id=$1 order by article_id', [target])).rows.map(r => r.article_id).sort()).toEqual([voted, noVote].sort());
      expect((await db.pool.query('select manual_offset from tags where id=$1', [target])).rows[0].manual_offset).toBe(1.5);
      expect((await db.pool.query('select count(*)::int as n from tags where id=any($1::uuid[])', [[a, b, c]])).rows[0].n).toBe(0);
      expect((await db.pool.query('select assignment_revision from articles where id=any($1::uuid[])', [[voted, detached, noVote]])).rows.map(r => r.assignment_revision)).toEqual([1, 1, 1]);
      expect((await db.pool.query('select revision from catalog_epoch')).rows[0].revision).toBe(epoch + 1);
    }
    const t = await tag(); const s = await tag();
    expect((await post(t, [])).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/tags/merge', headers, payload: { targetId: t, sourceIds: s } })).statusCode).toBe(400);
    expect((await post(t, [t.toUpperCase()])).statusCode).toBe(400);
    expect((await post(t, [s, s.toUpperCase()])).statusCode).toBe(400);
    expect((await post(t, [randomUUID()])).statusCode).toBe(404);
    await db.pool.query('update tags set archived_at=now() where id=$1', [s]);
    expect((await post(t, [s])).statusCode).toBe(409);
  } finally { await app.close(); }
}, 30000);

it('rolls back all writes if final deletion fails', async () => {
  const [target, source, id] = await Promise.all([tag(2), tag(3), article()]);
  await db.pool.query('insert into article_tags values ($1,$2);', [id, source]);
  await db.pool.query("insert into tag_votes values ($1,$2,1,'2020-01-01')", [id, source]);
  await db.pool.query('create table merge_blocker (tag_id uuid references tags(id))');
  await db.pool.query('insert into merge_blocker values ($1)', [source]);
  const before = await Promise.all(['tags', 'article_tags', 'tag_votes', 'articles', 'catalog_epoch'].map(t => db.pool.query(`select * from ${t} order by 1, 2`)));
  try {
    await expect(new TagMergeStore(db.pool).merge(target, [source])).rejects.toThrow();
    const after = await Promise.all(['tags', 'article_tags', 'tag_votes', 'articles', 'catalog_epoch'].map(t => db.pool.query(`select * from ${t} order by 1, 2`)));
    expect(after.map(r => r.rows)).toEqual(before.map(r => r.rows));
  } finally { await db.pool.query('drop table merge_blocker'); }
});

it('waits for an in-flight vote before discovering detached votes', async () => {
  const [target, source, other, id] = await Promise.all([tag(), tag(), tag(), article()]);
  await db.pool.query('insert into tag_votes values ($1,$2,-1,now()),($1,$3,-1,now())', [id, source, other]);
  const holder = await db.pool.connect();
  try {
    await holder.query('begin'); await holder.query('select id from articles where id=$1 for update', [id]);
    const vote = new PreferenceStore(db.pool).vote(id, 1, [{ type: 'tag', id: source }, { type: 'tag', id: other }]);
    await waitForLock('select source_id from articles where id = $1 for update');
    const merge = new TagMergeStore(db.pool).merge(target, [source]);
    await waitForLock('select id, archived_at from tags where id = any');
    await holder.query('commit');
    expect(await vote).toBe('ok'); expect(await merge).toBe('ok');
    expect((await db.pool.query('select value from tag_votes where article_id=$1 and tag_id=$2', [id, target])).rows[0].value).toBe(1);
  } finally { await holder.query('rollback'); holder.release(); }
}, 30000);

it('discovers an association committed while waiting for its tag guard', async () => {
  const [target, source, id] = await Promise.all([tag(), tag(), article()]);
  const holder = await db.pool.connect();
  try {
    await holder.query('begin'); await holder.query('select id from articles where id=$1 for update', [id]);
    const assignment = new CatalogStore(db.db).changeTag(id, source, true);
    await waitForLock('select "id" from "articles"');
    const merge = new TagMergeStore(db.pool).merge(target, [source]);
    await waitForLock('select id, archived_at from tags where id = any');
    await holder.query('commit');
    expect(await assignment).toBe('ok'); expect(await merge).toBe('ok');
    expect((await db.pool.query('select tag_id from article_tags where article_id=$1', [id])).rows).toEqual([{ tag_id: target }]);
    expect((await db.pool.query('select assignment_revision from articles where id=$1', [id])).rows[0].assignment_revision).toBe(2);
  } finally { await holder.query('rollback'); holder.release(); }
}, 30000);

it('keeps import source and article locks behind an active merge epoch', async () => {
  await migrateDatabase(db.pool);
  const imports = new ImportStore(db.db);
  const context = await imports.ensureContext(randomUUID(), 'account');
  const entries = [0, 1].map(i => ({ id: `item-${i}`, title: 'Article', url: null, author: null, publishedAt: null, feedId: 'feed', feedTitle: 'Feed' }));
  const ids = await imports.importPage(context.id, entries, new Date());
  const ordered = ids.map((id, i) => ({ id, entry: entries[i]! })).sort((a, b) => a.id.localeCompare(b.id));
  const [target, source] = await Promise.all([tag(), tag()]);
  await db.pool.query('insert into article_tags values ($1,$3),($2,$3)', [ordered[0]!.id, ordered[1]!.id, source]);
  const holder = await db.pool.connect();
  const probe = await db.pool.connect();
  let merge: Promise<unknown> | undefined;
  let importing: Promise<unknown> | undefined;
  try {
    await holder.query('begin');
    await holder.query('select id from articles where id=$1 for update', [ordered[0]!.id]);
    merge = new TagMergeStore(db.pool).merge(target, [source]);
    void merge.catch(() => {});
    await waitForLock('select id from articles where id = any');
    importing = imports.importPage(context.id, [ordered[1]!.entry, ordered[0]!.entry], new Date());
    void importing.catch(() => {});
    await waitForLock('select revision from catalog_epoch where id = 1 for share');
    await probe.query('begin');
    await probe.query('select id from sources where context_id=$1 for update nowait', [context.id]);
    await probe.query('select id from articles where id=$1 for update nowait', [ordered[1]!.id]);
    await probe.query('rollback');
    await holder.query('commit');
    expect(await merge).toBe('ok');
    expect(await importing).toEqual([ordered[1]!.id, ordered[0]!.id]);
  } finally {
    await probe.query('rollback'); probe.release();
    await holder.query('rollback'); holder.release();
    await Promise.allSettled([merge, importing].filter(p => p !== undefined));
  }
}, 30000);

it('keeps merge article locks behind an active import epoch', async () => {
  await migrateDatabase(db.pool);
  const imports = new ImportStore(db.db);
  const context = await imports.ensureContext(randomUUID(), 'account');
  const entries = [0, 1].map(i => ({ id: `item-${i}`, title: 'Article', url: null, author: null, publishedAt: null, feedId: 'feed', feedTitle: 'Feed' }));
  const ids = await imports.importPage(context.id, entries, new Date());
  const ordered = ids.map((id, i) => ({ id, entry: entries[i]! })).sort((a, b) => a.id.localeCompare(b.id));
  const [target, source] = await Promise.all([tag(), tag()]);
  await db.pool.query('insert into article_tags values ($1,$3),($2,$3)', [ordered[0]!.id, ordered[1]!.id, source]);
  const probe = await db.pool.connect();
  let merge: Promise<unknown> | undefined;
  try {
    await db.db.transaction(async tx => {
      await imports.importPageInTransaction(tx, context.id, [ordered[1]!.entry], new Date());
      merge = new TagMergeStore(db.pool).merge(target, [source]);
      void merge.catch(() => {});
      await waitForLock('select revision from catalog_epoch where id = 1 for update');
      await probe.query('begin');
      await probe.query('select id from articles where id=$1 for update nowait', [ordered[0]!.id]);
      await probe.query('rollback');
      await imports.importPageInTransaction(tx, context.id, [ordered[0]!.entry], new Date());
    });
    expect(await merge).toBe('ok');
  } finally {
    await probe.query('rollback'); probe.release();
    if (merge) await Promise.allSettled([merge]);
  }
}, 30000);

it('serializes overlapping merges through the epoch gate', async () => {
  const [target, source, other, id] = await Promise.all([tag(), tag(), tag(), article()]);
  await db.pool.query('insert into article_tags values ($1,$2)', [id, source]);
  const holder = await db.pool.connect();
  try {
    await holder.query('begin'); await holder.query('select id from articles where id=$1 for update', [id]);
    const store = new TagMergeStore(db.pool);
    const first = store.merge(target, [source]);
    await waitForLock('select id from articles where id = any');
    const second = store.merge(other, [target]);
    await waitForLock('select revision from catalog_epoch where id = 1 for update');
    await holder.query('commit');
    expect(await first).toBe('ok'); expect(await second).toBe('ok');
    expect((await db.pool.query('select tag_id from article_tags where article_id=$1', [id])).rows).toEqual([{ tag_id: other }]);
    expect((await db.pool.query('select assignment_revision from articles where id=$1', [id])).rows[0].assignment_revision).toBe(2);
  } finally { await holder.query('rollback'); holder.release(); }
}, 30000);

it('blocks votes and removals behind merge guards without deadlock', async () => {
  for (const operation of ['vote', 'remove'] as const) {
    const [target, source, id] = await Promise.all([tag(), tag(), article()]);
    await db.pool.query('insert into tag_votes values ($1,$2,-1,now())', [id, source]);
    const holder = await db.pool.connect();
    try {
      await holder.query('begin'); await holder.query('select id from articles where id=$1 for update', [id]);
      const merge = new TagMergeStore(db.pool).merge(target, [source]);
      await waitForLock('select id from articles where id = any');
      const store = new PreferenceStore(db.pool);
      const pending = operation === 'vote' ? store.vote(id, 1, [{ type: 'tag', id: source }]) : store.remove(id, 'tag', source);
      await waitForLock(operation === 'vote' ? 'select id from tags where id = any' : 'select id from tags where id = $1 for share');
      await holder.query('commit');
      expect(await merge).toBe('ok');
      expect(await pending).toBe(operation === 'vote' ? 'invalid' : true);
      expect((await db.pool.query('select value from tag_votes where article_id=$1 and tag_id=$2', [id, target])).rows[0].value).toBe(-1);
    } finally { await holder.query('rollback'); holder.release(); }
  }
}, 30000);
