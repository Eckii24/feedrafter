import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { buildHttpApp } from '../../src/server/http/app.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();
let container = '';
let database: ReturnType<typeof createDatabase>;
beforeAll(async () => {
  container = docker('run', '--detach', '--rm', '--pull=never', '--name', `feedback-test-${randomUUID()}`, '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
  const address = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'));
  if (!address) throw new Error('Unexpected port');
  database = createDatabase(`postgresql://postgres:disposable-test-only@127.0.0.1:${address[1]}/feedrafter_test`);
  for (let i = 0; i < 100; i++) { try { await database.pool.query('select 1'); break; } catch { await delay(200); } }
  await migrateDatabase(database.pool); await migrateDatabase(database.pool);
}, 30000);
afterAll(async () => { try { if (database) await database.close(); } finally { if (container) docker('rm', '--force', container); } });

describe('feedback persistence and API', () => {
  it('validates atomically, preserves detached votes, refreshes and deletes without score or task changes', async () => {
    const store = new ImportStore(database.db);
    const context = await store.ensureContext('feedback', 'account');
    const [id, other] = await store.importPage(context.id, [
      { id: 'a', title: 'Article', url: null, author: null, publishedAt: null, feedId: 'feed/a', feedTitle: 'Feed A' },
      { id: 'b', title: 'Other', url: null, author: null, publishedAt: null, feedId: 'feed/b', feedTitle: 'Feed B' },
    ], new Date());
    const source = (await database.pool.query('select source_id from articles where id = $1', [id])).rows[0].source_id as string;
    const otherSource = (await database.pool.query('select source_id from articles where id = $1', [other])).rows[0].source_id as string;
    const tag = (await database.pool.query("insert into tags(label, key) values ('Topic', '') returning id")).rows[0].id as string;
    const arbitrary = (await database.pool.query("insert into tags(label, key) values ('Unrelated', '') returning id")).rows[0].id as string;
    await database.pool.query('insert into article_tags(article_id, tag_id) values ($1, $2)', [id, tag]);
    const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [] });
    const base = `/api/v1/articles/${id}/feedback`;
    const headers = { host: 'localhost:3000' };
    const get = () => app.inject({ method: 'GET', url: base, headers });
    const post = (value: unknown, targets: unknown) => app.inject({ method: 'POST', url: base, headers, payload: { value, targets } });
    const remove = (kind: string, targetId: string) => app.inject({ method: 'DELETE', url: `${base}/${kind}/${targetId}`, headers: { ...headers, 'content-type': 'application/json' }, payload: {} });
    const selected = [{ type: 'tag', id: tag }, { type: 'source', id: source }];
    try {
      expect((await get()).json().targets).toHaveLength(2);
      for (const [value, targets] of [[1, []], [1, [selected[0], selected[0]]], [1, [selected[0], { type: 'tag', id: arbitrary }]], [1, [selected[0], { type: 'source', id: otherSource }]], ['1', selected], [2, selected]] as const) expect((await post(value, targets)).statusCode).toBe(400);
      expect(Number((await database.pool.query('select count(*) from tag_votes')).rows[0].count)).toBe(0);
      const scoreId = (await database.pool.query("insert into score_definitions(name, description, prompt) values ('Score', 'Description', 'Prompt') returning id")).rows[0].id as string;
      await database.pool.query('insert into article_scores(article_id, score_id, value, calculated_at, content_revision, assignment_revision) values ($1, $2, 42, now(), 0, 0)', [id, scoreId]);
      await database.pool.query("insert into processing_tasks(article_id, action, created_at, updated_at) values ($1, 'score', now(), now())", [id]);
      const tasksBefore = (await database.pool.query('select * from processing_tasks order by id')).rows;
      const scoresBefore = (await database.pool.query('select * from article_scores order by article_id, score_id')).rows;
      expect((await post(1, selected)).statusCode).toBe(200);
      await database.pool.query("update tag_votes set voted_at = '2000-01-01' where article_id = $1", [id]);
      expect((await post(1, [selected[0]])).statusCode).toBe(200);
      expect((await database.pool.query('select voted_at from tag_votes where article_id = $1', [id])).rows[0].voted_at.getUTCFullYear()).toBeGreaterThan(2000);
      await database.pool.query('delete from article_tags where article_id = $1 and tag_id = $2', [id, tag]);
      expect((await get()).json().targets.find((t: { id: string }) => t.id === tag)).toMatchObject({ detached: true, value: 1 });
      expect((await post(0, [selected[0]])).statusCode).toBe(200);
      expect((await get()).json().targets.find((t: { id: string }) => t.id === tag).value).toBe(0);
      const firstRemoval = await remove('tags', tag);
      expect(firstRemoval.statusCode, firstRemoval.body).toBe(200);
      expect((await remove('tags', tag)).statusCode).toBe(200);
      expect((await post(-1, [selected[0]])).statusCode).toBe(400);
      expect((await remove('sources', source)).statusCode).toBe(200);
      expect((await database.pool.query('select * from processing_tasks order by id')).rows).toEqual(tasksBefore);
      expect((await database.pool.query('select * from article_scores order by article_id, score_id')).rows).toEqual(scoresBefore);
      await expect(database.pool.query('insert into source_votes values ($1, $2, 2, now())', [id, source])).rejects.toThrow();
      await expect(database.pool.query('insert into source_votes values ($1, $2, 1, now())', [id, randomUUID()])).rejects.toThrow();
      await expect(database.pool.query('insert into tag_votes values ($1, $2, 2, now())', [id, tag])).rejects.toThrow();
      await expect(database.pool.query('insert into tag_votes values ($1, $2, 1, now())', [randomUUID(), tag])).rejects.toThrow();
      await database.pool.query('insert into tag_votes values ($1, $2, 1, now())', [id, tag]);
      await expect(database.pool.query('insert into tag_votes values ($1, $2, 1, now())', [id, tag])).rejects.toThrow();
    } finally { await app.close(); }
  });
});
