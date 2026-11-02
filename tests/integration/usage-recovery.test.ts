import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { PostgresUsageAdmissionStore } from '../../src/server/adapters/postgres/usage-admission-store.js';
import type { ReservationIntent, TerminalUsage } from '../../src/server/domain/usage.js';
import { createUsageDatabase } from '../helpers/usage-database.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let other: pg.Pool;
let store: PostgresUsageAdmissionStore;
const clock = { now: () => new Date('2020-01-01T00:00:00Z') };
const signal = () => new AbortController().signal;
const intent: ReservationIntent = { bucket: 'automatic', role: 'summary', provider: 'p', model: 'm' };
const usage: TerminalUsage = { status: 'succeeded', inputTokens: 4, outputTokens: 5, costUsd: null, tokensSource: 'provider', costSource: 'unknown', outcomeCode: null };
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}
function wrapPool(pool: pg.Pool, hook: (sql: string) => Promise<void>): pg.Pool {
  return new Proxy(pool, { get(target, key) {
    if (key === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(inner, property) {
        if (property === 'query') return async (...args: unknown[]) => { await hook(String(args[0])); return Reflect.apply(inner.query, inner, args) as Promise<unknown>; };
        const value = Reflect.get(inner, property, inner) as unknown;
        return typeof value === 'function' ? value.bind(inner) : value;
      } });
    };
    const value = Reflect.get(target, key, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function reserve(owner: Parameters<PostgresUsageAdmissionStore['reserve']>[0]) {
  const result = await store.reserve(owner, intent);
  if (!result.admitted) throw new Error('expected reservation');
  return result.reservation;
}
beforeAll(async () => { db = await createUsageDatabase(); other = new pg.Pool(db.pool.options); await migrateDatabase(db.pool); }, 30000);
afterAll(async () => { try { await other?.end(); } finally { await db?.dispose(); } }, 30000);
beforeEach(async () => {
  await other.query("delete from usage_ledger; delete from request_counters; update budget_settings set daily_requests=50, concurrency=1");
  store = new PostgresUsageAdmissionStore(db.pool, clock);
});

describe('dead-owner recovery', () => {
  it('fails closed for a privileged sweeper in a different login scope', async () => {
    await other.query("create role recovery_other login superuser password 'test-password'");
    const url = new URL(db.pool.options.connectionString!);
    url.username = 'recovery_other'; url.password = 'test-password';
    const sweeper = new pg.Pool({ connectionString: url.toString() });
    try {
      await store.withOwner(signal(), async (owner) => {
        const handle = await reserve(owner);
        await other.query(`insert into usage_ledger(id,bucket,role,provider,model,occurred_at,status,owner_token,owner_pid,owner_backend_start)
          values ('00000000-0000-0000-0000-000000000001','automatic','summary','p','m','2018-01-01','reserved',gen_random_uuid(),2147483647,'2018-01-01')`);
        const before = (await other.query('select * from usage_ledger order by id')).rows;
        const counters = (await other.query('select * from request_counters')).rows;
        await expect(new PostgresUsageAdmissionStore(db.pool, clock, sweeper).recover()).rejects.toThrow('Usage owner liveness unavailable');
        expect((await other.query('select * from usage_ledger order by id')).rows).toEqual(before);
        expect((await other.query('select * from request_counters')).rows).toEqual(counters);
        await store.withOwner(signal(), async (another) => { expect(await store.reserve(another, intent)).toEqual({ admitted: false, reason: 'concurrency_limit' }); });
        expect(await store.settle(owner, handle, usage)).toBe('settled');
      });
    } finally { await sweeper.end(); await other.query('drop role recovery_other'); }
  });

  it('fails closed for an exact backend identity in another database', async () => {
    const url = new URL(db.pool.options.connectionString!);
    url.pathname = '/postgres';
    const foreign = new pg.Pool({ connectionString: url.toString() });
    const foreignClient = await foreign.connect();
    try {
      const identity = (await foreignClient.query('select pg_backend_pid() as pid, backend_start::text as started from pg_stat_activity where pid=pg_backend_pid()')).rows[0];
      await store.withOwner(signal(), async (owner) => {
        const handle = await reserve(owner);
        const original = (await other.query('select owner_pid, owner_backend_start::text from usage_ledger where id=$1', [handle.id])).rows[0];
        await other.query('update usage_ledger set owner_pid=$1, owner_backend_start=$2 where id=$3', [identity.pid, identity.started, handle.id]);
        const before = (await other.query('select * from usage_ledger where id=$1', [handle.id])).rows[0];
        try {
          await expect(store.recover()).rejects.toThrow('Usage owner liveness unavailable');
          expect((await other.query('select * from usage_ledger where id=$1', [handle.id])).rows[0]).toEqual(before);
        } finally {
          await other.query('update usage_ledger set owner_pid=$1, owner_backend_start=$2 where id=$3', [original.owner_pid, original.owner_backend_start, handle.id]);
        }
        expect(await store.settle(owner, handle, usage)).toBe('settled');
      });
    } finally { foreignClient.release(); await foreign.end(); }
  });

  it.each(['active', 'between', 'commit'])('contains a checked-out transport error %s queries in a subprocess', async (phase) => {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'tests/helpers/usage-recovery-transport.ts', db.pool.options.connectionString!, phase], { timeout: 15000 });
    expect(result.stdout).toContain('transport contained');
  });
  it('preserves an old live owner, then recovers a terminated backend once without changing usage or credit', async () => {
    let handle!: Awaited<ReturnType<typeof reserve>>;
    let stale!: Parameters<PostgresUsageAdmissionStore['reserve']>[0];
    const ready = gate(); const proceed = gate();
    const task = store.withOwner(signal(), async (owner) => {
      stale = owner; handle = await reserve(owner);
      await other.query("update usage_ledger set input_tokens=7, output_tokens=8, cost_usd=1.25, tokens_source='provider', cost_source='provider' where id=$1", [handle.id]);
      ready.open(); await proceed.wait;
    });
    await ready.wait;
    const before = (await other.query('select * from usage_ledger where id=$1', [handle.id])).rows[0];
    try {
      expect(await store.recover()).toBe(0);
      expect((await other.query('select * from usage_ledger where id=$1', [handle.id])).rows[0]).toEqual(before);
      const lost = new Promise<void>((resolve) => stale.signal.addEventListener('abort', () => resolve(), { once: true }));
      await other.query('select pg_terminate_backend($1)', [before.owner_pid]);
      await lost;
    } finally { proceed.open(); await task.catch(() => {}); }
    expect(await store.recover()).toBe(1);
    const after = (await other.query('select * from usage_ledger where id=$1', [handle.id])).rows[0];
    expect(after).toEqual({ ...before, status: 'uncertain', outcome_code: 'owner_lost', settled_at: expect.any(Date) });
    expect(await store.recover()).toBe(0);
    expect(await store.settle(stale, handle, usage)).toBe('ownership_lost');
    expect((await other.query('select * from usage_ledger where id=$1', [handle.id])).rows[0]).toEqual(after);
    expect((await other.query('select day_utc::text as day, requests from request_counters')).rows).toEqual([{ day: '2020-01-01', requests: 1 }]);
    await store.withOwner(signal(), async (owner) => { expect((await store.reserve(owner, intent)).admitted).toBe(true); });
  });

  it('treats a visible PID with different backend start as dead and rejects stale settlement', async () => {
    await store.withOwner(signal(), async (owner) => {
      const handle = await reserve(owner);
      await other.query("update usage_ledger set owner_backend_start=owner_backend_start + interval '1 microsecond' where id=$1", [handle.id]);
      expect(await store.recover()).toBe(1);
      expect(await store.settle(owner, handle, usage)).toBe('ownership_lost');
      expect((await other.query('select status, outcome_code from usage_ledger where id=$1', [handle.id])).rows[0]).toEqual({ status: 'uncertain', outcome_code: 'owner_lost' });
    });
  });

  it('advances past more than a page of live owners and recovers dead rows in multiple buckets', async () => {
    await store.withOwner(signal(), async (owner) => {
      const handle = await reserve(owner);
      await other.query(`insert into usage_ledger(id,bucket,role,provider,model,occurred_at,status,owner_token,owner_pid,owner_backend_start)
        select (lpad(to_hex(n), 32, '0'))::uuid, 'automatic','summary','p','m','2019-01-01','reserved',gen_random_uuid(),owner_pid,owner_backend_start
        from usage_ledger cross join generate_series(1, 101) n where id=$1`, [handle.id]);
      await other.query(`insert into usage_ledger(id,bucket,role,provider,model,occurred_at,status,owner_token,owner_pid,owner_backend_start)
        select 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'automatic','summary','p','m','2018-01-01','reserved',gen_random_uuid(),owner_pid,owner_backend_start + interval '1 microsecond' from usage_ledger where id=$1`, [handle.id]);
      await other.query(`insert into usage_ledger(bucket,role,provider,model,occurred_at,status,owner_token,owner_pid,owner_backend_start)
        select 'classifier','summary','p','m','2017-01-01','reserved',gen_random_uuid(),owner_pid,owner_backend_start + interval '1 microsecond' from usage_ledger where id=$1`, [handle.id]);
      expect(await store.recover()).toBe(2);
      expect((await other.query("select status,count(*)::int from usage_ledger group by status order by status")).rows).toEqual([{ status: 'reserved', count: 102 }, { status: 'uncertain', count: 2 }]);
      expect(await store.recover()).toBe(0);
    });
  });

  it('serializes concurrent sweepers and a settlement behind the bucket lock', async () => {
    await store.withOwner(signal(), async (owner) => {
      const handle = await reserve(owner);
      await other.query("update usage_ledger set owner_backend_start=owner_backend_start + interval '1 microsecond' where id=$1", [handle.id]);
      const reached = gate(); const proceed = gate();
      const recovery = new PostgresUsageAdmissionStore(wrapPool(other, async (sql) => { if (sql.includes('pg_stat_clear_snapshot')) { reached.open(); await proceed.wait; } }), clock);
      const first = recovery.recover();
      await reached.wait;
      const second = store.recover();
      const settlement = store.settle(owner, handle, usage);
      try {
        let waiting = false;
        for (let i = 0; i < 100 && !waiting; i++) {
          waiting = Boolean((await other.query("select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock'", [`feedrafter-usage:${owner.token}`])).rowCount);
          if (!waiting) await delay(10);
        }
        expect(waiting).toBe(true);
      } finally { proceed.open(); }
      expect((await Promise.all([first, second])).sort()).toEqual([0, 1]);
      expect(await settlement).toBe('ownership_lost');
      expect((await other.query('select status,outcome_code,input_tokens from usage_ledger where id=$1', [handle.id])).rows[0]).toEqual({ status: 'uncertain', outcome_code: 'owner_lost', input_tokens: null });
      expect((await other.query('select requests from request_counters')).rows).toEqual([{ requests: 1 }]);
    });
  });

  it('does not overwrite settlement that wins the bucket lock', async () => {
    await store.withOwner(signal(), async (owner) => {
      const handle = await reserve(owner);
      const reached = gate(); const proceed = gate();
      const recovery = new PostgresUsageAdmissionStore(wrapPool(other, async (sql) => {
        if (sql.includes('budget_settings') && sql.includes('for update')) { reached.open(); await proceed.wait; }
      }), clock);
      const sweep = recovery.recover();
      await reached.wait;
      try { expect(await store.settle(owner, handle, usage)).toBe('settled'); }
      finally { proceed.open(); }
      expect(await sweep).toBe(0);
      expect((await other.query('select status,input_tokens,output_tokens from usage_ledger where id=$1', [handle.id])).rows[0]).toEqual({ status: 'succeeded', input_tokens: 4, output_tokens: 5 });
    });
  });

  it('leaves rows untouched when a probe fails or identity is inaccessible', async () => {
    await store.withOwner(signal(), async (owner) => {
      await reserve(owner);
      await other.query(`insert into usage_ledger(id,bucket,role,provider,model,occurred_at,status,owner_token,owner_pid,owner_backend_start)
        values ('00000000-0000-0000-0000-000000000001','automatic','summary','p','m','2018-01-01','reserved',gen_random_uuid(),2147483647,'2018-01-01')`);
      const before = (await other.query('select * from usage_ledger order by id')).rows;
      const broken = new PostgresUsageAdmissionStore(wrapPool(other, async (sql) => { if (sql.includes('pg_stat_clear_snapshot')) throw new Error('probe failed'); }), clock);
      await expect(broken.recover()).rejects.toThrow('probe failed');
      await other.query("create role recovery_unprivileged login password 'test-password'; grant select, update on budget_settings, usage_ledger to recovery_unprivileged");
      const url = new URL(db.pool.options.connectionString!);
      url.username = 'recovery_unprivileged'; url.password = 'test-password';
      const restrictedPool = new pg.Pool({ connectionString: url.toString() });
      try {
        expect((await restrictedPool.query('select current_user as name')).rows[0].name).toBe('recovery_unprivileged');
        const restricted = new PostgresUsageAdmissionStore(restrictedPool, clock);
        await expect(restricted.recover()).rejects.toThrow('Usage owner liveness unavailable');
      } finally { await restrictedPool.end(); await other.query('drop owned by recovery_unprivileged; drop role recovery_unprivileged'); }
      expect((await other.query('select * from usage_ledger order by id')).rows).toEqual(before);
    });
  });
});
