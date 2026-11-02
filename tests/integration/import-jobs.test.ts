import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
        if (!cursor) return { items: [entry('first')], continuation: 'next' };
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
    const starts = await Promise.all(Array.from({ length: 8 }, () => imports.startImport(context.id)));
    expect(new Set(starts.map((x) => x.run.id)).size).toBe(1);
    expect(starts.filter((x) => !x.reused)).toHaveLength(1);
    const runId = starts[0]!.run.id;
    await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [runId])).rows[0].status === 'queued');
    // Wait for the failed execution to settle in pg-boss before accelerating its retry.
    await eventually(async () => (await database.pool.query("select count(*)::int n from pgboss.job where name='import' and data->>'runId'=$1 and state='retry'", [runId])).rows[0].n === 1);
    const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [], imports: { jobs: imports, contextId: context.id } });
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
    expect(partial.rows.map((r: { freshrss_id: string }) => r.freshrss_id)).toEqual(['absent-but-durable', 'first']);
    await database.pool.query('update articles set is_read=true where id=$1', [oldId]);
    fail = false;
    await database.pool.query("update pgboss.job set start_after=now() where name='import' and data->>'runId'=$1 and state='retry'", [runId]);
    await eventually(async () => (await database.pool.query('select status from processing_runs where id=$1', [runId])).rows[0].status === 'succeeded');
    const run = (await database.pool.query('select phase, fetched_count, pending_count, confirmed_count from processing_runs where id=$1', [runId])).rows[0];
    expect(run).toEqual({ phase: 'complete', fetched_count: 2, pending_count: 0, confirmed_count: 3 });
    expect(cursors).toEqual([undefined, 'next', undefined, 'next']);
    expect(reads.sort()).toEqual(['absent-but-durable', 'first', 'second']);
    expect(marks.sort()).toEqual(['first', 'second']);
    const final = await database.pool.query('select freshrss_id, is_read from articles where context_id=$1 order by freshrss_id', [context.id]);
    expect(final.rows).toEqual([{ freshrss_id: 'absent-but-durable', is_read: true }, { freshrss_id: 'first', is_read: false }, { freshrss_id: 'second', is_read: false }]);
    const tasks = await database.pool.query('select count(*)::int as n from processing_tasks t join articles a on a.id=t.article_id where a.context_id=$1', [context.id]);
    expect(tasks.rows[0].n).toBe(0);
  }, 60000);

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
