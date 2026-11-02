import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { PostgresUsageAdmissionStore } from '../../src/server/adapters/postgres/usage-admission-store.js';
import { UsageService } from '../../src/server/application/usage.js';
import type { ReservationIntent, TerminalUsage } from '../../src/server/domain/usage.js';
import { createUsageDatabase } from '../helpers/usage-database.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let service: UsageService;
const intent: ReservationIntent = { bucket: 'automatic', role: 'summary', provider: 'pg-gate', model: 'model' };
const scope = () => ({ bucket: 'automatic' as const, signal: new AbortController().signal });
const terminal = <S extends TerminalUsage['status']>(status: S): TerminalUsage & { status: S } => ({ status, inputTokens: null, outputTokens: null, costUsd: null, tokensSource: 'unknown', costSource: 'unknown', outcomeCode: null });
beforeAll(async () => { db = await createUsageDatabase(); await migrateDatabase(db.pool); }, 30000);
afterAll(async () => { await db?.dispose(); }, 30000);
beforeEach(async () => {
  await db.pool.query("delete from usage_ledger; delete from request_counters; update budget_settings set daily_requests=50, concurrency=1 where bucket='automatic'");
  service = new UsageService(new PostgresUsageAdmissionStore(db.pool, { now: () => new Date('2026-01-02T00:00:00Z') }));
});
describe('usage gate with PostgreSQL', () => {
  it('commits the reservation before callback and retains counter after success', async () => {
    const result = await service.executeAttempt(intent, scope(), async () => {
      expect((await db.pool.query('select status from usage_ledger')).rows).toEqual([{ status: 'reserved' }]);
      expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 1 }]);
      return { kind: 'success', value: 'ok', terminal: terminal('succeeded') };
    });
    expect(result).toMatchObject({ kind: 'completed', value: 'ok' });
    expect((await db.pool.query('select status from usage_ledger')).rows).toEqual([{ status: 'succeeded' }]);
    expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 1 }]);
  });
  it('denies exhausted budget without callback or row', async () => {
    await db.pool.query("update budget_settings set daily_requests=0 where bucket='automatic'");
    const invoke = vi.fn();
    expect(await service.executeAttempt(intent, scope(), invoke)).toEqual({ kind: 'paused_budget', reason: 'daily_limit' });
    expect(invoke).not.toHaveBeenCalled();
    expect((await db.pool.query('select * from usage_ledger')).rowCount).toBe(0);
    expect((await db.pool.query('select * from request_counters')).rowCount).toBe(0);
  });
  it('counts and settles a post-commit cancellation before callback', async () => {
    const controller = new AbortController();
    const store = new PostgresUsageAdmissionStore(db.pool, { now: () => new Date('2026-01-02T00:00:00Z') });
    const reserve = store.reserve.bind(store);
    store.reserve = async (...args) => { const result = await reserve(...args); controller.abort(); return result; };
    const invoke = vi.fn();
    await expect(new UsageService(store).executeAttempt(intent, { ...scope(), signal: controller.signal }, invoke)).rejects.toMatchObject({ kind: 'aborted' });
    expect(invoke).not.toHaveBeenCalled();
    expect((await db.pool.query('select status, outcome_code from usage_ledger')).rows).toEqual([{ status: 'failed', outcome_code: 'cancelled_before_dispatch' }]);
    expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 1 }]);
  });
  it('persists uncertain usage for explicit auth with invalid metadata and pauses the pair', async () => {
    const pair = { ...intent, provider: 'pg-gate-invalid-auth' };
    await expect(service.executeAttempt(pair, scope(), async () => ({
      kind: 'failure', failureKind: 'auth', terminal: { ...terminal('failed'), inputTokens: -1 },
    }))).rejects.toMatchObject({ kind: 'uncertain' });
    expect((await db.pool.query('select status, outcome_code, input_tokens, tokens_source from usage_ledger')).rows)
      .toEqual([{ status: 'uncertain', outcome_code: 'outcome_unknown', input_tokens: null, tokens_source: 'unknown' }]);
    const invoke = vi.fn();
    expect(await service.executeAttempt({ ...pair, role: 'chat' }, scope(), invoke)).toEqual({ kind: 'paused_auth' });
    expect(invoke).not.toHaveBeenCalled();
    expect((await db.pool.query('select count(*)::int as count from usage_ledger')).rows).toEqual([{ count: 1 }]);
    expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 1 }]);
  });
  it('preserves uncertain accounting and pauses the pair after late auth', async () => {
    const pair = { ...intent, provider: 'pg-gate-late-auth' }; const controller = new AbortController();
    let ready!: () => void; let observed!: () => void;
    let finish!: (value: { kind: 'failure'; failureKind: 'auth'; terminal: ReturnType<typeof terminal<'failed'>> }) => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const observation = new Promise<void>((resolve) => { observed = resolve; });
    const callback = new Promise<{ kind: 'failure'; failureKind: 'auth'; terminal: ReturnType<typeof terminal<'failed'>> }>((resolve) => { finish = resolve; });
    const invoke = vi.fn(() => { ready(); return callback; });
    const pending = service.executeAttempt(pair, { ...scope(), signal: controller.signal }, invoke);
    await started; controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'uncertain' });
    const queryLedger = () => db.pool.query('select status, outcome_code, input_tokens, tokens_source from usage_ledger');
    const expected = [{ status: 'uncertain', outcome_code: 'outcome_unknown', input_tokens: null, tokens_source: 'unknown' }];
    expect((await queryLedger()).rows).toEqual(expected);
    expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 1 }]);
    finish({ kind: 'failure', get failureKind(): 'auth' { observed(); return 'auth'; }, terminal: { ...terminal('failed'), inputTokens: -1 } });
    await observation;
    const nextInvoke = vi.fn();
    expect(await service.executeAttempt({ ...pair, role: 'chat' }, scope(), nextInvoke)).toEqual({ kind: 'paused_auth' });
    expect(invoke).toHaveBeenCalledTimes(1); expect(nextInvoke).not.toHaveBeenCalled();
    expect((await queryLedger()).rows).toEqual(expected);
    expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 1 }]);
  });
  it('keeps an in-flight slot occupied and denies another callback without spending credit', async () => {
    let release!: () => void; let ready!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const first = service.executeAttempt(intent, scope(), async () => { ready(); await barrier; return { kind: 'success', value: 1, terminal: terminal('succeeded') }; });
    await started;
    try {
      const invoke = vi.fn();
      expect(await service.executeAttempt(intent, scope(), invoke)).toEqual({ kind: 'paused_budget', reason: 'concurrency_limit' });
      expect(invoke).not.toHaveBeenCalled();
      expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 1 }]);
    } finally { release(); await first; }
  });
  it('settles known failure and thrown failure, preserving credits and freeing slots', async () => {
    await expect(service.executeAttempt(intent, scope(), async () => ({ kind: 'failure', failureKind: 'provider', terminal: terminal('failed') }))).rejects.toMatchObject({ kind: 'provider' });
    await expect(service.executeAttempt(intent, scope(), async () => { throw new Error('secret'); })).rejects.toMatchObject({ kind: 'uncertain' });
    expect((await db.pool.query('select status from usage_ledger order by status')).rows).toEqual([{ status: 'failed' }, { status: 'uncertain' }]);
    expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 2 }]);
  });
});
