import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KarakeepClient } from '../../src/server/adapters/karakeep/client.js';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { KARAKEEP_QUEUE, KarakeepJobs, recoverKarakeep, runKarakeep } from '../../src/server/adapters/postgres/karakeep-jobs.js';
import { buildApplication } from '../../src/server/composition-root.js';
import { provisionScoreQueue } from '../../src/server/adapters/postgres/score-admission.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { buildHttpApp } from '../../src/server/http/app.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();
let container = '';
let db: ReturnType<typeof createDatabase>;
let boss: PgBoss;
let server: Server;
let baseUrl: string;
let databaseUrl: string;
let received: Array<{ method: string; path: string; body: unknown; authorization: string | undefined }> = [];
let responseStatus = 201;
let responseBody: unknown;
let dropResponseAfterCommit = false;
let fixtureBookmarks: Array<{ url: string; favorite: boolean; tags: string[]; note: string }> = [];
const originalUrl = 'https://example.com/original?x=1#fragment';
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(100); }
  throw new Error('Timed out');
}
async function article(url: string | null) {
  const store = new ImportStore(db.db);
  const context = await store.ensureContext(randomUUID(), 'account');
  const [id] = await store.importPage(context.id, [{ id: 'item', title: 'item', url, author: null, publishedAt: null, feedId: null, feedTitle: null }], new Date());
  return id!;
}

beforeAll(async () => {
  container = docker('run', '--detach', '--rm', '--pull=never', '--name', `feedrafter-karakeep-${randomUUID()}`, '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
  const port = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'))![1];
  const url = `postgresql://postgres:disposable-test-only@127.0.0.1:${port}/feedrafter_test`;
  databaseUrl = url;
  db = createDatabase(url);
  await eventually(async () => { try { await db.pool.query('select 1'); return true; } catch { return false; } });
  await migrateDatabase(db.pool);
  boss = new PgBoss({ connectionString: url }); boss.on('error', () => {}); await boss.start(); await provisionScoreQueue(boss);
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { url: string };
      received.push({ method: req.method!, path: req.url!, body, authorization: req.headers.authorization });
      if (dropResponseAfterCommit) {
        fixtureBookmarks.push({ url: body.url, favorite: false, tags: [], note: '' });
        res.destroy();
        return;
      }
      res.writeHead(responseStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}, 30000);
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  try { if (boss) await boss.stop(); if (db) await db.close(); } finally { if (container) docker('rm', '--force', container); }
});

describe('durable Karakeep action', () => {
  it('rolls back enqueue failure, serializes concurrent starts, and persists a single successful original-URL dispatch', async () => {
    const id = await article(originalUrl);
    const jobs = new KarakeepJobs(db.db, boss);
    await expect(jobs.start(id)).rejects.toThrow();
    expect((await db.pool.query('select count(*)::int n from processing_tasks where article_id=$1', [id])).rows[0].n).toBe(0);
    await boss.createQueue(KARAKEEP_QUEUE);
    const starts = await Promise.all(Array.from({ length: 10 }, () => jobs.start(id)));
    const tasks = starts.filter(item => item.kind === 'task');
    expect(new Set(tasks.map(item => item.task.id)).size).toBe(1);
    expect(tasks.filter(item => !item.reused)).toHaveLength(1);
    const task = tasks[0]!.task;
    expect((await db.pool.query('select count(*)::int n from pgboss.job where id=$1', [task.jobId])).rows[0].n).toBe(1);
    received = []; responseStatus = 201; responseBody = { id: 'bookmark-1', content: { type: 'link', url: originalUrl } };
    await Promise.all([runKarakeep(db.db, new KarakeepClient({ baseUrl, token: 'fixture-token' }), task.id), runKarakeep(db.db, new KarakeepClient({ baseUrl, token: 'fixture-token' }), task.id)]);
    expect(received).toEqual([{ method: 'POST', path: '/api/v1/bookmarks', body: { type: 'link', url: originalUrl }, authorization: 'Bearer fixture-token' }]);
    const saved = (await db.pool.query('select state, result, attempt_count from processing_tasks where id=$1', [task.id])).rows[0];
    expect(saved).toMatchObject({ state: 'succeeded', attempt_count: 1, result: { outcome: 'created', bookmarkId: 'bookmark-1', originalUrl } });
    expect(await jobs.start(id)).toMatchObject({ reused: true, task: { id: task.id, state: 'succeeded' } });
  });

  it('reports ambiguous responses without retry; API coalesces and exposes next step', async () => {
    const id = await article(originalUrl); const jobs = new KarakeepJobs(db.db, boss);
    const app = await buildHttpApp({ db: db.db, pool: db.pool, origin: 'http://localhost:3000', trustedProxies: [], karakeep: jobs });
    try {
      expect((await app.inject({ url: '/api/v1/karakeep', headers: { host: 'localhost:3000' } })).json()).toEqual({ available: true });
      const unavailable = await buildHttpApp({ db: db.db, pool: db.pool, origin: 'http://localhost:3000', trustedProxies: [] });
      try {
        expect((await unavailable.inject({ url: '/api/v1/karakeep', headers: { host: 'localhost:3000' } })).json()).toEqual({ available: false });
        expect((await unavailable.inject({ method: 'POST', url: `/api/v1/articles/${id}/karakeep`, headers: { host: 'localhost:3000' }, payload: {} })).statusCode).toBe(503);
      } finally { await unavailable.close(); }
      const post = () => app.inject({ method: 'POST', url: `/api/v1/articles/${id}/karakeep`, headers: { host: 'localhost:3000' }, payload: {} });
      const start = await post(); expect(start.statusCode).toBe(202);
      const taskId = start.json().taskId as string;
      received = []; responseStatus = 404; responseBody = { error: 'not found' };
      await runKarakeep(db.db, new KarakeepClient({ baseUrl, token: 'fixture-token' }), taskId);
      const status = await app.inject({ url: `/api/v1/processing-tasks/${taskId}`, headers: { host: 'localhost:3000' } });
      expect(status.json()).toEqual({ id: taskId, articleId: id, action: 'karakeep', state: 'needs_input', outcome: 'uncertain', bookmarkId: null, nextStep: 'Check Karakeep manually before taking further action; this request will not be retried automatically.' });
      expect((await post()).json()).toMatchObject({ taskId, reused: true, state: 'needs_input' });
      await runKarakeep(db.db, new KarakeepClient({ baseUrl, token: 'fixture-token' }), taskId);
      expect(received).toHaveLength(1);
      const invalid = await article('javascript:alert(1)');
      expect((await app.inject({ method: 'POST', url: `/api/v1/articles/${invalid}/karakeep`, headers: { host: 'localhost:3000' }, payload: {} })).statusCode).toBe(422);
    } finally { await app.close(); }
  });

  it('keeps a committed create with lost response uncertain without another POST or mutation of an existing bookmark', async () => {
    const id = await article(originalUrl); const jobs = new KarakeepJobs(db.db, boss);
    const result = await jobs.start(id); if (result.kind !== 'task') throw new Error('Missing task');
    const existing = { url: 'https://example.com/existing', favorite: true, tags: ['keep'], note: 'unchanged' };
    fixtureBookmarks = [structuredClone(existing)]; received = []; dropResponseAfterCommit = true;
    try {
      const client = new KarakeepClient({ baseUrl, token: 'fixture-token' });
      await runKarakeep(db.db, client, result.task.id);
      expect(fixtureBookmarks).toEqual([existing, { url: originalUrl, favorite: false, tags: [], note: '' }]);
      expect((await db.pool.query('select state, result, attempt_count from processing_tasks where id=$1', [result.task.id])).rows[0])
        .toMatchObject({ state: 'needs_input', result: { originalUrl, outcome: 'uncertain' }, attempt_count: 1 });
      expect(await jobs.start(id)).toMatchObject({ reused: true, task: { id: result.task.id, state: 'needs_input' } });
      await recoverKarakeep(db.db, boss);
      await runKarakeep(db.db, client, result.task.id);
      expect(received).toEqual([{ method: 'POST', path: '/api/v1/bookmarks', body: { type: 'link', url: originalUrl }, authorization: 'Bearer fixture-token' }]);
      expect(fixtureBookmarks).toEqual([existing, { url: originalUrl, favorite: false, tags: [], note: '' }]);
    } finally { dropResponseAfterCommit = false; }
  });

  it('recovery fences a stale owner and never redispatches a possibly sent request', async () => {
    const id = await article(originalUrl); const jobs = new KarakeepJobs(db.db, boss);
    const result = await jobs.start(id); if (result.kind !== 'task') throw new Error('Missing task');
    let entered!: () => void; let finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let calls = 0;
    const execution = runKarakeep(db.db, { async create(url) { calls++; entered(); await gate; return { kind: 'created', bookmark: { id: 'late', url } }; }, async checkUrl() { return { kind: 'uncertain' }; } }, result.task.id);
    try {
      await started;
      await db.pool.query('delete from pgboss.job where id=$1', [result.task.jobId]);
      await recoverKarakeep(db.db, boss);
      finish(); await execution;
      expect((await db.pool.query('select state, error_code, execution_token from processing_tasks where id=$1', [result.task.id])).rows[0]).toEqual({ state: 'needs_input', error_code: 'karakeep_uncertain', execution_token: null });
      await runKarakeep(db.db, { async create() { calls++; return { kind: 'uncertain' }; }, async checkUrl() { return { kind: 'uncertain' }; } }, result.task.id);
      expect(calls).toBe(1);
    } finally { finish(); await execution; }
  });

  it.each([401, 403])('pauses on %s and resumes only on restart with repaired credentials', async status => {
    received = []; responseStatus = status; responseBody = { error: 'unauthorized' };
    const config = { databaseUrl, origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, trustedProxies: [], karakeep: { baseUrl, token: 'bad-token' } };
    let application = await buildApplication(config);
    const state = async (id: string) => (await db.pool.query('select state, attempt_count, error_code from processing_tasks where id=$1', [id])).rows[0];
    const submit = async () => {
      const id = await article(originalUrl);
      const response = await application.app.inject({ method: 'POST', url: `/api/v1/articles/${id}/karakeep`, headers: { host: 'localhost:3000' }, payload: {} });
      expect(response.statusCode).toBe(202);
      return response.json().taskId as string;
    };
    try {
      const first = await submit();
      await eventually(async () => (await state(first)).state === 'paused_auth');
      const second = await submit();
      await eventually(async () => (await state(second)).state === 'paused_auth');
      expect(received).toHaveLength(1);
      expect(await state(first)).toMatchObject({ state: 'paused_auth', attempt_count: 1, error_code: 'karakeep_auth' });
      expect(await state(second)).toMatchObject({ state: 'paused_auth', attempt_count: 0, error_code: 'karakeep_auth' });
      const apiStatus = await application.app.inject({ url: `/api/v1/processing-tasks/${second}`, headers: { host: 'localhost:3000' } });
      expect(apiStatus.json()).toMatchObject({ state: 'paused_auth', nextStep: expect.stringContaining('restart') });
      await recoverKarakeep(db.db, boss);
      await delay(1500);
      expect((await state(first)).state).toBe('paused_auth');
      expect((await state(second)).state).toBe('paused_auth');
      expect(received).toHaveLength(1);
      await application.close();
      // A lost running intent is ambiguous, even while other tasks are paused.
      const orphan = await new KarakeepJobs(db.db, boss).start(await article(originalUrl));
      if (orphan.kind !== 'task') throw new Error('Missing task');
      await db.pool.query("update processing_tasks set state='running' where id=$1", [orphan.task.id]);
      await db.pool.query('delete from pgboss.job where id=$1', [orphan.task.jobId]);
      responseStatus = 201; responseBody = { id: 'repaired', content: { type: 'link', url: originalUrl } };
      application = await buildApplication({ ...config, karakeep: { baseUrl, token: 'repaired-token' } });
      await eventually(async () => (await state(first)).state === 'succeeded' && (await state(second)).state === 'succeeded');
      expect(received).toHaveLength(3);
      expect(received.slice(1).every(request => request.authorization === 'Bearer repaired-token')).toBe(true);
      expect(await state(orphan.task.id)).toMatchObject({ state: 'needs_input', error_code: 'karakeep_uncertain' });
    } finally { await application.close(); }
  }, 45000);

  it('runs the pg-boss worker without FreshRSS or mutating an existing bookmark', async () => {
    const existing = { url: originalUrl, favorite: true, tags: ['keep'], note: 'unchanged' };
    fixtureBookmarks = [structuredClone(existing)];
    received = []; responseStatus = 200; responseBody = { id: 'already-there', content: { type: 'link', url: originalUrl } };
    const application = await buildApplication({ databaseUrl, origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, trustedProxies: [], karakeep: { baseUrl, token: 'fixture-token' } });
    try {
      const id = await article(originalUrl);
      const response = await application.app.inject({ method: 'POST', url: `/api/v1/articles/${id}/karakeep`, headers: { host: 'localhost:3000' }, payload: {} });
      expect(response.statusCode).toBe(202);
      const taskId = response.json().taskId as string;
      await eventually(async () => (await db.pool.query('select state from processing_tasks where id=$1', [taskId])).rows[0].state === 'succeeded');
      expect(received).toEqual([{ method: 'POST', path: '/api/v1/bookmarks', body: { type: 'link', url: originalUrl }, authorization: 'Bearer fixture-token' }]);
      expect(fixtureBookmarks).toEqual([existing]);
      expect((await db.pool.query('select result from processing_tasks where id=$1', [taskId])).rows[0].result.outcome).toBe('existing');
    } finally { await application.close(); }
  }, 30000);
});
