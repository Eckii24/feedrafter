import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { buildHttpApp } from '../../src/server/http/app.js';
import { fallbackCategoryId } from '../../src/shared/taxonomy.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();
let container = '';
let database: ReturnType<typeof createDatabase>;
beforeAll(async () => {
  container = docker('run', '--detach', '--rm', '--pull=never', '--name', `assignment-test-${randomUUID()}`, '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
  const address = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'));
  if (!address) throw new Error('Unexpected port');
  database = createDatabase(`postgresql://postgres:disposable-test-only@127.0.0.1:${address[1]}/feedrafter_test`);
  for (let i = 0; i < 100; i++) { try { await database.pool.query('select 1'); break; } catch { await delay(200); } }
  await migrateDatabase(database.pool);
}, 30000);
afterAll(async () => { try { if (database) await database.close(); } finally { if (container) docker('rm', '--force', container); } });

it('assigns manually with revision fencing, serialized changes, archived history and no side effects', async () => {
  const imports = new ImportStore(database.db);
  const context = await imports.ensureContext('assignments', 'account');
  const [id] = await imports.importPage(context.id, [{ id: 'article', title: 'Article', url: null, author: null, publishedAt: null, feedId: null, feedTitle: null }], new Date());
  const category = (await database.pool.query("insert into categories(label) values ('Manual') returning id")).rows[0].id as string;
  const archivedCategory = (await database.pool.query("insert into categories(label, archived_at) values ('Old', now()) returning id")).rows[0].id as string;
  const tag = (await database.pool.query("insert into tags(label, key) values ('Manual tag', '') returning id")).rows[0].id as string;
  const archivedTag = (await database.pool.query("insert into tags(label, key, archived_at) values ('Old tag', '', now()) returning id")).rows[0].id as string;
  const score = (await database.pool.query("insert into score_definitions(name, description, prompt) values ('Score', 'Description', 'Prompt') returning id")).rows[0].id as string;
  await database.pool.query('insert into article_scores(article_id, score_id, value, calculated_at, content_revision, assignment_revision) values ($1, $2, 42, now(), 0, 0)', [id, score]);
  await database.pool.query("insert into processing_tasks(article_id, action, created_at, updated_at) values ($1, 'score', now(), now())", [id]);
  await database.pool.query('insert into tag_votes values ($1, $2, 1, now())', [id, tag]);
  await database.pool.query('insert into article_tags values ($1, $2)', [id, archivedTag]);
  const before = await Promise.all(['article_scores', 'processing_tasks', 'tag_votes'].map(table => database.pool.query(`select * from ${table} order by 1, 2`)));
  const beforeArticle = (await database.pool.query('select is_read, mail_state, mail_selected_at, content_revision from articles where id = $1', [id])).rows;
  const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [] });
  const headers = { host: 'localhost:3000', 'content-type': 'application/json' };
  const call = (method: 'GET' | 'PATCH' | 'PUT' | 'DELETE', path: string, payload?: object) => app.inject({ method, url: `/api/v1/articles/${path}`, headers, ...(method === 'GET' ? {} : { payload: payload ?? {} }) });
  const state = async () => (await call('GET', `${id}/catalog`)).json();
  try {
    expect((await state()).category.id).toBe(fallbackCategoryId);
    expect((await state()).tags[0]).toMatchObject({ id: archivedTag, archivedAt: expect.any(String) });
    expect((await call('GET', `${randomUUID()}/catalog`)).statusCode).toBe(404);
    expect((await call('PATCH', `${id}/category`, { categoryId: 'bad' })).statusCode).toBe(400);
    expect((await call('PATCH', `${id}/category`, { categoryId: randomUUID() })).statusCode).toBe(404);
    expect((await call('PATCH', `${randomUUID()}/category`, { categoryId: category })).statusCode).toBe(404);
    expect((await call('PATCH', `${id}/category`, { categoryId: archivedCategory })).statusCode).toBe(409);
    expect((await call('PUT', `${id}/tags/${randomUUID()}`)).statusCode).toBe(404);
    expect((await call('DELETE', `${id}/tags/${randomUUID()}`)).statusCode).toBe(404);
    expect((await call('PUT', `${randomUUID()}/tags/${tag}`)).statusCode).toBe(404);
    expect((await call('PUT', `${id}/tags/${archivedTag}`)).statusCode).toBe(409);
    expect((await state()).assignmentRevision).toBe(0);
    const categoryResults = await Promise.all(Array.from({ length: 6 }, () => call('PATCH', `${id}/category`, { categoryId: category.toUpperCase() })));
    expect(categoryResults.every(result => result.statusCode === 200)).toBe(true);
    expect((await state()).assignmentRevision).toBe(1);
    const adds = await Promise.all(Array.from({ length: 6 }, () => call('PUT', `${id}/tags/${tag}`)));
    expect(adds.every(result => result.statusCode === 200)).toBe(true);
    expect((await state()).assignmentRevision).toBe(2);
    const removes = await Promise.all(Array.from({ length: 6 }, () => call('DELETE', `${id}/tags/${tag}`)));
    expect(removes.every(result => result.statusCode === 200)).toBe(true);
    expect((await state()).assignmentRevision).toBe(3);
    expect((await call('DELETE', `${id}/tags/${archivedTag}`)).statusCode).toBe(200);
    expect((await call('DELETE', `${id}/tags/${archivedTag}`)).statusCode).toBe(200);
    expect((await call('PATCH', `${id}/category`, { categoryId: fallbackCategoryId })).statusCode).toBe(200);
    expect((await state()).assignmentRevision).toBe(5);
    const after = await Promise.all(['article_scores', 'processing_tasks', 'tag_votes'].map(table => database.pool.query(`select * from ${table} order by 1, 2`)));
    expect(after.map(result => result.rows)).toEqual(before.map(result => result.rows));
    expect((await database.pool.query('select is_read, mail_state, mail_selected_at, content_revision from articles where id = $1', [id])).rows).toEqual(beforeArticle);
    expect((await database.pool.query('select assignment_revision from article_scores where article_id = $1', [id])).rows[0].assignment_revision).toBe(0);
    // Voting takes the article lock first and FK key-share locks on the tag; it must not deadlock with assignment.
    for (let i = 0; i < 5; i++) {
      const [assignment, vote] = await Promise.all([
        call('PUT', `${id}/tags/${tag}`),
        app.inject({ method: 'POST', url: `/api/v1/articles/${id}/feedback`, headers, payload: { value: 1, targets: [{ type: 'tag', id: tag }] } }),
      ]);
      expect([assignment.statusCode, vote.statusCode]).toEqual([200, 200]);
      expect((await call('DELETE', `${id}/tags/${tag}`)).statusCode).toBe(200);
    }
    // An in-flight archive owns the catalog lock; a later attach must observe the archive.
    const raceTag = (await database.pool.query("insert into tags(label, key) values ('Race tag', '') returning id")).rows[0].id as string;
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      await client.query('update tags set archived_at = now() where id = $1', [raceTag]);
      const pending = call('PUT', `${id}/tags/${raceTag}`);
      await delay(100);
      await client.query('commit');
      expect((await pending).statusCode).toBe(409);
      expect((await database.pool.query('select * from article_tags where article_id = $1 and tag_id = $2', [id, raceTag])).rowCount).toBe(0);
    } finally { await client.query('rollback'); client.release(); }
  } finally { await app.close(); }
}, 30000);
