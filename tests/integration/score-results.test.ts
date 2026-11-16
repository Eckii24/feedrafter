import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { buildHttpApp } from '../../src/server/http/app.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();
let container = '';
let database: ReturnType<typeof createDatabase>;
let app: Awaited<ReturnType<typeof buildHttpApp>>;
let article: string;
const headers = { host: 'localhost:3000' };

beforeAll(async () => {
  container = docker('run', '--detach', '--rm', '--pull=never', '--name', `feedrafter-score-results-${randomUUID()}`, '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
  const match = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'));
  if (!match) throw new Error('Unexpected PostgreSQL port');
  database = createDatabase(`postgresql://postgres:disposable-test-only@127.0.0.1:${match[1]}/feedrafter_test`);
  for (let i = 0; ; i++) { try { await database.pool.query('select 1'); break; } catch (error) { if (i === 100) throw error; await delay(50); } }
  await migrateDatabase(database.pool);
  app = await buildHttpApp({ ...database, origin: 'http://localhost:3000', trustedProxies: [] });
  const context = (await database.pool.query("insert into import_contexts(instance,account) values ('test','test') returning id")).rows[0].id;
  article = (await database.pool.query("insert into articles(context_id,freshrss_id,imported_at,content_revision,assignment_revision) values ($1,'item',now(),2,3) returning id", [context])).rows[0].id;
}, 30000);
afterAll(async () => { try { if (app) await app.close(); if (database) await database.close(); } finally { if (container) docker('rm', '--force', container); } });

it('returns saved and historical results and latest task independently in one read-only response', async () => {
  const db = database.pool;
  const get = () => app.inject({ url: `/api/v1/articles/${article}/scores`, headers });
  expect((await app.inject({ url: `/api/v1/articles/${randomUUID()}/scores`, headers })).statusCode).toBe(404);
  expect((await app.inject({ url: '/api/v1/articles/not-a-uuid/scores', headers })).statusCode).toBe(400);
  const initial = (await get()).json().items;
  expect(initial.length).toBeGreaterThan(0);
  expect(initial.every((item: { value: number | null; latestTask: unknown }) => item.value === null && item.latestTask === null)).toBe(true);
  const definitions = (await db.query("insert into score_definitions(name,description,prompt,active,deleted_at) values ('A','secret','secret prompt',true,null),('B','secret','secret prompt',false,null),('C','secret','secret prompt',false,now()),('D','secret','secret prompt',true,null) returning id,name")).rows;
  const id = (name: string) => definitions.find(d => d.name === name).id as string;
  await db.query("insert into article_scores(article_id,score_id,value,calculated_at,content_revision,assignment_revision,condensed,limited) values ($1,$2,75,'2026-01-01T00:00:00Z',2,3,false,false),($1,$3,23,'2026-01-01T00:00:00Z',1,3,true,true),($1,$4,42,'2026-01-01T00:00:00Z',2,2,false,true)", [article, id('A'), id('B'), id('C')]);
  await db.query("insert into processing_tasks(article_id,action,score_target_id,generation,state,error_code,created_at,updated_at) values ($1,'scores',$2,1,'succeeded',null,now(),now()),($1,'scores',$2,2,'failed','configuration_required',now(),now())", [article, id('A')]);
  const response = await get();
  expect(response.statusCode).toBe(200);
  expect(response.json().items.filter((item: { scoreTargetId: string }) => definitions.some(d => d.id === item.scoreTargetId))).toEqual([
    { scoreTargetId: id('A'), name: 'A', active: true, deleted: false, value: 75, calculatedAt: '2026-01-01T00:00:00.000Z', contentRevision: 2, assignmentRevision: 3, stale: false, condensed: false, limited: false, latestTask: { generation: 2, state: 'failed', errorCode: 'configuration_required' } },
    { scoreTargetId: id('B'), name: 'B', active: false, deleted: false, value: 23, calculatedAt: '2026-01-01T00:00:00.000Z', contentRevision: 1, assignmentRevision: 3, stale: true, condensed: true, limited: true, latestTask: null },
    { scoreTargetId: id('C'), name: 'C', active: false, deleted: true, value: 42, calculatedAt: '2026-01-01T00:00:00.000Z', contentRevision: 2, assignmentRevision: 2, stale: true, condensed: false, limited: true, latestTask: null },
    { scoreTargetId: id('D'), name: 'D', active: true, deleted: false, value: null, calculatedAt: null, contentRevision: null, assignmentRevision: null, stale: null, condensed: null, limited: null, latestTask: null },
  ]);
  expect(response.body).not.toContain('secret');
  expect((await db.query('select count(*)::int as count from processing_tasks where article_id=$1', [article])).rows[0].count).toBe(2);
  expect((await app.inject({ method: 'POST', url: `/api/v1/articles/${article}/scores`, headers, payload: {} })).statusCode).toBe(404);
});
