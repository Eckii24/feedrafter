import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { PostgresUsageAdmissionStore } from '../../src/server/adapters/postgres/usage-admission-store.js';
import type { ModelUsageBucket, ReservationIntent } from '../../src/server/domain/usage.js';
import { createUsageDatabase } from '../helpers/usage-database.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let other: pg.Pool;
let now: Date;
let store: PostgresUsageAdmissionStore;
const signal = () => new AbortController().signal;
const intent = (bucket: ModelUsageBucket = 'automatic'): ReservationIntent => ({ bucket, role: 'summary', provider: 'p', model: 'm', taskId: 'task', turnId: 'turn' });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const reserve = (bucket: ModelUsageBucket = 'automatic') => store.withOwner(signal(), (owner) => store.reserve(owner, intent(bucket)));

// Wrap only this test pool's checked-out query; the production adapter has no fault hooks.
function wrapQueries(pool: pg.Pool, wrap: (sql: string, run: () => Promise<unknown>) => Promise<unknown>): pg.Pool {
  return new Proxy(pool, { get(target, key) {
    if (key === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(inner, property) {
        if (property === 'query') return (...args: unknown[]) => wrap(String(args[0]), () => Reflect.apply(inner.query, inner, args) as Promise<unknown>);
        const value = Reflect.get(inner, property, inner) as unknown;
        return typeof value === 'function' ? value.bind(inner) : value;
      } });
    };
    const value = Reflect.get(target, key, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

beforeAll(async () => { db = await createUsageDatabase(); other = new pg.Pool(db.pool.options); await migrateDatabase(db.pool); }, 30000);
afterAll(async () => { try { await other?.end(); } finally { await db?.dispose(); } }, 30000);
beforeEach(async () => {
  await db.pool.query("delete from usage_ledger; delete from request_counters; update budget_settings set daily_requests = case bucket when 'classifier' then 2000 else 50 end, concurrency = case bucket when 'classifier' then 2 else 1 end");
  now = new Date('2026-01-02T12:00:00Z');
  store = new PostgresUsageAdmissionStore(db.pool, { now: () => now });
});

describe('atomic usage reservations', () => {
  it('serializes competing owners for the last daily credit', async () => {
    await db.pool.query("update budget_settings set daily_requests=1, concurrency=null where bucket='automatic'");
    const gate = deferred();
    const secondStore = new PostgresUsageAdmissionStore(other, { now: () => now });
    const results = await Promise.all([store, secondStore].map(async (current) => current.withOwner(signal(), async (owner) => {
      const result = await current.reserve(owner, intent());
      if (result.admitted) await gate.promise;
      else gate.resolve();
      return result;
    })));
    expect(results.filter((r) => r.admitted)).toHaveLength(1);
    expect(results.filter((r) => !r.admitted)).toEqual([{ admitted: false, reason: 'daily_limit' }]);
    expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 1 }]);
    expect((await db.pool.query('select status from usage_ledger')).rows).toEqual([{ status: 'reserved' }]);
  });

  it('enforces default bucket slots independently across concurrent owners', async () => {
    const gate = deferred();
    const ready = deferred();
    const results: Awaited<ReturnType<typeof reserve>>[] = [];
    const buckets: ModelUsageBucket[] = ['automatic', 'automatic', 'interactive', 'interactive', 'classifier', 'classifier', 'classifier'];
    const secondStore = new PostgresUsageAdmissionStore(other, { now: () => now });
    const tasks = buckets.map((bucket, i) => (i % 2 ? secondStore : store).withOwner(signal(), async (owner) => {
      const result = await (i % 2 ? secondStore : store).reserve(owner, intent(bucket));
      results[i] = result;
      if (results.filter(Boolean).length === buckets.length) ready.resolve();
      await gate.promise;
    }));
    try {
      await ready.promise;
      for (const [bucket, expected] of [['automatic', 1], ['interactive', 1], ['classifier', 2]] as const) {
        expect(results.filter((r, i) => buckets[i] === bucket && r.admitted)).toHaveLength(expected);
      }
      expect((await db.pool.query("select bucket, count(*)::int as count from usage_ledger where status='reserved' group by bucket order by bucket")).rows).toEqual([
        { bucket: 'automatic', count: 1 }, { bucket: 'classifier', count: 2 }, { bucket: 'interactive', count: 1 },
      ]);
      expect((await db.pool.query('select sum(requests)::int as total from request_counters')).rows[0].total).toBe(4);
    } finally { gate.resolve(); await Promise.all(tasks); }
  });

  it('preserves yesterday’s slot without consuming today’s credit', async () => {
    const gate = deferred(); const ready = deferred();
    now = new Date('2026-01-01T23:59:59Z');
    const first = store.withOwner(signal(), async (owner) => { expect((await store.reserve(owner, intent())).admitted).toBe(true); ready.resolve(); await gate.promise; });
    await ready.promise;
    try {
      now = new Date('2026-01-02T00:00:00Z');
      expect(await reserve()).toEqual({ admitted: false, reason: 'concurrency_limit' });
      expect((await db.pool.query('select day_utc::text as day, requests from request_counters')).rows).toEqual([{ day: '2026-01-01', requests: 1 }]);
      await db.pool.query("update budget_settings set concurrency=2 where bucket='automatic'");
      expect((await reserve()).admitted).toBe(true);
      expect((await db.pool.query('select day_utc::text as day, requests from request_counters order by day_utc')).rows).toEqual([{ day: '2026-01-01', requests: 1 }, { day: '2026-01-02', requests: 1 }]);
    } finally { gate.resolve(); await first; }
  });

  it('samples the clock only after waiting for the budget lock', async () => {
    const locker = await other.connect();
    let samples = 0;
    now = new Date('2026-01-01T23:59:59Z');
    store = new PostgresUsageAdmissionStore(db.pool, { now: () => { samples++; return now; } });
    await locker.query('begin');
    await locker.query("select 1 from budget_settings where bucket='automatic' for update");
    const pending = reserve();
    try {
      for (let i = 0; i < 100; i++) {
        const waiting = (await other.query("select count(*)::int as n from pg_stat_activity where application_name like 'feedrafter-usage:%' and wait_event_type='Lock'")).rows[0].n;
        if (waiting) break;
        if (i === 99) throw new Error('reservation did not wait for lock');
        await delay(20);
      }
      expect(samples).toBe(0);
      now = new Date('2026-01-01T19:30:00-05:00');
    } finally { await locker.query('commit'); locker.release(); }
    const result = await pending;
    expect(result.admitted && result.reservation.dayUtc).toBe('2026-01-02');
    expect(samples).toBe(1);
    expect((await db.pool.query('select day_utc::text as day from request_counters')).rows).toEqual([{ day: '2026-01-02' }]);
    expect((await db.pool.query('select occurred_at from usage_ledger')).rows[0].occurred_at.toISOString()).toBe('2026-01-02T00:30:00.000Z');
  });

  it('handles zero, unlimited and precedence without denial side effects', async () => {
    await db.pool.query("update budget_settings set daily_requests=0, concurrency=0 where bucket='automatic'");
    expect(await reserve()).toEqual({ admitted: false, reason: 'daily_limit' });
    await db.pool.query("update budget_settings set daily_requests=null where bucket='automatic'");
    expect(await reserve()).toEqual({ admitted: false, reason: 'concurrency_limit' });
    expect((await db.pool.query('select * from request_counters')).rows).toEqual([]);
    expect((await db.pool.query('select * from usage_ledger')).rows).toEqual([]);
    await db.pool.query("update budget_settings set concurrency=null where bucket='automatic'");
    expect((await reserve()).admitted).toBe(true);
    expect((await reserve()).admitted).toBe(true);
    await db.pool.query("update budget_settings set daily_requests=2, concurrency=1 where bucket='automatic'");
    expect(await reserve()).toEqual({ admitted: false, reason: 'daily_limit' });
    expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 2 }]);
  });

  it('rejects foreign, expired, denied and malformed owner attempts', async () => {
    let expired: Parameters<PostgresUsageAdmissionStore['reserve']>[0] | undefined;
    const another = new PostgresUsageAdmissionStore(other, { now: () => now });
    await db.pool.query("update budget_settings set daily_requests=0 where bucket='automatic'");
    await store.withOwner(signal(), async (owner) => {
      expired = owner;
      await expect(another.reserve(owner, intent())).rejects.toThrow('invalid or already used');
      expect(await store.reserve(owner, intent())).toEqual({ admitted: false, reason: 'daily_limit' });
      await expect(store.reserve(owner, intent())).rejects.toThrow('already used');
    });
    await expect(store.reserve(expired!, intent())).rejects.toThrow('invalid or already used');
    await store.withOwner(signal(), async (owner) => {
      await expect(store.reserve(owner, { ...intent(), provider: ' ' })).rejects.toThrow('Invalid reservation intent');
      await expect(store.reserve(owner, intent())).rejects.toThrow('already used');
    });
    expect((await db.pool.query('select * from request_counters')).rows).toEqual([]);
  });

  it('fails closed for missing budgets and disallows a second owner attempt', async () => {
    await db.pool.query("delete from budget_settings where bucket='automatic'");
    await store.withOwner(signal(), async (owner) => {
      await expect(store.reserve(owner, intent())).rejects.toThrow('budget missing');
      await expect(store.reserve(owner, intent())).rejects.toThrow('already used');
    });
    expect((await db.pool.query('select * from request_counters')).rows).toEqual([]);
    expect((await db.pool.query('select * from usage_ledger')).rows).toEqual([]);
    await db.pool.query("insert into budget_settings(bucket,daily_requests,concurrency) values ('automatic',50,1)");
  });

  it('persists the exact owner identity and metadata and rejects owner reuse', async () => {
    let pid = 0;
    await store.withOwner(signal(), async (owner) => {
      const result = await store.reserve(owner, intent('classifier'));
      expect(result.admitted).toBe(true);
      await expect(store.reserve(owner, intent('interactive'))).rejects.toThrow('already used');
      const row = (await other.query(`select l.owner_pid, l.owner_backend_start::text as start, a.backend_start::text as actual,
        l.owner_token, l.task_id, l.turn_id, l.role, l.provider, l.model, l.tokens_source, l.cost_source,
        l.input_tokens, l.output_tokens, l.cost_usd from usage_ledger l join pg_stat_activity a on a.pid=l.owner_pid`)).rows[0];
      pid = row.owner_pid;
      expect(row).toMatchObject({ owner_token: owner.token, task_id: 'task', turn_id: 'turn', role: 'summary', provider: 'p', model: 'm', tokens_source: 'unknown', cost_source: 'unknown', input_tokens: null, output_tokens: null, cost_usd: null });
      expect(row.start).toBe(row.actual);
    });
    for (let i = 0; i < 100; i++) {
      if (!(await other.query('select 1 from pg_stat_activity where pid=$1', [pid])).rowCount) return;
      await delay(20);
    }
    throw new Error('unresolved owner backend was not destroyed');
  });

  it('does not return an admission on lost commit acknowledgement', async () => {
    for (const after of [true, false]) {
      await db.pool.query('delete from usage_ledger; delete from request_counters');
      const wrapped = wrapQueries(other, async (sql, run) => {
        if (sql.toLowerCase() !== 'commit') return run();
        if (after) await run();
        throw new Error('lost acknowledgement');
      });
      const faulty = new PostgresUsageAdmissionStore(wrapped, { now: () => now });
      let returned = false;
      await expect(faulty.withOwner(signal(), async (owner) => {
        await faulty.reserve(owner, intent());
        returned = true;
      })).rejects.toThrow('commit outcome unknown');
      expect(returned).toBe(false);
      // The destroyed session rolls back a COMMIT that was never sent.
      for (let i = 0; i < 100; i++) {
        if (!(await db.pool.query("select 1 from pg_stat_activity where application_name like 'feedrafter-usage:%'")).rowCount) break;
        await delay(20);
      }
      expect((await db.pool.query("select 1 from pg_stat_activity where application_name like 'feedrafter-usage:%'")).rowCount).toBe(0);
      expect((await db.pool.query('select count(*)::int as n from usage_ledger')).rows[0].n).toBe(after ? 1 : 0);
      expect((await db.pool.query('select coalesce(sum(requests),0)::int as n from request_counters')).rows[0].n).toBe(after ? 1 : 0);
      if (after) expect(await reserve()).toEqual({ admitted: false, reason: 'concurrency_limit' });
    }
  });

  it('serializes budget edits and does not cancel active reservations when caps decrease', async () => {
    const locked = deferred(); const proceed = deferred();
    const wrapped = wrapQueries(other, async (sql, run) => {
      const result = await run();
      if (sql.includes('for update')) { locked.resolve(); await proceed.promise; }
      return result;
    });
    const held = new PostgresUsageAdmissionStore(wrapped, { now: () => now });
    const pending = held.withOwner(signal(), (owner) => held.reserve(owner, intent()));
    await locked.promise;
    let edited = false;
    const edit = db.pool.query("update budget_settings set concurrency=0 where bucket='automatic'").then(() => { edited = true; });
    try {
      for (let i = 0; i < 100; i++) {
        if ((await other.query("select 1 from pg_stat_activity where query like 'update budget_settings set concurrency=0%' and wait_event_type='Lock'")).rowCount) break;
        if (i === 99) throw new Error('budget edit did not wait');
        await delay(20);
      }
      expect(edited).toBe(false);
    } finally { proceed.resolve(); }
    expect((await pending).admitted).toBe(true);
    await edit;
    expect(await reserve()).toEqual({ admitted: false, reason: 'concurrency_limit' });
    expect((await db.pool.query("select status from usage_ledger")).rows).toEqual([{ status: 'reserved' }]);
    expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 1 }]);
    await db.pool.query("update budget_settings set concurrency=2 where bucket='automatic'");
    expect((await reserve()).admitted).toBe(true);
  });

  it('returns denied and rolled-back sessions cleanly to their pool', async () => {
    const pool = new pg.Pool({ ...db.pool.options, max: 1 });
    const local = new PostgresUsageAdmissionStore(pool, { now: () => now });
    try {
      await db.pool.query("update budget_settings set daily_requests=0 where bucket='automatic'");
      let pid = 0;
      await local.withOwner(signal(), async (owner) => {
        pid = (await other.query('select pid from pg_stat_activity where application_name=$1', [`feedrafter-usage:${owner.token}`])).rows[0].pid;
        expect(await local.reserve(owner, intent())).toEqual({ admitted: false, reason: 'daily_limit' });
      });
      expect((await pool.query("select pg_backend_pid() as pid, current_setting('application_name') as name")).rows[0]).toEqual({ pid, name: '' });
      await db.pool.query("update budget_settings set daily_requests=null where bucket='automatic'");
      now = new Date(Number.NaN);
      await local.withOwner(signal(), async (owner) => {
        pid = (await other.query('select pid from pg_stat_activity where application_name=$1', [`feedrafter-usage:${owner.token}`])).rows[0].pid;
        await expect(local.reserve(owner, intent())).rejects.toThrow('Invalid time value');
      });
      expect((await pool.query("select pg_backend_pid() as pid, current_setting('application_name') as name")).rows[0]).toEqual({ pid, name: '' });
    } finally { await pool.end(); }
  });

  it('rolls back cancellation while waiting and leaves a clean client', async () => {
    const locker = await other.connect();
    await locker.query('begin');
    await locker.query("select 1 from budget_settings where bucket='automatic' for update");
    const abort = new AbortController();
    const pending = store.withOwner(abort.signal, (owner) => store.reserve(owner, intent()));
    try {
      for (let i = 0; i < 100; i++) {
        if ((await other.query("select 1 from pg_stat_activity where application_name like 'feedrafter-usage:%' and wait_event_type='Lock'")).rowCount) break;
        if (i === 99) throw new Error('reservation did not wait');
        await delay(20);
      }
      abort.abort(new Error('cancelled'));
    } finally { await locker.query('commit'); locker.release(); }
    await expect(pending).rejects.toThrow('cancelled');
    expect((await db.pool.query('select * from request_counters')).rows).toEqual([]);
    expect((await db.pool.query('select * from usage_ledger')).rows).toEqual([]);
    expect((await reserve()).admitted).toBe(true);
  });

  it('rolls back counter mutation when the ledger insert fails', async () => {
    await db.pool.query("create function fail_reservation() returns trigger language plpgsql as $$ begin raise exception 'injected insert failure'; end $$; create trigger fail_reservation before insert on usage_ledger for each row execute function fail_reservation()");
    try {
      await expect(reserve()).rejects.toThrow('injected insert failure');
      expect((await db.pool.query('select * from request_counters')).rows).toEqual([]);
      await db.pool.query("insert into request_counters(day_utc,bucket,requests) values ('2026-01-02','automatic',3)");
      await expect(reserve()).rejects.toThrow('injected insert failure');
      expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 3 }]);
    } finally { await db.pool.query('drop trigger fail_reservation on usage_ledger; drop function fail_reservation()'); }
    expect((await db.pool.query('select * from usage_ledger')).rows).toEqual([]);
  });
});
