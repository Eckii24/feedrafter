import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { get, request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';
import { ImportJobs } from '../../src/server/adapters/postgres/import-jobs.js';
import { provisionImportQueues, recoverImports, startImportWorkers } from '../../src/server/adapters/postgres/import-runner.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { buildHttpApp } from '../../src/server/http/app.js';
import type { FreshRssEntry, FreshRssPort } from '../../src/server/ports/freshrss.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();
let container = '';
let database: ReturnType<typeof createDatabase>;
let boss: PgBoss;
let databaseUrl: string;
const clients = new Map<string, FreshRssPort>();
const entry = (id: string): FreshRssEntry => ({ id, title: id, url: null, author: null, publishedAt: null, feedId: null, feedTitle: null });
async function eventually(check: () => Promise<boolean>, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await delay(100); }
  throw new Error('Timed out waiting for import');
}

beforeAll(async () => {
  container = docker('run', '--detach', '--rm', '--pull=never', '--name', `feedrafter-import-${randomUUID()}`,
    '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
  const match = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'));
  if (!match) throw new Error('Unexpected PostgreSQL port');
  const url = `postgresql://postgres:disposable-test-only@127.0.0.1:${match[1]}/feedrafter_test`;
  databaseUrl = url;
  database = createDatabase(url);
  await eventually(async () => { try { await database.pool.query('select 1'); return true; } catch { return false; } });
  await migrateDatabase(database.pool);
  boss = new PgBoss({ connectionString: url });
  boss.on('error', () => {});
  await boss.start();
}, 30000);

afterAll(async () => {
  try { if (boss) await boss.stop(); if (database) await database.close(); }
  finally { if (container) docker('rm', '--force', container); }
});

describe('real import coordinator', () => {
  it('atomically creates/coalesces jobs, retries incomplete scans and reconciles exact durable IDs', async () => {
    const store = new ImportStore(database.db);
    const context = await store.ensureContext('job-test', 'account');
    const imports = new ImportJobs(database.db, boss);
    // Missing queue makes boss.send fail: the run must roll back with the job.
    await expect(imports.startImport(context.id)).rejects.toThrow();
    expect((await database.pool.query('select count(*)::int n from processing_runs')).rows[0].n).toBe(0);
    await provisionImportQueues(boss);
    // Exit a producer process immediately after commit, before registering any worker.
    const committedContext = await store.ensureContext('committed-before-worker', 'account');
    const producer = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { PgBoss } from 'pg-boss';
      import { createDatabase } from './src/server/adapters/postgres/client.ts';
      import { ImportJobs } from './src/server/adapters/postgres/import-jobs.ts';
      const db = createDatabase(process.env.TEST_DATABASE_URL);
      const boss = new PgBoss({ connectionString: process.env.TEST_DATABASE_URL });
      boss.on('error', () => {});
      await boss.start();
      const result = await new ImportJobs(db.db, boss).startImport(process.env.TEST_CONTEXT_ID);
      process.stdout.write(result.run.id, () => process.exit(23));
    `], { encoding: 'utf8', timeout: 15000, env: { ...process.env, TEST_DATABASE_URL: databaseUrl, TEST_CONTEXT_ID: committedContext.id } });
    expect(producer.error).toBeUndefined();
    expect(producer.status, producer.stderr).toBe(23);
    const committedRunId = producer.stdout.trim();
    expect(committedRunId).toMatch(/^[0-9a-f-]{36}$/);
    const jobsBefore = await database.pool.query("select id, state from pgboss.job where name='import' and data->>'runId'=$1", [committedRunId]);
    expect(jobsBefore.rows).toHaveLength(1);
    expect(jobsBefore.rows[0].state).toBe('created');
    await boss.stop();
    boss = new PgBoss({ connectionString: databaseUrl });
    boss.on('error', () => {});
    await boss.start();
    clients.set(committedContext.id, {
      async listUnreadPage() { return { items: [], continuation: null }; },
      async getReadState() { throw new Error('Unexpected reconciliation'); },
      async markRead() { throw new Error('Unexpected acknowledgement'); },
    });
    const [oldId] = await store.importPage(context.id, [entry('absent-but-durable')], new Date());
    await store.makePendingEligible(context.id);
    let fail = true;
    let finishedScan = false;
    const reads: string[] = [];
    const marks: string[] = [];
    const cursors: Array<string | undefined> = [];
    const fake: FreshRssPort = {
      async listUnreadPage(cursor) {
        cursors.push(cursor);
        if (!cursor) return { items: [{ ...entry('first'), url: 'https://example.test/shared' }], continuation: 'next' };
        if (cursor === 'next') return { items: [{ ...entry('9007199254740993123'), url: 'https://example.test/shared' }], continuation: 'last' };
        if (fail) return { items: [entry('second'), entry('')], continuation: null };
        finishedScan = true;
        return { items: [entry('second')], continuation: null };
      },
      async getReadState(ids) {
        expect(finishedScan).toBe(true);
        const phase = await database.pool.query("select phase from processing_runs where context_id=$1 and status='running'", [context.id]);
        expect(phase.rows[0]?.phase).toBe('ack');
        reads.push(...ids);
        return new Map(ids.map((id) => [id, id === 'absent-but-durable']));
      },
      async markRead(ids) {
        expect(finishedScan).toBe(true);
        const rows = await database.pool.query('select freshrss_id from articles where context_id=$1 and freshrss_id=any($2::text[])', [context.id, ids]);
        expect(rows.rowCount).toBe(ids.length);
        marks.push(...ids);
      },
    };
    // Keep the scheduled startup wake from creating another run while testing.
    await store.saveSettings({ importEnabled: false, importIntervalSeconds: 14400, nextImportAt: null });
    clients.set(context.id, fake);
    await startImportWorkers(database.pool, database.db, boss, async (contextId) => {
      const client = clients.get(contextId);
      if (!client) throw new Error('Missing test client');
      return client;
    });
    await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [committedRunId])).rows[0].status === 'succeeded');
    expect((await database.pool.query("select id from pgboss.job where name='import' and data->>'runId'=$1", [committedRunId])).rows.map(row => row.id)).toEqual([jobsBefore.rows[0].id]);
    const restartedImports = new ImportJobs(database.db, boss);
    const starts = await Promise.all(Array.from({ length: 8 }, () => restartedImports.startImport(context.id)));
    expect(new Set(starts.map((x) => x.run.id)).size).toBe(1);
    expect(starts.filter((x) => !x.reused)).toHaveLength(1);
    const runId = starts[0]!.run.id;
    await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [runId])).rows[0].status === 'queued');
    // Wait for the failed execution to settle in pg-boss before accelerating its retry.
    await eventually(async () => (await database.pool.query("select count(*)::int n from pgboss.job where name='import' and data->>'runId'=$1 and state='retry'", [runId])).rows[0].n === 1);
    const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [], imports: { jobs: restartedImports, contextId: context.id } });
    try {
      const start = await app.inject({ method: 'POST', url: '/api/v1/pipeline/runs', headers: { host: 'localhost:3000' }, payload: {} });
      expect(start.statusCode).toBe(202);
      expect(start.json()).toMatchObject({ runId, reused: true });
      const status = await app.inject({ url: `/api/v1/pipeline/runs/${runId}`, headers: { host: 'localhost:3000' } });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ id: runId, status: 'queued', phase: 'fetch' });
      expect(status.json().executionOwner).toBeUndefined();
    } finally { await app.close(); }
    expect(marks).toEqual([]);
    expect(reads).toEqual([]);
    const partial = await database.pool.query('select freshrss_id from articles where context_id=$1 order by freshrss_id', [context.id]);
    expect(partial.rows.map((r: { freshrss_id: string }) => r.freshrss_id)).toEqual(['9007199254740993123', 'absent-but-durable', 'first']);
    await database.pool.query('update articles set is_read=true where id=$1', [oldId]);
    fail = false;
    await database.pool.query("update pgboss.job set start_after=now() where name='import' and data->>'runId'=$1 and state='retry'", [runId]);
    await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [runId])).rows[0].status === 'succeeded');
    const run = (await database.pool.query('select phase, fetched_count, pending_count, confirmed_count from processing_runs where id=$1', [runId])).rows[0];
    expect(run).toEqual({ phase: 'complete', fetched_count: 3, pending_count: 0, confirmed_count: 4 });
    expect(cursors).toEqual([undefined, 'next', 'last', undefined, 'next', 'last']);
    expect(reads.sort()).toEqual(['9007199254740993123', 'absent-but-durable', 'first', 'second']);
    expect(marks.sort()).toEqual(['9007199254740993123', 'first', 'second']);
    const final = await database.pool.query('select freshrss_id, is_read, url from articles where context_id=$1 order by freshrss_id', [context.id]);
    expect(final.rows).toEqual([{ freshrss_id: '9007199254740993123', is_read: false, url: 'https://example.test/shared' }, { freshrss_id: 'absent-but-durable', is_read: true, url: null }, { freshrss_id: 'first', is_read: false, url: 'https://example.test/shared' }, { freshrss_id: 'second', is_read: false, url: null }]);
    const tasks = await database.pool.query('select count(*)::int as n from processing_tasks t join articles a on a.id=t.article_id where a.context_id=$1', [context.id]);
    expect(tasks.rows[0].n).toBe(0);
  }, 60000);

  it('rolls back the run and job when commit fails after enqueue', async () => {
    const context = await new ImportStore(database.db).ensureContext('after-enqueue-rollback', 'account');
    await database.pool.query(`create function test_fail_after_enqueue() returns trigger language plpgsql as $$
      begin
        if not exists (select 1 from pgboss.job where name = 'import' and data->>'runId' = new.id::text) then
          raise exception 'job missing before injected failure';
        end if;
        raise exception 'injected after enqueue';
      end $$`);
    await database.pool.query(`create constraint trigger test_fail_after_enqueue after insert on processing_runs
      deferrable initially deferred for each row when (new.context_id = '${context.id}'::uuid)
      execute function test_fail_after_enqueue()`);
    try {
      await expect(new ImportJobs(database.db, boss).startImport(context.id)).rejects.toMatchObject({ cause: { message: 'injected after enqueue' } });
      expect((await database.pool.query('select id from processing_runs where context_id=$1', [context.id])).rowCount).toBe(0);
      const orphans = await database.pool.query("select j.id from pgboss.job j where j.name='import' and not exists (select 1 from processing_runs r where r.id::text=j.data->>'runId')");
      expect(orphans.rowCount).toBe(0);
    } finally {
      await database.pool.query('drop trigger test_fail_after_enqueue on processing_runs');
      await database.pool.query('drop function test_fail_after_enqueue()');
    }
  });

  it('coalesces each context independently while different contexts execute concurrently', async () => {
    const store = new ImportStore(database.db);
    const first = await store.ensureContext('concurrency', 'first');
    const second = await store.ensureContext('concurrency', 'second');
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake: FreshRssPort = {
      async listUnreadPage() { entered++; await gate; return { items: [], continuation: null }; },
      async getReadState() { throw new Error('Unexpected reconciliation'); },
      async markRead() { throw new Error('Unexpected acknowledgement'); },
    };
    clients.set(first.id, fake);
    clients.set(second.id, fake);
    const imports = new ImportJobs(database.db, boss);
    try {
      const [a, b] = await Promise.all([imports.startImport(first.id), imports.startImport(second.id)]);
      await eventually(async () => entered === 2);
      const [sameA, sameB] = await Promise.all([imports.startImport(first.id), imports.startImport(second.id)]);
      expect(sameA).toMatchObject({ reused: true, run: { id: a.run.id } });
      expect(sameB).toMatchObject({ reused: true, run: { id: b.run.id } });
      expect(a.run.id).not.toBe(b.run.id);
      release();
      await eventually(async () => (await database.pool.query("select count(*)::int n from processing_runs where id=any($1::uuid[]) and status='succeeded'", [[a.run.id, b.run.id]])).rows[0].n === 2);
    } finally { release(); }
  }, 30000);

  it('returns the completed run snapshot after an SSE disconnect and reconnect', async () => {
    const store = new ImportStore(database.db);
    const context = await store.ensureContext('sse-reconnect', 'account');
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    clients.set(context.id, {
      async listUnreadPage() { entered = true; await gate; return { items: [], continuation: null }; },
      async getReadState() { throw new Error('Unexpected reconciliation'); },
      async markRead() { throw new Error('Unexpected acknowledgement'); },
    });
    const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [], imports: { jobs: new ImportJobs(database.db, boss), contextId: context.id } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { host: 'localhost:3000' };
    const connect = () => new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      get(`${base}/api/v1/events`, { headers }, resolve).on('error', reject);
    });
    const jsonRequest = (path: string, method: 'GET' | 'POST') => new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
      const req = request(`${base}${path}`, { method, headers: { ...headers, origin: 'http://localhost:3000', 'content-type': 'application/json' } }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) as unknown }));
      });
      req.on('error', reject); req.end(method === 'POST' ? '{}' : undefined);
    });
    let stream: import('node:http').IncomingMessage | undefined;
    try {
      stream = await connect();
      expect(await new Promise<string>(resolve => stream!.once('data', chunk => resolve(String(chunk))))).toContain(': connected');
      const changed = new Promise<string>(resolve => stream!.once('data', chunk => resolve(String(chunk))));
      const start = await jsonRequest('/api/v1/pipeline/runs', 'POST');
      expect(start.status).toBe(202);
      const { runId } = start.body as { runId: string };
      expect(await changed).toContain('pipeline.changed');
      await eventually(async () => entered);
      stream.destroy();
      release();
      await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [runId])).rows[0].status === 'succeeded');
      stream = await connect();
      expect(await new Promise<string>(resolve => stream!.once('data', chunk => resolve(String(chunk))))).toContain(': connected');
      const snapshot = await jsonRequest(`/api/v1/pipeline/runs/${runId}`, 'GET');
      expect(snapshot.status).toBe(200);
      expect(snapshot.body).toMatchObject({ id: runId, status: 'succeeded', phase: 'complete' });
    } finally {
      release();
      stream?.destroy();
      await app.close();
    }
  }, 30000);

  it('retains uncertain acknowledgements for exact-ID reconciliation on a later complete scan', async () => {
    const store = new ImportStore(database.db);
    const context = await store.ensureContext('uncertain-ack', 'account');
    let firstScan = true;
    let attempts = 0;
    const queried: string[] = [];
    const fake: FreshRssPort = {
      async listUnreadPage() { return { items: firstScan ? [entry('uncertain')] : [], continuation: null }; },
      async getReadState(ids) { queried.push(...ids); return new Map(ids.map((id) => [id, !firstScan])); },
      async markRead() { attempts++; throw new Error('Unknown mutation outcome'); },
    };
    clients.set(context.id, fake);
    const imports = new ImportJobs(database.db, boss);
    const first = await imports.startImport(context.id);
    await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [first.run.id])).rows[0].status === 'succeeded');
    const run = (await database.pool.query('select pending_count, error_code from processing_runs where id=$1', [first.run.id])).rows[0];
    expect(run).toEqual({ pending_count: 1, error_code: 'acknowledgement_pending' });
    expect(attempts).toBe(1);
    firstScan = false;
    const second = await imports.startImport(context.id);
    await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [second.run.id])).rows[0].status === 'succeeded');
    expect(queried).toEqual(['uncertain', 'uncertain']);
    expect(attempts).toBe(1);
    expect((await database.pool.query('select status from freshrss_acknowledgements where context_id=$1', [context.id])).rows).toEqual([{ status: 'confirmed' }]);
  }, 30000);

  it.each(['lost response', 'partial response'] as const)('retains an acknowledgement after a %s and reconciles on the next scan', async failure => {
    const context = await new ImportStore(database.db).ensureContext(`read-state-${failure}`, 'account');
    let first = true;
    const marks: string[] = [];
    let reads = 0;
    clients.set(context.id, {
      async listUnreadPage() { return { items: first ? [entry('uncertain')] : [], continuation: null }; },
      async getReadState(ids) {
        reads++;
        if (first && failure === 'lost response') throw new Error('response lost');
        if (first) return new Map();
        return new Map(ids.map(id => [id, true]));
      },
      async markRead(ids) { marks.push(...ids); },
    });
    const imports = new ImportJobs(database.db, boss);
    const initial = await imports.startImport(context.id);
    await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [initial.run.id])).rows[0].status === 'succeeded');
    expect((await database.pool.query('select status from freshrss_acknowledgements where context_id=$1', [context.id])).rows).toEqual([{ status: 'pending' }]);
    expect(marks).toEqual([]);
    first = false;
    const next = await imports.startImport(context.id);
    await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [next.run.id])).rows[0].status === 'succeeded');
    expect(reads).toBe(2); expect(marks).toEqual([]);
    expect((await database.pool.query('select status from freshrss_acknowledgements where context_id=$1', [context.id])).rows).toEqual([{ status: 'confirmed' }]);
  }, 30000);

  it('resumes a checkpointed acknowledgement after coordinator connection loss without rescanning', async () => {
    const store = new ImportStore(database.db);
    const context = await store.ensureContext('ack-checkpoint-recovery', 'account');
    let pages = 0;
    let reads = 0;
    let aborted = false;
    const marks: string[] = [];
    clients.set(context.id, {
      async listUnreadPage() { pages++; return { items: [entry('checkpointed')], continuation: null }; },
      async getReadState(ids, signal) {
        reads++;
        if (reads === 1) await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
        });
        return new Map(ids.map(id => [id, false]));
      },
      async markRead(ids) { marks.push(...ids); },
    });
    const { run } = await new ImportJobs(database.db, boss).startImport(context.id);
    await eventually(async () => reads === 1);
    expect((await database.pool.query('select phase from processing_runs where id=$1', [run.id])).rows[0].phase).toBe('ack');
    await database.pool.query('select pg_terminate_backend(pid) from pg_stat_activity where application_name=$1', [`feedrafter-import:${run.id}`]);
    await eventually(async () => aborted);
    await eventually(async () => (await database.pool.query("select count(*)::int n from pgboss.job where name='import' and data->>'runId'=$1 and state='retry'", [run.id])).rows[0].n === 1);
    expect(marks).toEqual([]);
    await database.pool.query("update pgboss.job set start_after=now() where name='import' and data->>'runId'=$1 and state='retry'", [run.id]);
    await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [run.id])).rows[0].status === 'succeeded');
    expect(pages).toBe(1);
    expect(reads).toBe(2);
    expect(marks).toEqual(['checkpointed']);
    expect((await database.pool.query('select status from freshrss_acknowledgements where context_id=$1', [context.id])).rows).toEqual([{ status: 'confirmed' }]);
  }, 30000);

  it('aborts on coordinator connection loss, fences stale ownership and resumes', async () => {
    const store = new ImportStore(database.db);
    const context = await store.ensureContext('connection-loss', 'account');
    let waiting = true;
    let entered = false;
    let aborted = false;
    const fake: FreshRssPort = {
      async listUnreadPage(_cursor, signal) {
        if (waiting) await new Promise<void>((_resolve, reject) => {
          entered = true;
          signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
        });
        return { items: [], continuation: null };
      },
      async getReadState() { throw new Error('Unexpected reconciliation'); },
      async markRead() { throw new Error('Unexpected acknowledgement'); },
    };
    clients.set(context.id, fake);
    const { run } = await new ImportJobs(database.db, boss).startImport(context.id);
    await eventually(async () => entered);
    const staleOwner = (await database.pool.query('select execution_owner from processing_runs where id=$1', [run.id])).rows[0].execution_owner as string;
    await database.pool.query('select pg_terminate_backend(pid) from pg_stat_activity where application_name=$1', [`feedrafter-import:${run.id}`]);
    await eventually(async () => aborted);
    await eventually(async () => (await database.pool.query("select count(*)::int n from pgboss.job where name='import' and data->>'runId'=$1 and state='retry'", [run.id])).rows[0].n === 1);
    waiting = false;
    await database.pool.query("update pgboss.job set start_after=now() where name='import' and data->>'runId'=$1 and state='retry'", [run.id]);
    await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [run.id])).rows[0].status === 'succeeded');
    expect(await new TaskStore(database.db).updateOwnedRun(run.id, staleOwner, { phase: 'fetch' })).toBeNull();
  }, 30000);

  it.each(['http', 'database'] as const)('leaves a failed %s page unacknowledged and retries the complete scan', async failure => {
    const context = await new ImportStore(database.db).ensureContext(`page-failure-${failure}`, 'account');
    const pages: string[] = [];
    const reads: string[] = [];
    const marks: string[] = [];
    let failing = true;
    if (failure === 'database') {
      await database.pool.query(`create function test_page_failure() returns trigger language plpgsql as $$
        begin if new.context_id = '${context.id}'::uuid and new.freshrss_id = 'second' then raise exception 'injected page failure'; end if; return new; end $$`);
      await database.pool.query('create trigger test_page_failure before insert on articles for each row execute function test_page_failure()');
    }
    clients.set(context.id, {
      async listUnreadPage(cursor) {
        pages.push(cursor ?? 'first');
        if (!cursor) return { items: [entry('first')], continuation: 'next' };
        if (failure === 'http' && failing) throw new Error('injected HTTP failure');
        return { items: [entry('second')], continuation: null };
      },
      async getReadState(ids) { reads.push(...ids); return new Map(ids.map(id => [id, false])); },
      async markRead(ids) { marks.push(...ids); },
    });
    try {
      const { run } = await new ImportJobs(database.db, boss).startImport(context.id);
      await eventually(async () => (await database.pool.query("select count(*)::int n from pgboss.job where name='import' and data->>'runId'=$1 and state='retry'", [run.id])).rows[0].n === 1);
      expect((await database.pool.query('select freshrss_id from articles where context_id=$1', [context.id])).rows).toEqual([{ freshrss_id: 'first' }]);
      expect(reads).toEqual([]); expect(marks).toEqual([]);
      if (failure === 'database') {
        await database.pool.query('drop trigger test_page_failure on articles');
        await database.pool.query('drop function test_page_failure()');
      }
      failing = false;
      await database.pool.query("update pgboss.job set start_after=now() where name='import' and data->>'runId'=$1 and state='retry'", [run.id]);
      await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [run.id])).rows[0].status === 'succeeded');
      expect(pages).toEqual(['first', 'next', 'first', 'next']);
      expect(reads.sort()).toEqual(['first', 'second']);
      expect(marks.sort()).toEqual(['first', 'second']);
    } finally {
      if (failure === 'database') {
        await database.pool.query('drop trigger if exists test_page_failure on articles');
        await database.pool.query('drop function if exists test_page_failure()');
      }
    }
  }, 30000);

  it('marks exhausted pagination retries failed without acknowledging the committed page', async () => {
    const context = await new ImportStore(database.db).ensureContext('permanent-page-failure', 'account');
    let scans = 0;
    const marks: string[] = [];
    clients.set(context.id, {
      async listUnreadPage(cursor) {
        if (!cursor) { scans++; return { items: [entry('saved')], continuation: 'next' }; }
        throw new Error('permanent upstream failure');
      },
      async getReadState() { throw new Error('Unexpected reconciliation'); },
      async markRead(ids) { marks.push(...ids); },
    });
    const { run } = await new ImportJobs(database.db, boss).startImport(context.id);
    // pg-boss increments retry_count when the next attempt is claimed, not on failure.
    for (let retry = 0; retry < 2; retry++) {
      await eventually(async () => (await database.pool.query("select count(*)::int n from pgboss.job where name='import' and data->>'runId'=$1 and state='retry' and retry_count=$2", [run.id, retry])).rows[0].n === 1);
      await database.pool.query("update pgboss.job set start_after=now() where name='import' and data->>'runId'=$1 and state='retry'", [run.id]);
    }
    await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [run.id])).rows[0].status === 'failed');
    expect(scans).toBe(3); expect(marks).toEqual([]);
    expect((await database.pool.query('select status, eligible from freshrss_acknowledgements where context_id=$1', [context.id])).rows).toEqual([{ status: 'pending', eligible: false }]);
  }, 30000);

  it('restarts from page one after losing the coordinator following a committed page', async () => {
    const context = await new ImportStore(database.db).ensureContext('page-commit-restart', 'account');
    const pages: string[] = [];
    const marks: string[] = [];
    let firstAttempt = true;
    let entered = false;
    let aborted = false;
    clients.set(context.id, {
      async listUnreadPage(cursor, signal) {
        pages.push(cursor ?? 'first');
        if (!cursor) return { items: [entry('saved')], continuation: 'next' };
        if (firstAttempt) await new Promise<void>((_resolve, reject) => {
          entered = true;
          signal!.addEventListener('abort', () => { aborted = true; reject(new Error('connection lost')); }, { once: true });
        });
        return { items: [entry('later')], continuation: null };
      },
      async getReadState(ids) { return new Map(ids.map(id => [id, false])); },
      async markRead(ids) { marks.push(...ids); },
    });
    const { run } = await new ImportJobs(database.db, boss).startImport(context.id);
    await eventually(async () => entered);
    expect((await database.pool.query('select freshrss_id from articles where context_id=$1', [context.id])).rows).toEqual([{ freshrss_id: 'saved' }]);
    expect(marks).toEqual([]);
    await database.pool.query('select pg_terminate_backend(pid) from pg_stat_activity where application_name=$1', [`feedrafter-import:${run.id}`]);
    await eventually(async () => aborted);
    await eventually(async () => (await database.pool.query("select count(*)::int n from pgboss.job where name='import' and data->>'runId'=$1 and state='retry'", [run.id])).rows[0].n === 1);
    firstAttempt = false;
    await database.pool.query("update pgboss.job set start_after=now() where name='import' and data->>'runId'=$1 and state='retry'", [run.id]);
    await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [run.id])).rows[0].status === 'succeeded');
    expect(pages).toEqual(['first', 'next', 'first', 'next']);
    expect(marks.sort()).toEqual(['later', 'saved']);
    expect((await database.pool.query('select count(*)::int n from articles where context_id=$1', [context.id])).rows[0].n).toBe(2);
  }, 30000);

  it('does not retry pending acknowledgements while a new scan is paginating', async () => {
    const store = new ImportStore(database.db);
    const context = await store.ensureContext('ack-pagination-race', 'account');
    let scan = 0;
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let ackEntered = false;
    let releaseAck!: () => void;
    const ackGate = new Promise<void>(resolve => { releaseAck = resolve; });
    const events: string[] = [];
    clients.set(context.id, {
      async listUnreadPage(cursor) {
        events.push(`page:${scan}:${cursor ?? 'first'}`);
        if (scan === 0) return { items: [entry('pending')], continuation: null };
        if (!cursor) return { items: [], continuation: 'last' };
        entered = true; await gate;
        return { items: [entry('new')], continuation: null };
      },
      async getReadState(ids) {
        events.push(`read:${ids[0]}`);
        if (scan === 1 && !ackEntered) { ackEntered = true; await ackGate; }
        return new Map(ids.map(id => [id, false]));
      },
      async markRead(ids) { events.push(`mark:${ids[0]}`); if (scan === 0) throw new Error('lost response'); },
    });
    const imports = new ImportJobs(database.db, boss);
    try {
      const first = await imports.startImport(context.id);
      await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [first.run.id])).rows[0].status === 'succeeded');
      expect((await database.pool.query('select status from freshrss_acknowledgements where context_id=$1', [context.id])).rows).toEqual([{ status: 'pending' }]);
      scan = 1;
      const second = await imports.startImport(context.id);
      await eventually(async () => entered);
      const same = await imports.startImport(context.id);
      expect(same).toMatchObject({ reused: true, run: { id: second.run.id } });
      expect(events).toEqual(['page:0:first', 'read:pending', 'mark:pending', 'page:1:first', 'page:1:last']);
      release();
      await eventually(async () => ackEntered);
      const whileAck = await imports.startImport(context.id);
      expect(whileAck).toMatchObject({ reused: true, run: { id: second.run.id } });
      expect(events.filter(event => event.startsWith('page:1'))).toEqual(['page:1:first', 'page:1:last']);
      releaseAck();
      await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [second.run.id])).rows[0].status === 'succeeded');
      expect(events.slice(5).sort()).toEqual(['mark:new', 'mark:pending', 'read:new', 'read:pending']);
      expect((await database.pool.query("select count(*)::int n from freshrss_acknowledgements where context_id=$1 and status='confirmed'", [context.id])).rows[0].n).toBe(2);
    } finally { release(); releaseAck(); }
  }, 30000);

  it('recovers an active run with no job', async () => {
    const store = new ImportStore(database.db);
    const context = await store.ensureContext('recovery', 'account');
    clients.set(context.id, {
      async listUnreadPage() { return { items: [], continuation: null }; },
      async getReadState() { throw new Error('Unexpected reconciliation'); },
      async markRead() { throw new Error('Unexpected acknowledgement'); },
    });
    const run = await new TaskStore(database.db).createRun(context.id, new Date());
    await recoverImports(database.db, boss);
    await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [run.id])).rows[0].status === 'succeeded');
  }, 30000);

  it('coalesces an overdue schedule to one elapsed-interval catch-up', async () => {
    const store = new ImportStore(database.db);
    const imports = new ImportJobs(database.db, boss);
    const now = new Date('2026-01-04T00:00:00Z');
    await store.saveSettings({ importEnabled: false, importIntervalSeconds: 14400, nextImportAt: new Date('2026-01-01Z') });
    expect(await imports.wakeDue(now)).toBe(0);
    await store.saveSettings({ importEnabled: true, importIntervalSeconds: 14400, nextImportAt: new Date('2026-01-01Z') });
    const contexts = (await database.pool.query('select count(*)::int n from import_contexts')).rows[0].n as number;
    expect(await imports.wakeDue(now)).toBe(contexts);
    expect(await imports.wakeDue(now)).toBe(0);
    expect((await store.getSettings()).nextImportAt).toEqual(new Date('2026-01-04T04:00:00Z'));
    await store.saveSettings({ importEnabled: false, importIntervalSeconds: 14400, nextImportAt: null });
  }, 30000);
});
