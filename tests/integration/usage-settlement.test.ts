import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { PostgresUsageAdmissionStore } from '../../src/server/adapters/postgres/usage-admission-store.js';
import { UsageService } from '../../src/server/application/usage.js';
import type { ReservationIntent, TerminalUsage } from '../../src/server/domain/usage.js';
import { createUsageDatabase } from '../helpers/usage-database.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let other: pg.Pool;
let store: PostgresUsageAdmissionStore;
let now: Date;
const signal = () => new AbortController().signal;
const intent: ReservationIntent = { bucket: 'automatic', role: 'summary', provider: 'p', model: 'm', taskId: 'task', turnId: 'turn' };
const usage: TerminalUsage = { status: 'succeeded', inputTokens: null, outputTokens: null, costUsd: null, tokensSource: 'unknown', costSource: 'unknown', outcomeCode: null };
const admitted = async (current: PostgresUsageAdmissionStore, owner: Parameters<PostgresUsageAdmissionStore['reserve']>[0]) => {
  const result = await current.reserve(owner, intent);
  if (!result.admitted) throw new Error('expected reservation');
  return result.reservation;
};
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
  now = new Date('2026-01-01T23:59:59Z');
  store = new PostgresUsageAdmissionStore(db.pool, { now: () => now });
});

describe('owner-fenced usage settlement', () => {
  it.each(['succeeded', 'failed', 'uncertain'] as const)('settles %s once, retaining metadata and credit across midnight', async (status) => {
    await store.withOwner(signal(), async (owner) => {
      const reservation = await admitted(store, owner);
      const before = (await other.query('select * from usage_ledger')).rows[0];
      now = new Date('2026-01-02T00:00:01Z');
      const terminal: TerminalUsage = { ...usage, status, inputTokens: 0, outputTokens: 3, costUsd: 0, tokensSource: 'provider', costSource: 'provider', outcomeCode: 'cancelled_before_dispatch' };
      expect(await store.settle(owner, reservation, terminal)).toBe('settled');
      const after = (await other.query('select * from usage_ledger')).rows[0];
      expect(after).toMatchObject({ id: before.id, bucket: before.bucket, role: before.role, provider: before.provider, model: before.model, owner_token: before.owner_token, owner_pid: before.owner_pid, owner_backend_start: before.owner_backend_start, occurred_at: before.occurred_at, task_id: 'task', turn_id: 'turn', status, input_tokens: 0, output_tokens: 3, cost_usd: 0, tokens_source: 'provider', cost_source: 'provider', outcome_code: 'cancelled_before_dispatch' });
      expect(after.settled_at).not.toBeNull();
      expect(await store.settle(owner, reservation, terminal)).toBe('already_terminal');
      expect(await store.settle(owner, reservation, { ...usage, status: 'failed' })).toBe('already_terminal');
      expect((await other.query('select * from usage_ledger')).rows[0]).toEqual(after);
      expect((await other.query('select day_utc::text as day, requests from request_counters')).rows).toEqual([{ day: '2026-01-01', requests: 1 }]);
      await store.withOwner(signal(), async (next) => { expect((await store.reserve(next, intent)).admitted).toBe(true); });
    });
  });

  it('preserves unavailable usage as null', async () => {
    await store.withOwner(signal(), async (owner) => {
      expect(await store.settle(owner, await admitted(store, owner), usage)).toBe('settled');
      expect((await other.query('select input_tokens, output_tokens, cost_usd, tokens_source, cost_source, outcome_code from usage_ledger')).rows[0]).toEqual({ input_tokens: null, output_tokens: null, cost_usd: null, tokens_source: 'unknown', cost_source: 'unknown', outcome_code: null });
    });
  });

  it.each([[5, null], [null, 0]] as const)('persists independently observed provider counts: %s, %s', async (inputTokens, outputTokens) => {
    const terminal = { ...usage, status: 'succeeded' as const, inputTokens, outputTokens, tokensSource: 'provider' as const };
    const result = await new UsageService(store).executeAttempt(intent, { ...intent, signal: signal() }, async () => ({ kind: 'success', value: 'ok', terminal }));
    expect(result.kind).toBe('completed');
    expect((await other.query('select input_tokens, output_tokens, tokens_source, cost_usd, cost_source from usage_ledger')).rows).toEqual([
      { input_tokens: inputTokens, output_tokens: outputTokens, tokens_source: 'provider', cost_usd: null, cost_source: 'unknown' },
    ]);
  });

  it('rejects foreign token, bucket, session, and mismatched persisted identity', async () => {
    await store.withOwner(signal(), async (owner) => {
      const reservation = await admitted(store, owner);
      const another = new PostgresUsageAdmissionStore(other, { now: () => now });
      await another.withOwner(signal(), async (foreign) => {
        expect((await another.reserve(foreign, { ...intent, bucket: 'classifier' })).admitted).toBe(true);
        expect(await another.settle(foreign, reservation, usage)).toBe('ownership_lost');
        expect(await store.settle(foreign, reservation, usage)).toBe('ownership_lost');
      });
      expect(await store.settle(owner, { ...reservation, ownerToken: crypto.randomUUID() }, usage)).toBe('ownership_lost');
      expect(await store.settle(owner, { ...reservation, bucket: 'interactive' }, usage)).toBe('ownership_lost');
      await other.query('update usage_ledger set owner_token=$1 where id=$2', [crypto.randomUUID(), reservation.id]);
      expect(await store.settle(owner, reservation, usage)).toBe('ownership_lost');
      await other.query("update usage_ledger set owner_token=$1, owner_backend_start=owner_backend_start + interval '1 microsecond' where id=$2", [owner.token, reservation.id]);
      expect(await store.settle(owner, reservation, usage)).toBe('ownership_lost');
      expect((await other.query('select status from usage_ledger where id=$1', [reservation.id])).rows[0].status).toBe('reserved');
    });
  });

  it('frees exactly one slot in its bucket without changing other buckets', async () => {
    await other.query("update budget_settings set concurrency=2 where bucket='automatic'; update budget_settings set concurrency=1 where bucket='classifier'");
    await store.withOwner(signal(), async (first) => {
      const firstReservation = await admitted(store, first);
      await store.withOwner(signal(), async (second) => {
        await admitted(store, second);
        await store.withOwner(signal(), async (classifier) => {
          expect((await store.reserve(classifier, { ...intent, bucket: 'classifier' })).admitted).toBe(true);
          expect(await store.settle(first, firstReservation, usage)).toBe('settled');
          await store.withOwner(signal(), async (third) => {
            expect((await store.reserve(third, intent)).admitted).toBe(true);
            await store.withOwner(signal(), async (denied) => {
              expect(await store.reserve(denied, intent)).toEqual({ admitted: false, reason: 'concurrency_limit' });
            });
            await store.withOwner(signal(), async (denied) => {
              expect(await store.reserve(denied, { ...intent, bucket: 'classifier' })).toEqual({ admitted: false, reason: 'concurrency_limit' });
            });
          });
        });
      });
    });
    expect((await other.query('select bucket, requests from request_counters order by bucket')).rows).toEqual([{ bucket: 'automatic', requests: 3 }, { bucket: 'classifier', requests: 1 }]);
  });

  it('serializes simultaneous settlements and fences expired handles', async () => {
    let expired: Parameters<PostgresUsageAdmissionStore['reserve']>[0] | undefined;
    let handle: Awaited<ReturnType<typeof admitted>> | undefined;
    await store.withOwner(signal(), async (owner) => {
      expired = owner;
      handle = await admitted(store, owner);
      expect(await Promise.all([
        store.settle(owner, handle, usage),
        store.settle(owner, handle, { ...usage, status: 'failed' }),
      ])).toEqual(['settled', 'already_terminal']);
    });
    expect(await store.settle(expired!, handle!, usage)).toBe('ownership_lost');
    expect((await other.query('select status from usage_ledger')).rows[0].status).toBe('succeeded');
  });

  it('takes the budget lock before the ledger lock', async () => {
    await store.withOwner(signal(), async (owner) => {
      const reservation = await admitted(store, owner);
      const locker = await other.connect();
      await locker.query('begin');
      await locker.query("select 1 from budget_settings where bucket='automatic' for update");
      const pending = store.settle(owner, reservation, usage);
      try {
        for (let i = 0; i < 100; i++) {
          if ((await db.pool.query("select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock'", [`feedrafter-usage:${owner.token}`])).rowCount) break;
          if (i === 99) throw new Error('settlement did not wait on budget');
          await delay(20);
        }
        // A separate session can still take the row lock while settlement waits.
        const probe = await db.pool.connect();
        try {
          await probe.query('begin');
          await probe.query('select 1 from usage_ledger where id=$1 for update nowait', [reservation.id]);
          await probe.query('rollback');
        } finally { probe.release(); }
      } finally { await locker.query('commit'); locker.release(); }
      expect(await pending).toBe('settled');
    });
  });

  it('validates terminal usage without a partial write', async () => {
    await store.withOwner(signal(), async (owner) => {
      const reservation = await admitted(store, owner);
      const invalid: unknown[] = [
        { ...usage, status: 'reserved' }, { ...usage, inputTokens: -1 }, { ...usage, inputTokens: 1.5 },
        { ...usage, inputTokens: 2147483648 }, { ...usage, outputTokens: NaN }, { ...usage, costUsd: Infinity },
        { ...usage, costUsd: -1 }, { ...usage, costUsd: 0 }, { ...usage, tokensSource: 'provider' }, { ...usage, costSource: 'provider' },
        { ...usage, tokensSource: 'catalog' }, { ...usage, outcomeCode: 'secret value\n' }, { ...usage, outcomeCode: 'x'.repeat(129) },
      ];
      for (const terminal of invalid) await expect(store.settle(owner, reservation, terminal as TerminalUsage)).rejects.toThrow();
      expect((await other.query('select status, input_tokens, cost_usd from usage_ledger')).rows[0]).toEqual({ status: 'reserved', input_tokens: null, cost_usd: null });
      expect(await store.settle(owner, reservation, usage)).toBe('settled');
    });
  });

  it('rolls back an SQL failure and permits a later healthy settlement', async () => {
    await store.withOwner(signal(), async (owner) => {
      const reservation = await admitted(store, owner);
      await other.query("create function fail_settlement() returns trigger language plpgsql as $$ begin raise exception 'injected settlement failure'; end $$; create trigger fail_settlement before update on usage_ledger for each row execute function fail_settlement()");
      try { await expect(store.settle(owner, reservation, { ...usage, inputTokens: 4 })).rejects.toThrow('injected settlement failure'); }
      finally { await other.query('drop trigger fail_settlement on usage_ledger; drop function fail_settlement()'); }
      expect((await other.query('select status, input_tokens from usage_ledger')).rows[0]).toEqual({ status: 'reserved', input_tokens: null });
      expect(await store.settle(owner, reservation, usage)).toBe('settled');
    });
  });

  it('allows caller-abort cleanup but not a dead owner', async () => {
    const abort = new AbortController();
    await store.withOwner(abort.signal, async (owner) => {
      const reservation = await admitted(store, owner);
      abort.abort();
      expect(await store.settle(owner, reservation, usage)).toBe('settled');
    });
    await db.pool.query('delete from usage_ledger; delete from request_counters');
    await expect(store.withOwner(signal(), async (owner) => {
      const reservation = await admitted(store, owner);
      const pid = (await other.query('select owner_pid from usage_ledger')).rows[0].owner_pid;
      await other.query('select pg_terminate_backend($1)', [pid]);
      for (let i = 0; i < 100 && !owner.signal.aborted; i++) await delay(20);
      expect(owner.signal.aborted).toBe(true);
      expect(await store.settle(owner, reservation, usage)).toBe('ownership_lost');
    })).rejects.toThrow();
    expect((await other.query('select status from usage_ledger')).rows[0].status).toBe('reserved');
  });

  it('prevents writes when the owner dies while waiting on the budget lock', async () => {
    await expect(store.withOwner(signal(), async (owner) => {
      const reservation = await admitted(store, owner);
      const pid = (await other.query('select owner_pid from usage_ledger where id=$1', [reservation.id])).rows[0].owner_pid;
      const locker = await other.connect();
      await locker.query('begin');
      await locker.query("select 1 from budget_settings where bucket='automatic' for update");
      const pending = store.settle(owner, reservation, usage);
      try {
        for (let i = 0; i < 100; i++) {
          if ((await db.pool.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'", [pid])).rowCount) break;
          if (i === 99) throw new Error('settlement did not wait');
          await delay(20);
        }
        await db.pool.query('select pg_terminate_backend($1)', [pid]);
        expect(await pending).toBe('ownership_lost');
      } finally { await locker.query('rollback'); locker.release(); }
    })).rejects.toThrow();
    expect((await other.query('select status from usage_ledger')).rows[0].status).toBe('reserved');
  });

  it.each([false, true])('destroys the owner when settlement commit acknowledgement is lost (after=%s)', async (after) => {
    let commits = 0;
    const wrapped = wrapQueries(other, async (sql, run) => {
      if (sql.toLowerCase() !== 'commit' || ++commits !== 2) return run();
      if (after) await run();
      throw new Error('lost acknowledgement');
    });
    const faulty = new PostgresUsageAdmissionStore(wrapped, { now: () => now });
    await expect(faulty.withOwner(signal(), async (owner) => {
      const reservation = await admitted(faulty, owner);
      await expect(faulty.settle(owner, reservation, usage)).rejects.toThrow('commit outcome unknown');
      expect(owner.signal.aborted).toBe(true);
      expect(await faulty.settle(owner, reservation, usage)).toBe('ownership_lost');
      for (let i = 0; i < 100; i++) {
        if (!(await db.pool.query('select 1 from pg_stat_activity where application_name=$1', [`feedrafter-usage:${owner.token}`])).rowCount) break;
        if (i === 99) throw new Error('uncertain owner survived within its scope');
        await delay(20);
      }
    })).rejects.toThrow('Usage owner connection lost');
    for (let i = 0; i < 100; i++) {
      if (!(await db.pool.query("select 1 from pg_stat_activity where application_name like 'feedrafter-usage:%'")).rowCount) break;
      await delay(20);
    }
    expect((await db.pool.query("select 1 from pg_stat_activity where application_name like 'feedrafter-usage:%'")).rowCount).toBe(0);
    expect((await db.pool.query('select status from usage_ledger')).rows[0].status).toBe(after ? 'succeeded' : 'reserved');
    expect((await db.pool.query('select requests from request_counters')).rows[0].requests).toBe(1);
  });
});
