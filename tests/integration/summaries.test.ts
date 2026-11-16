import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { SummaryStore } from '../../src/server/adapters/postgres/summary-store.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { MailStore } from '../../src/server/adapters/postgres/mail-store.js';
import { buildHttpApp } from '../../src/server/http/app.js';
import type { SummaryCandidate } from '../../src/server/application/summarize-article.js';

describe('C21 partial summary persistence', () => {
  it('upgrades exact 0007, fences publication, preserves prior success and projects mail', async () => {
    const db = await createUsageDatabase();
    let app: Awaited<ReturnType<typeof buildHttpApp>> | undefined;
    try {
      // Apply the exact pre-0008 migrations and metadata, then use the real migrator to upgrade.
      const migrations = readMigrationFiles({ migrationsFolder: './drizzle' });
      await db.pool.query('create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)');
      for (const migration of migrations.slice(0, 8)) {
        for (const statement of migration.sql) await db.pool.query(statement);
        await db.pool.query('insert into drizzle.__drizzle_migrations(hash,created_at) values ($1,$2)', [migration.hash, migration.folderMillis]);
      }
      const context = (await db.pool.query("insert into import_contexts(instance,account) values ('summary','account') returning id")).rows[0].id as string;
      const article = (await db.pool.query("insert into articles(context_id,freshrss_id,imported_at,content_revision) values ($1,'article',now(),1) returning id", [context])).rows[0].id as string;
      await db.pool.query("insert into article_contents(article_id,revision,text,quality,limitation,captured_at) values ($1,1,'basis','usable','fallback',now())", [article]);
      await migrateDatabase(db.pool);
      await migrateDatabase(db.pool);
      expect((await db.pool.query('select count(*)::int n from drizzle.__drizzle_migrations')).rows[0].n).toBe(10);
      expect((await db.pool.query('select text from article_contents where article_id=$1', [article])).rows[0].text).toBe('basis');
      const tasks = new TaskStore(db.db), store = new SummaryStore(db.db), mail = new MailStore(db.pool);
      const now = new Date('2026-01-02T03:04:05Z'), token = randomUUID();
      const task = await tasks.createTask({ articleId: article, action: 'summary', generation: 1, createdAt: now, updatedAt: now });
      await tasks.claimTask(task.id, token, now);
      const candidate: SummaryCandidate = { articleId: article, taskId: task.id, executionToken: token, generation: 1, contentRevision: 1, text: 'first summary', limitation: 'fallback' };
      expect(await store.publish(candidate, now)).toBe(true);
      expect(await store.get(article)).toEqual({ articleId: article, text: 'first summary', contentRevision: 1, limitation: 'fallback', completedAt: now });
      await mail.select(article, true);
      app = await buildHttpApp({ db: db.db, pool: db.pool, origin: 'http://localhost:3000', trustedProxies: [] });
      const get = async () => (await app!.inject({ url: '/api/v1/mail-queue', headers: { host: 'localhost:3000' } }));
      const readSummary = async (id: string) => app!.inject({ url: `/api/v1/articles/${id}/summary`, headers: { host: 'localhost:3000' } });
      expect((await readSummary(randomUUID())).statusCode).toBe(404);
      expect((await readSummary(article)).json()).toEqual({ status: 'limited', text: 'first summary', contentRevision: 1, limitation: 'fallback', completedAt: now.toISOString() });
      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(response.json().items[0].summary).toEqual({ status: 'limited', text: 'first summary' });
      expect((await mail.list(10)).items[0]!.summary).toEqual({ status: 'limited', text: 'first summary' });
      expect((await app.inject({ url: '/api/v1/health/ready', headers: { host: 'localhost:3000' } })).statusCode).toBe(200);
      const second = (await db.pool.query("insert into articles(context_id,freshrss_id,imported_at,content_revision) values ($1,'second',now(),1) returning id", [context])).rows[0].id as string;
      await db.pool.query("insert into article_contents(article_id,revision,text,quality,captured_at) values ($1,1,'basis','usable',now())", [second]);
      expect((await readSummary(second)).json()).toEqual({ status: 'missing' });
      await mail.select(second, true);
      expect((await get()).json().items.find((item: { id: string }) => item.id === second).summary).toEqual({ status: 'missing', text: null });
      const secondTask = await tasks.createTask({ articleId: second, action: 'summary', generation: 0, createdAt: now, updatedAt: now });
      const secondToken = randomUUID(); await tasks.claimTask(secondTask.id, secondToken, now);
      expect(await store.publish({ articleId: second, taskId: secondTask.id, executionToken: secondToken, generation: 0, contentRevision: 1, text: 'complete', limitation: null }, now)).toBe(true);
      expect((await readSummary(second)).json()).toEqual({ status: 'current', text: 'complete', contentRevision: 1, limitation: null, completedAt: now.toISOString() });
      expect((await get()).json().items.find((item: { id: string }) => item.id === second).summary).toEqual({ status: 'available', text: 'complete' });
      await db.pool.query('update articles set content_revision=2 where id=$1', [second]);
      expect((await readSummary(second)).json()).toEqual({ status: 'outdated', text: 'complete', contentRevision: 1, limitation: null, completedAt: now.toISOString() });
      expect((await get()).json().items.find((item: { id: string }) => item.id === second).summary).toEqual({ status: 'limited', text: 'complete' });
      for (const patch of [
        { contentRevision: 2 }, { executionToken: randomUUID() }, { generation: 2 }, { taskId: randomUUID() }, { articleId: randomUUID() }, { limitation: null },
      ]) expect(await store.publish({ ...candidate, ...patch, text: 'stale' }, new Date())).toBe(false);
      const wrong = await tasks.createTask({ articleId: article, action: 'prepare', generation: 1, createdAt: now, updatedAt: now });
      const wrongToken = randomUUID(); await tasks.claimTask(wrong.id, wrongToken, now);
      expect(await store.publish({ ...candidate, taskId: wrong.id, executionToken: wrongToken }, now)).toBe(false);
      for (const text of ['', '   ', 'bad\0text', 'bad\ud800', 'a'.repeat(16385)]) await expect(store.publish({ ...candidate, text }, now)).rejects.toThrow(/invalid summary/);
      expect((await store.get(article))?.text).toBe('first summary');
      // A task ownership change committed while publication waits must win the fence.
      const ownerClient = await db.pool.connect();
      try {
        await ownerClient.query('begin');
        await ownerClient.query('select id from processing_tasks where id=$1 for update', [task.id]);
        const pending = store.publish({ ...candidate, text: 'lost owner' }, now);
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          const locks = await db.pool.query("select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%from \"processing_tasks\"%' and pid <> pg_backend_pid()");
          if (locks.rowCount) { waiting = true; break; }
          await delay(20);
        }
        expect(waiting).toBe(true);
        await ownerClient.query('update processing_tasks set execution_token=$2 where id=$1', [task.id, randomUUID()]);
        await ownerClient.query('commit');
        expect(await pending).toBe(false);
      } finally { await ownerClient.query('rollback'); ownerClient.release(); }
      await db.pool.query('update processing_tasks set execution_token=$2 where id=$1', [task.id, token]);
      const newer = await tasks.createTask({ articleId: article, action: 'summary', generation: 2, state: 'failed', createdAt: now, updatedAt: now });
      expect(newer.state).toBe('failed');
      expect(await store.publish({ ...candidate, text: 'obsolete' }, now)).toBe(false);
      expect((await store.get(article))?.text).toBe('first summary');
      const nextToken = randomUUID();
      const next = await tasks.createTask({ articleId: article, action: 'summary', generation: 3, createdAt: now, updatedAt: now });
      await tasks.claimTask(next.id, nextToken, now);
      const nextCandidate = { ...candidate, taskId: next.id, generation: 3, executionToken: nextToken, text: 'replacement' };
      const replacementTime = new Date('2026-01-03T03:04:05Z');
      expect(await store.publish(nextCandidate, replacementTime)).toBe(true);
      expect(await store.get(article)).toEqual({ articleId: article, text: 'replacement', contentRevision: 1, limitation: 'fallback', completedAt: replacementTime });
      // Publisher waits for the article lock and must observe the committed newer content revision.
      const client = await db.pool.connect();
      try {
        await client.query('begin');
        await client.query('select id from articles where id=$1 for update', [article]);
        const pending = store.publish(nextCandidate, now);
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          const locks = await db.pool.query("select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%from \"articles\"%' and pid <> pg_backend_pid()");
          if (locks.rowCount) { waiting = true; break; }
          await delay(20);
        }
        expect(waiting).toBe(true);
        await client.query('update articles set content_revision=2 where id=$1', [article]);
        await client.query('commit');
        expect(await pending).toBe(false);
      } finally { await client.query('rollback'); client.release(); }
      expect((await store.get(article))?.text).toBe('replacement');
      expect((await get()).json().items.find((item: { id: string }) => item.id === article).summary).toEqual({ status: 'limited', text: 'replacement' });
      expect(await mail.acknowledge([article])).toMatchObject({ confirmed: [article] });
    } finally { try { if (app) await app.close(); } finally { await db.dispose(); } }
  }, 30000);
});
