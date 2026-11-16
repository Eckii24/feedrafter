import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/server/adapters/postgres/client.js";
import { migrateDatabase } from "../../src/server/adapters/postgres/migrate.js";
import { ImportStore } from "../../src/server/adapters/postgres/import-store.js";
import { ReaderStore } from "../../src/server/adapters/postgres/reader-store.js";
import { listReaderArticles } from "../../src/server/adapters/postgres/reader-query.js";
import { buildHttpApp } from "../../src/server/http/app.js";
import { TaskStore } from "../../src/server/adapters/postgres/task-store.js";
import type { FreshRssEntry } from "../../src/server/ports/freshrss.js";
import { scanUnread } from "../../src/server/application/scan-unread.js";

const docker = (...args: string[]) => execFileSync("docker", ["--host", "unix:///var/run/docker.sock", ...args], { encoding: "utf8" }).trim();
let container = "";
let database: ReturnType<typeof createDatabase>;
const now = new Date("2026-01-02T03:04:05Z");
const entry: FreshRssEntry = {
  id: "tag:google.com,2005:reader/item/000000000000abcd",
  title: "First", url: "https://example.test/same", author: null,
  publishedAt: null, feedId: "feed/12345678901234567890", feedTitle: "Feed",
};

beforeAll(async () => {
  // No external database URL, no persistent volume and no non-loopback published port.
  container = docker("run", "--detach", "--rm", "--pull=never", "--name", `feedrafter-test-${randomUUID()}`,
    "-e", "POSTGRES_PASSWORD=disposable-test-only", "-e", "POSTGRES_DB=feedrafter_test",
    "-p", "127.0.0.1::5432", "postgres:18");
  const address = docker("port", container, "5432/tcp");
  const match = /^127\.0\.0\.1:(\d+)$/.exec(address);
  if (!match) throw new Error(`Unexpected container port: ${address}`);
  database = createDatabase(`postgresql://postgres:disposable-test-only@127.0.0.1:${match[1]}/feedrafter_test`);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await database.pool.query("select 1"); ready = true; break; }
    catch { await delay(200); }
  }
  if (!ready) throw new Error("Disposable PostgreSQL did not become ready");
  const version = await database.pool.query<{ server_version_num: string }>("show server_version_num");
  expect(Number(version.rows[0]!.server_version_num)).toBeGreaterThanOrEqual(180000);
  expect(Number(version.rows[0]!.server_version_num)).toBeLessThan(190000);
}, 30000);

afterAll(async () => {
  try { if (database) await database.close(); }
  finally { if (container) docker("rm", "--force", container); }
});

describe("PostgreSQL persistence", () => {
  it("reports ordered inserted identities while preserving upserts and acknowledgements", async () => {
    await migrateDatabase(database.pool);
    const store = new ImportStore(database.db);
    const context = await store.ensureContext(`identities-${randomUUID()}`, "account");
    const second = { ...entry, id: "second", title: "Second" };
    const duplicate = { ...entry, title: "Duplicate update", feedTitle: "Updated feed" };
    const first = await store.importPageWithIdentities(context.id, [entry, second, duplicate], now);
    expect(first).toEqual([
      { id: expect.any(String), inserted: true },
      { id: expect.any(String), inserted: true },
      { id: first[0]!.id, inserted: false },
    ]);
    expect(first[0]!.id).not.toBe(first[1]!.id);
    expect(await new ReaderStore(database.db).getArticle(first[0]!.id)).toMatchObject({ title: "Duplicate update", importedAt: now });
    const source = await database.pool.query("select title from sources where context_id=$1", [context.id]);
    expect(source.rows).toEqual([{ title: "Updated feed" }]);
    await store.makePendingEligible(context.id);
    const pending = await store.pendingAcknowledgements(context.id);
    const ack = pending.find(item => item.freshrssId === entry.id)!.acknowledgement;
    await store.recordAttempt(ack.id, now, "uncertain");
    await store.confirm(ack.id, now);
    const replay = await store.importPageWithIdentities(context.id, [second, entry], new Date("2026-02-01Z"));
    expect(replay).toEqual([{ id: first[1]!.id, inserted: false }, { id: first[0]!.id, inserted: false }]);
    const acknowledgements = await database.pool.query("select article_id, status, eligible, attempts, confirmed_at from freshrss_acknowledgements where context_id=$1", [context.id]);
    expect(acknowledgements.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ article_id: first[0]!.id, status: "pending", eligible: false, attempts: 1, confirmed_at: null }),
      expect.objectContaining({ article_id: first[1]!.id, status: "pending", eligible: true, attempts: 0 }),
    ]));
    expect(acknowledgements.rows).toHaveLength(2);
    expect(await store.importPage(context.id, [second, entry, second], now)).toEqual([first[1]!.id, first[0]!.id, first[1]!.id]);
    expect(await database.db.transaction(tx => store.importPageInTransaction(tx, context.id, [entry, second], now))).toEqual([first[0]!.id, first[1]!.id]);
    const tasks = await database.pool.query("select count(*)::int as n from processing_tasks where article_id = any($1::uuid[])", [first.map(item => item.id)]);
    expect(tasks.rows[0].n).toBe(0);
  });

  it("reports transaction rollback and concurrent identity replay correctly", async () => {
    await migrateDatabase(database.pool);
    const store = new ImportStore(database.db);
    const context = await store.ensureContext(`identity-race-${randomUUID()}`, "account");
    const item = { ...entry, feedId: null, feedTitle: null };
    await expect(database.db.transaction(async tx => {
      expect(await store.importPageWithIdentitiesInTransaction(tx, context.id, [item], now)).toEqual([{ id: expect.any(String), inserted: true }]);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    let release!: () => void;
    let inserted!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { inserted = resolve; });
    const first = database.db.transaction(async tx => {
      const result = await store.importPageWithIdentitiesInTransaction(tx, context.id, [item], now);
      inserted();
      await held;
      return result;
    });
    await ready;
    let reportPid!: (pid: number) => void;
    const pidReady = new Promise<number>(resolve => { reportPid = resolve; });
    const second = database.db.transaction(async tx => {
      const pid = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      reportPid(pid.rows[0]!.pid);
      return store.importPageWithIdentitiesInTransaction(tx, context.id, [item], now);
    });
    try {
      const pid = await pidReady;
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const activity = await database.pool.query("select wait_event_type from pg_stat_activity where pid=$1", [pid]);
        if (activity.rows[0]?.wait_event_type === "Lock") { blocked = true; break; }
        await delay(20);
      }
      expect(blocked).toBe(true);
    } finally { release(); }
    const [created, replay] = await Promise.all([first, second]);
    expect(created).toEqual([{ id: expect.any(String), inserted: true }]);
    expect(replay).toEqual([{ id: created[0]!.id, inserted: false }]);
  });

  it('pages globally by an explicit active score with nulls last and stable ties', async () => {
    await migrateDatabase(database.pool);
    const store = new ImportStore(database.db);
    const context = await store.ensureContext(`rank-${randomUUID()}`, 'account');
    const feedId = randomUUID();
    const entries = Array.from({ length: 113 }, (_, i) => ({ ...entry, id: `rank-${i}`, title: `Rank ${i}`, feedId, publishedAt: i % 7 === 0 ? null : new Date(`2026-03-0${i % 3 + 1}T00:00:00Z`) }));
    const ids = await store.importPage(context.id, entries, now);
    const source = (await new ReaderStore(database.db).getArticle(ids[0]!))!.sourceId!;
    const definitions = await database.pool.query<{ id: string }>("insert into score_definitions(name, description, prompt, active) values ('Rank', 'test', 'test', true), ('Other', 'test', 'test', true), ('Inactive', 'test', 'test', false) returning id");
    const [score, other, inactive] = definitions.rows.map(row => row.id);
    for (let i = 0; i < ids.length; i++) if (i % 5 !== 0) await database.pool.query('insert into article_scores(article_id, score_id, value, calculated_at, content_revision, assignment_revision) values ($1, $2, $3, now(), 0, 0)', [ids[i], score, i % 4 === 0 ? 0 : i % 3 === 0 ? 25.5 : 90]);
    const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [] });
    const request = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost:3000' } });
    try {
      const openapi = (await request('/api/v1/openapi.json')).json();
      const operation = openapi.paths['/api/v1/articles'].get;
      expect(operation.parameters.find((parameter: { name: string }) => parameter.name === 'sort').schema.enum).toContain('score');
      expect(operation.parameters.find((parameter: { name: string }) => parameter.name === 'scoreId')).toBeDefined();
      expect(operation.responses['200'].content['application/json'].schema.properties.items.items.properties.scoreValue).toBeDefined();
      for (const direction of ['asc', 'desc'] as const) {
        const url = `/api/v1/articles?read=all&source=${source}&sort=score&scoreId=${score}&direction=${direction}&limit=7`;
        const expected = await database.pool.query<{ id: string; value: number | null }>(`select a.id, s.value from articles a left join article_scores s on s.article_id = a.id and s.score_id = $1 where a.source_id = $2 order by s.value ${direction} nulls last, coalesce(a.published_at, a.imported_at) desc, a.id desc`, [score, source]);
        const actual: Array<{ id: string; scoreValue: number | null }> = [];
        let cursor: string | null = null;
        do {
          const response = await request(url + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
          expect(response.statusCode, response.body).toBe(200);
          const page = response.json() as { items: typeof actual; nextCursor: string | null };
          actual.push(...page.items); cursor = page.nextCursor;
          if (actual.length === 7 && cursor) {
            for (const mismatch of [url.replace('read=all', 'read=unread'), url.replace(`scoreId=${score}`, `scoreId=${other}`), url.replace(`direction=${direction}`, `direction=${direction === 'asc' ? 'desc' : 'asc'}`), url + '&kind=video', url + '&title=Rank', url.replace(`source=${source}`, `source=${randomUUID()}`)]) expect((await request(`${mismatch}&cursor=${cursor}`)).statusCode).toBe(400);
            expect((await request(`${url}&cursor=bad`)).statusCode).toBe(400);
            const malformed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Record<string, unknown>;
            malformed.score = 'bad';
            expect((await request(`${url}&cursor=${Buffer.from(JSON.stringify(malformed)).toString('base64url')}`)).statusCode).toBe(400);
          }
          expect(actual.length).toBeLessThanOrEqual(ids.length);
        } while (cursor);
        expect(actual.map(row => ({ id: row.id, value: row.scoreValue }))).toEqual(expected.rows);
      }
      for (const id of ['', randomUUID(), inactive!]) expect((await request(`/api/v1/articles?sort=score${id ? `&scoreId=${id}` : ''}`)).statusCode).toBe(400);
      expect((await request(`/api/v1/articles?sort=date&scoreId=${score}`)).statusCode).toBe(400);
      const initial = await request(`/api/v1/articles?sort=score&scoreId=${score}&source=${source}&limit=1`);
      await database.pool.query('update score_definitions set active = false, deleted_at = now() where id = $1', [score]);
      expect((await request(`/api/v1/articles?sort=score&scoreId=${score}`)).statusCode).toBe(400);
      expect((await request(`/api/v1/articles?sort=score&scoreId=${score}&source=${source}&limit=1&cursor=${initial.json().nextCursor}`)).statusCode).toBe(400);
    } finally { await app.close(); }
  });
  it("accepts a title cursor generated for a long article title", async () => {
    await migrateDatabase(database.pool);
    const store = new ImportStore(database.db);
    const context = await store.ensureContext(`long-title-${randomUUID()}`, "account");
    const feedId = randomUUID();
    const title = `a${'x%_雪'.repeat(1300)}`;
    const ids = await store.importPage(context.id, [
      { ...entry, id: 'long-title-first', title, feedId, publishedAt: new Date('2026-01-01T00:00:00Z') },
      { ...entry, id: 'long-title-second', title: `${title}z`, feedId, publishedAt: new Date('2026-01-02T00:00:00Z') },
    ], now);
    const source = (await new ReaderStore(database.db).getArticle(ids[0]!))!.sourceId!;
    const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [] });
    try {
      const url = `/api/v1/articles?source=${source}&read=all&sort=title&direction=asc&limit=1&title=${encodeURIComponent('x%_雪')}`;
      const first = await app.inject({ method: 'GET', url, headers: { host: 'localhost:3000' } });
      expect(first.statusCode).toBe(200);
      expect(first.json().items.map((x: { id: string }) => x.id)).toEqual([ids[0]]);
      expect(first.json().items[0].title).toBe(title);
      expect(first.json().nextCursor).toBeTruthy();
      expect(first.json().nextCursor.length).toBeLessThanOrEqual(4096);
      const second = await app.inject({ method: 'GET', url: `${url}&cursor=${encodeURIComponent(first.json().nextCursor)}`, headers: { host: 'localhost:3000' } });
      expect(second.statusCode, `cursor length ${first.json().nextCursor.length}, response ${second.body}`).toBe(200);
      expect(second.json().items.map((x: { id: string }) => x.id)).toEqual([ids[1]]);
      expect(second.json().nextCursor).toBeNull();
      const request = async (path: string) => app.inject({ method: 'GET', url: path, headers: { host: 'localhost:3000' } });
      expect((await request(`${url.replace('read=all', 'read=unread')}&cursor=${first.json().nextCursor}`)).statusCode).toBe(400);
      expect((await request(`${url.replace('direction=asc', 'direction=desc')}&cursor=${first.json().nextCursor}`)).statusCode).toBe(400);
      const descUrl = url.replace('direction=asc', 'direction=desc');
      const desc = await request(descUrl);
      expect(desc.statusCode).toBe(200);
      expect(desc.json().items[0].id).toBe(ids[1]);
      const descNext = await request(`${descUrl}&cursor=${desc.json().nextCursor}`);
      expect(descNext.statusCode).toBe(200);
      expect(descNext.json().items[0].id).toBe(ids[0]);
      const dateUrl = url.replace('sort=title', 'sort=date');
      const datePage = await request(dateUrl);
      expect(datePage.json().nextCursor.length).toBeLessThanOrEqual(4096);
      const dateNext = await request(`${dateUrl}&cursor=${datePage.json().nextCursor}`);
      expect(dateNext.statusCode).toBe(200);
      expect(dateNext.json().items[0].id).toBe(ids[1]);
      const missingAnchor = JSON.parse(Buffer.from(first.json().nextCursor, 'base64url').toString());
      missingAnchor.id = randomUUID();
      expect((await request(`${url}&cursor=${Buffer.from(JSON.stringify(missingAnchor)).toString('base64url')}`)).statusCode).toBe(400);
      await store.importPage(context.id, [{ ...entry, id: 'long-title-first', title: `${title}changed`, feedId }], now);
      expect((await request(`${url}&cursor=${first.json().nextCursor}`)).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it("queries and updates the global reader in SQL with stable cursors", async () => {
    await migrateDatabase(database.pool);
    const store = new ImportStore(database.db);
    const context = await store.ensureContext(`reader-${randomUUID()}`, "account");
    const feedId = randomUUID();
    const entries = ["a%_First", "b", "c", "d", "e"].map((title, i) => ({ ...entry, id: `reader-${i}`, title, feedId, publishedAt: new Date(`2026-03-0${i + 1}T00:00:00Z`) }));
    const ids = await store.importPage(context.id, entries, now);
    const source = (await new ReaderStore(database.db).getArticle(ids[0]!))!.sourceId!;
    await new ReaderStore(database.db).setRead(ids[1]!, true);
    const query = { read: 'unread' as const, sort: 'date' as const, direction: 'desc' as const, limit: 2, source };
    const first = await listReaderArticles(database.db, query);
    expect(first.items.map(x => x.title)).toEqual(['e', 'd']);
    const second = await listReaderArticles(database.db, { ...query, cursor: first.nextCursor! });
    expect(second.items.map(x => x.title)).toEqual(['c', 'a%_First']);
    expect(second.nextCursor).toBeNull();
    await expect(listReaderArticles(database.db, { ...query, read: 'all', cursor: first.nextCursor! })).rejects.toThrow();
    expect((await listReaderArticles(database.db, { ...query, title: '%_' })).items.map(x => x.title)).toEqual(['a%_First']);
    const byTitle = await listReaderArticles(database.db, { ...query, sort: 'title', direction: 'asc', limit: 3 });
    expect(byTitle.items.map(x => x.title)).toEqual(['a%_First', 'c', 'd']);
    expect((await listReaderArticles(database.db, { ...query, sort: 'title', direction: 'asc', limit: 3, cursor: byTitle.nextCursor! })).items.map(x => x.title)).toEqual(['e']);
    const legacy = JSON.parse(Buffer.from(byTitle.nextCursor!, 'base64url').toString());
    const legacyCursor = Buffer.from(JSON.stringify({ v: 1, fingerprint: legacy.fingerprint, date: legacy.date, id: legacy.id, title: 'd' })).toString('base64url');
    expect((await listReaderArticles(database.db, { ...query, sort: 'title', direction: 'asc', limit: 3, cursor: legacyCursor })).items.map(x => x.title)).toEqual(['e']);
    const tiedEntries = [null, 'same', 'same', null].map((title, i) => ({ ...entry, id: `tie-${i}`, title, feedId: `${feedId}-ties`, publishedAt: new Date('2026-04-01T00:00:00Z') }));
    const tiedIds = await store.importPage(context.id, tiedEntries, now);
    await database.pool.query("update articles set published_at = '2026-04-01 00:00:00.123456+00' where id = any($1::uuid[])", [tiedIds]);
    const tieSource = (await new ReaderStore(database.db).getArticle(tiedIds[0]!))!.sourceId!;
    for (const direction of ['asc', 'desc'] as const) {
      const tiesQuery = { read: 'all' as const, sort: 'title' as const, direction, limit: 1, source: tieSource };
      const collected: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await listReaderArticles(database.db, { ...tiesQuery, ...(cursor ? { cursor } : {}) });
        collected.push(...page.items.map(x => x.id)); cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(collected).toEqual([
        ...[tiedIds[1]!, tiedIds[2]!].sort().reverse(),
        ...[tiedIds[0]!, tiedIds[3]!].sort().reverse(),
      ]);
    }
    const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [] });
    try {
      const response = await app.inject({ method: 'GET', url: `/api/v1/articles?source=${source}&limit=2`, headers: { host: 'localhost:3000' } });
      expect(response.statusCode).toBe(200);
      expect(response.json().items.map((x: { title: string }) => x.title)).toEqual(['e', 'd']);
      const patch = await app.inject({ method: 'PATCH', url: `/api/v1/articles/${ids[4]}`, headers: { host: 'localhost:3000', origin: 'http://localhost:3000' }, payload: { isRead: true } });
      expect(patch.statusCode).toBe(200);
      expect((await new ReaderStore(database.db).getArticle(ids[4]!))?.isRead).toBe(true);
      expect((await app.inject({ method: 'GET', url: `/api/v1/articles/${ids[4]}`, headers: { host: 'localhost:3000' } })).json().isRead).toBe(true);
      const settings = await app.inject({ method: 'PATCH', url: '/api/v1/settings/import', headers: { host: 'localhost:3000' }, payload: { importEnabled: false, importIntervalSeconds: 120 } });
      expect(settings.statusCode).toBe(200);
      expect(settings.json()).toMatchObject({ importEnabled: false, importIntervalSeconds: 120 });
      expect((await app.inject({ method: 'GET', url: '/api/v1/settings/import', headers: { host: 'localhost:3000' } })).json()).toMatchObject({ importEnabled: false, importIntervalSeconds: 120 });
      await store.saveSettings({ importEnabled: true, importIntervalSeconds: 14400, nextImportAt: null });
    } finally { await app.close(); }
  });
  it("persists pages before advancing, restarts after rollback and deduplicates without acknowledgement", async () => {
    await migrateDatabase(database.pool);
    const store = new ImportStore(database.db);
    const reader = new ReaderStore(database.db);
    const context = await store.ensureContext("scan-test", "account");
    const second = { ...entry, id: "9007199254740993123" };
    let fail = true;
    let marks = 0;
    const cursors: Array<string | undefined> = [];
    const fake = {
      async listUnreadPage(cursor?: string) {
        expect(marks).toBe(0);
        cursors.push(cursor);
        if (cursor === undefined) return { items: [entry], continuation: "next" };
        return { items: fail ? [second, { ...entry, id: "" }] : [second], continuation: null };
      },
      async markRead() { marks++; },
    };
    const scan = () => scanUnread(fake, async (items) => { await store.importPage(context.id, items, now); }, new AbortController().signal);
    await expect(scan()).rejects.toThrow();
    expect(marks).toBe(0);
    const partial = await database.pool.query("select id, freshrss_id from articles where context_id=$1", [context.id]);
    expect(partial.rows).toHaveLength(1);
    const articleId = partial.rows[0].id as string;
    const intents = await database.pool.query("select eligible, status from freshrss_acknowledgements where context_id=$1", [context.id]);
    expect(intents.rows).toEqual([{ eligible: false, status: "pending" }]);
    await reader.setRead(articleId, true);
    fail = false;
    expect(await scan()).toBe(2);
    expect(cursors).toEqual([undefined, "next", undefined, "next"]);
    expect(marks).toBe(0);
    const rows = await database.pool.query("select freshrss_id, is_read from articles where context_id=$1 order by freshrss_id", [context.id]);
    expect(rows.rows).toEqual([{ freshrss_id: second.id, is_read: false }, { freshrss_id: entry.id, is_read: true }]);
    const saved = await database.pool.query("select eligible, status from freshrss_acknowledgements where context_id=$1", [context.id]);
    expect(saved.rows).toHaveLength(2);
    expect(saved.rows.every((row: { eligible: boolean; status: string }) => !row.eligible && row.status === "pending")).toBe(true);
  });

  it("migrates an empty store idempotently and preserves state across repeated imports", async () => {
    await migrateDatabase(database.pool);
    await migrateDatabase(database.pool);
    const store = new ImportStore(database.db);
    const reader = new ReaderStore(database.db);
    const tasks = new TaskStore(database.db);
    const context = await store.ensureContext("instance", "account");
    expect((await store.ensureContext("instance", "account")).id).toBe(context.id);
    const other = await store.ensureContext("instance", "other");
    const [id] = await store.importPage(context.id, [entry], now);
    expect(id).toBeDefined();
    const articleId = id!;
    await reader.setRead(articleId, true);
    await database.pool.query("update articles set assignment_revision=4, content_revision=7 where id=$1", [articleId]);
    const token = randomUUID();
    const task = await tasks.createTask({ articleId, action: "prepare", generation: 1, createdAt: now, updatedAt: now });
    expect((await tasks.claimTask(task.id, token, now))?.attemptCount).toBe(1);
    expect(await tasks.claimTask(task.id, randomUUID(), now)).toBeNull();
    expect(await tasks.updateOwnedTask(task.id, randomUUID(), { state: "succeeded", result: { output: "wrong" } })).toBeNull();
    await tasks.updateOwnedTask(task.id, token, { state: "succeeded", result: { output: "saved" } });
    const repeated = await store.importPage(context.id, [{ ...entry, title: "Updated" }], new Date("2026-02-01Z"));
    expect(repeated).toEqual([articleId]);
    expect(await reader.getArticle(articleId)).toMatchObject({ isRead: true, assignmentRevision: 4, contentRevision: 7, importedAt: now, publishedAt: null, title: "Updated", freshrssId: entry.id });
    expect((await tasks.getTask(task.id))?.result).toEqual({ output: "saved" });
    expect(await store.pendingAcknowledgements(context.id)).toEqual([]);
    await store.makePendingEligible(context.id);
    const [pending] = await store.pendingAcknowledgements(context.id);
    expect(pending?.freshrssId).toBe(entry.id);
    await store.recordAttempt(pending!.acknowledgement.id, now, "uncertain");
    expect((await store.pendingAcknowledgements(context.id))[0]?.acknowledgement).toMatchObject({ attempts: 1, diagnostic: "uncertain" });
    await store.confirm(pending!.acknowledgement.id, now);
    const ack = await database.pool.query("select status, attempts from freshrss_acknowledgements where article_id=$1", [articleId]);
    expect(ack.rows).toEqual([{ status: "confirmed", attempts: 1 }]);
    // Seeing the same ID unread in a later scan creates a new ineligible intent.
    await store.importPage(context.id, [entry], now);
    expect(await store.pendingAcknowledgements(context.id)).toEqual([]);
    await store.makePendingEligible(context.id);
    expect(await store.pendingAcknowledgements(context.id)).toHaveLength(1);

    const [sameUrl] = await store.importPage(context.id, [{ ...entry, id: "different" }], now);
    const [otherContext] = await store.importPage(other.id, [entry], now);
    expect(new Set([sameUrl, otherContext, articleId]).size).toBe(3);
    await expect(store.importPage(context.id, [{ ...entry, id: "rollback" }, { ...entry, id: "" }], now)).rejects.toThrow();
    expect((await database.pool.query("select count(*)::int as n from articles where freshrss_id='rollback'")).rows[0].n).toBe(0);

    const run = await tasks.createRun(context.id, now);
    await expect(tasks.createRun(context.id, now)).rejects.toThrow();
    expect((await tasks.getRun(run.id))?.status).toBe("queued");
    const owner = randomUUID();
    expect((await tasks.claimRun(run.id, owner))?.status).toBe("running");
    expect(await tasks.updateOwnedRun(run.id, randomUUID(), { phase: "ack" })).toBeNull();
    expect((await tasks.updateOwnedRun(run.id, owner, { phase: "ack", fetchedCount: 3 }))?.fetchedCount).toBe(3);
    await tasks.createTask({ articleId, action: "score", createdAt: now, updatedAt: now });
    await expect(tasks.createTask({ articleId, action: "score", createdAt: now, updatedAt: now })).rejects.toThrow();
    await expect(database.pool.query("update processing_tasks set state='nonsense' where id=$1", [task.id])).rejects.toThrow();
    await expect(database.pool.query("update processing_tasks set result=$1 where id=$2", [JSON.stringify({ value: "x".repeat(17000) }), task.id])).rejects.toThrow();
    await expect(database.pool.query("update freshrss_acknowledgements set status='confirmed', confirmed_at=null where article_id=$1", [articleId])).rejects.toThrow();
    await expect(database.pool.query("update articles set source_id=(select id from sources where context_id=$1 limit 1) where id=$2", [other.id, articleId])).rejects.toThrow();
    await expect(database.pool.query("insert into freshrss_acknowledgements(context_id,article_id) values ($1,$2)", [other.id, articleId])).rejects.toThrow();
    await expect(database.pool.query("update articles set kind='nonsense' where id=$1", [articleId])).rejects.toThrow();
    await expect(database.pool.query("insert into app_settings(id,import_interval_seconds) values (1,0)")).rejects.toThrow();
    await expect(store.saveSettings({ importEnabled: true, importIntervalSeconds: 0, nextImportAt: null })).rejects.toThrow();
    expect(await store.getSettings()).toMatchObject({ importEnabled: true, importIntervalSeconds: 14400 });
    await store.saveSettings({ importEnabled: false, importIntervalSeconds: 60, nextImportAt: now });
    expect(await store.getSettings()).toMatchObject({ importEnabled: false, importIntervalSeconds: 60, nextImportAt: now });
    await migrateDatabase(database.pool); // Re-running on a populated store must not change its data.
    const connection = database.pool.options.connectionString!;
    await database.close();
    database = createDatabase(connection);
    expect((await new ReaderStore(database.db).getArticle(articleId))?.isRead).toBe(true);
    expect((await new TaskStore(database.db).getTask(task.id))?.result).toEqual({ output: "saved" });
    expect(await new ImportStore(database.db).pendingAcknowledgements(context.id)).toHaveLength(1);
  }, 30000);
});
