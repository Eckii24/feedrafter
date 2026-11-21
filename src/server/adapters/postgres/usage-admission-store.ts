import type pg from 'pg';
import { modelRoleNames } from '../../../shared/settings.js';
import type { Clock } from '../../domain/clock.js';
import type { AdmissionResult, ReservationIntent, TerminalUsage, UsageReservation } from '../../domain/usage.js';
import type { UsageAdmissionPort, UsageOwner } from '../../ports/usage.js';
import { withUsageOwner, type UsageOwnerSession } from './usage-owner.js';

type OwnerState = { session: UsageOwnerSession; signal: AbortSignal; used: boolean; pending?: Promise<unknown>; reservation?: UsageReservation; invalid?: boolean };
type SettlementResult = 'settled' | 'already_terminal' | 'ownership_lost';

function validateTerminal(value: TerminalUsage): void {
  const tokens = (n: number | null) => n === null || (Number.isInteger(n) && n >= 0 && n <= 2147483647);
  if (!value || !['succeeded', 'failed', 'uncertain'].includes(value.status)
    || !tokens(value.inputTokens) || !tokens(value.outputTokens)
    || !(value.costUsd === null || (typeof value.costUsd === 'number' && Number.isFinite(value.costUsd) && value.costUsd >= 0))
    || !['provider', 'unknown'].includes(value.tokensSource) || !['provider', 'unknown'].includes(value.costSource)
    || (value.tokensSource === 'provider' && value.inputTokens === null && value.outputTokens === null)
    || (value.costSource === 'provider' && value.costUsd === null)
    || (value.costSource === 'unknown' && value.costUsd !== null)
    || !(value.outcomeCode === null || (typeof value.outcomeCode === 'string' && /^[a-z0-9_]{1,128}$/.test(value.outcomeCode)))) {
    throw new RangeError('Invalid terminal usage');
  }
}

/** Storage-only admission and recovery; no provider dispatch. */
export class PostgresUsageAdmissionStore implements UsageAdmissionPort {
  private readonly owners = new WeakMap<UsageOwner, OwnerState>();

  constructor(private readonly pool: pg.Pool, private readonly clock: Clock, private readonly recoveryPool: pg.Pool = pool, private readonly caps?: Partial<Record<'automatic' | 'interactive' | 'classifier', { daily: number; concurrency: number }>>) {
    for (const cap of Object.values(caps ?? {})) if (!Number.isSafeInteger(cap.daily) || cap.daily < 0 || !Number.isSafeInteger(cap.concurrency) || cap.concurrency < 0) throw new RangeError('Invalid usage caps');
  }

  async recover(): Promise<number> {
    let transitioned = 0;
    for (const bucket of ['automatic', 'interactive', 'classifier', 'transcription']) {
      let cursor: string | null = null;
      for (;;) {
        const client = await this.recoveryPool.connect();
        let transportError: Error | undefined;
        const onError = (error: Error) => { transportError ??= error; };
        client.on('error', onError);
        const check = () => { if (transportError) throw transportError; };
        let transaction = false;
        let committing = false;
        let destroy = false;
        try {
          check();
          await client.query('begin isolation level read committed');
          transaction = true;
          check();
          const budget = await client.query('select 1 from budget_settings where bucket=$1 for update', [bucket]);
          check();
          if (!budget.rowCount) throw new Error('Usage budget missing');
          const page: pg.QueryResult<{ id: string }> = await client.query<{ id: string }>(
            `select id from usage_ledger where bucket=$1 and status='reserved' and ($2::uuid is null or id > $2::uuid)
             order by id limit 100 for update`, [bucket, cursor],
          );
          check();
          if (page.rows.length) {
            await client.query('select pg_stat_clear_snapshot()');
            check();
            const probe = await client.query<{ id: string; accessible: boolean; in_scope: boolean; live: boolean; probe_ready: boolean }>(
              `select l.id,
                (a.pid is null or (a.datname is not null and a.usename is not null and a.backend_start is not null)) as accessible,
                (a.pid is null or coalesce(a.datname=current_database() and a.usename=current_user, false)) as in_scope,
                coalesce(a.backend_start=l.owner_backend_start, false) as live,
                exists(select 1 from pg_stat_activity self where self.pid=pg_backend_pid()
                  and self.datname=current_database() and self.usename=current_user and self.backend_start is not null) as probe_ready
               from usage_ledger l left join pg_stat_activity a on a.pid=l.owner_pid
               where l.id=any($1::uuid[]) order by l.id`, [page.rows.map((row) => row.id)],
            );
            check();
            if (probe.rows.length !== page.rows.length || probe.rows.some((row) => row.probe_ready !== true || row.accessible !== true || row.in_scope !== true || typeof row.live !== 'boolean')) {
              throw new Error('Usage owner liveness unavailable');
            }
            const dead = probe.rows.filter((row) => !row.live).map((row) => row.id);
            if (dead.length) {
              const updated = await client.query(
                `update usage_ledger set status='uncertain', outcome_code='owner_lost', settled_at=now()
                 where bucket=$1 and status='reserved' and id=any($2::uuid[])`, [bucket, dead],
              );
              check();
              transitioned += updated.rowCount ?? 0;
            }
          }
          check();
          committing = true;
          await client.query('commit');
          transaction = false;
          check();
          if (page.rows.length < 100) break;
          cursor = page.rows[page.rows.length - 1]!.id;
        } catch (error) {
          if (committing || transportError) destroy = true;
          else if (transaction) {
            try { await client.query('rollback'); } catch { destroy = true; }
          } else destroy = true;
          if (transportError) destroy = true;
          throw transportError ?? error;
        } finally {
          try { client.release(destroy || Boolean(transportError)); }
          finally { client.removeListener('error', onError); }
        }
      }
    }
    return transitioned;
  }

  withOwner<T>(signal: AbortSignal, action: (owner: UsageOwner) => Promise<T>): Promise<T> {
    return withUsageOwner(this.pool, signal, async (session) => {
      const state: OwnerState = { session, signal, used: false };
      this.owners.set(session.owner, state);
      try { return await action(session.owner); }
      finally {
        this.owners.delete(session.owner);
        if (state.pending) await state.pending.catch(() => {});
      }
    });
  }

  reserve(owner: UsageOwner, intent: ReservationIntent): Promise<AdmissionResult> {
    const state = this.owners.get(owner);
    if (!state || state.used) return Promise.reject(new Error('Usage owner invalid or already used'));
    state.used = true;
    const pending = this.reserveOnce(state, intent);
    state.pending = pending;
    return pending;
  }

  settle(owner: UsageOwner, reservation: UsageReservation, terminal: TerminalUsage): Promise<SettlementResult> {
    const state = this.owners.get(owner);
    if (!state || state.invalid || owner.signal.aborted) return Promise.resolve('ownership_lost');
    // Snapshot caller data before awaiting any other operation on the dedicated client.
    const handle = reservation && { ...reservation };
    const payload = terminal && { ...terminal };
    const previous = state.pending;
    const pending = (async () => {
      if (previous) await previous.catch(() => {});
      return this.settleOnce(state, handle, payload);
    })();
    state.pending = pending;
    return pending;
  }

  private async settleOnce(state: OwnerState, reservation: UsageReservation, terminal: TerminalUsage): Promise<SettlementResult> {
    const { session } = state;
    const expected = state.reservation;
    if (state.invalid || session.owner.signal.aborted || !expected || !reservation
      || reservation.id !== expected.id || reservation.bucket !== expected.bucket
      || reservation.ownerToken !== expected.ownerToken || reservation.dayUtc !== expected.dayUtc) return 'ownership_lost';
    let transaction = false;
    let committing = false;
    try {
      transaction = true;
      await session.client.query('begin isolation level read committed');
      const budget = await session.client.query('select 1 from budget_settings where bucket=$1 for update', [expected.bucket]);
      if (!budget.rowCount) throw new Error('Usage budget missing');
      session.owner.signal.throwIfAborted();
      const row = (await session.client.query<{ status: string; owned: boolean }>(
        `select status, (owner_token=$3 and owner_pid=$4 and owner_backend_start=$5::timestamptz) as owned
         from usage_ledger where id=$1 and bucket=$2 for update`,
        [expected.id, expected.bucket, session.owner.token, session.identity.pid, session.identity.backendStart],
      )).rows[0];
      session.owner.signal.throwIfAborted();
      if (!row?.owned || row.status !== 'reserved') {
        await session.client.query('rollback');
        transaction = false;
        return !session.owner.signal.aborted && row?.owned ? 'already_terminal' : 'ownership_lost';
      }
      validateTerminal(terminal);
      await session.client.query(
        `update usage_ledger set status=$1, input_tokens=$2, output_tokens=$3, cost_usd=$4,
         tokens_source=$5, cost_source=$6, outcome_code=$7, settled_at=now() where id=$8 and bucket=$9`,
        [terminal.status, terminal.inputTokens, terminal.outputTokens, terminal.costUsd, terminal.tokensSource, terminal.costSource, terminal.outcomeCode, expected.id, expected.bucket],
      );
      session.owner.signal.throwIfAborted();
      committing = true;
      await session.client.query('commit');
      transaction = false;
      session.owner.signal.throwIfAborted();
      session.markSettled();
      return 'settled';
    } catch (error) {
      if (committing) {
        state.invalid = true;
        session.invalidate();
        throw new Error('Usage settlement commit outcome unknown', { cause: error });
      }
      if (transaction) {
        try { await session.client.query('rollback'); }
        catch { state.invalid = true; session.invalidate(); }
      }
      if (session.owner.signal.aborted) return 'ownership_lost';
      throw error;
    }
  }

  private async reserveOnce(state: OwnerState, intent: ReservationIntent): Promise<AdmissionResult> {
    if (!intent || !['automatic', 'interactive', 'classifier'].includes(intent.bucket)
      || !(modelRoleNames as readonly string[]).includes(intent.role)
      || typeof intent.provider !== 'string' || !intent.provider.trim()
      || typeof intent.model !== 'string' || !intent.model.trim()
      || (intent.taskId !== undefined && typeof intent.taskId !== 'string')
      || (intent.turnId !== undefined && typeof intent.turnId !== 'string')) throw new RangeError('Invalid reservation intent');
    // Never let caller mutation change the bucket after its lock has been chosen.
    intent = { ...intent };
    const { session, signal } = state;
    const check = () => { signal.throwIfAborted(); session.owner.signal.throwIfAborted(); };
    check();
    let transaction = false;
    let committing = false;
    try {
      transaction = true;
      await session.client.query('begin isolation level read committed');
      const budget = (await session.client.query<{ daily_requests: number | null; concurrency: number | null }>(
        'select daily_requests, concurrency from budget_settings where bucket=$1 for update', [intent.bucket],
      )).rows[0];
      if (!budget) throw new Error('Usage budget missing');
      check();
      const admittedAt = this.clock.now().toISOString();
      const dayUtc = admittedAt.slice(0, 10);
      const counter = (await session.client.query<{ requests: number }>(
        'select requests from request_counters where day_utc=$1 and bucket=$2', [dayUtc, intent.bucket],
      )).rows[0]?.requests ?? 0;
      const active = Number((await session.client.query<{ count: string }>(
        "select count(*) as count from usage_ledger where bucket=$1 and status='reserved'", [intent.bucket],
      )).rows[0]!.count);
      check();
      const cap = this.caps?.[intent.bucket];
      const daily = cap ? Math.min(budget.daily_requests ?? cap.daily, cap.daily) : budget.daily_requests;
      const concurrency = cap ? Math.min(budget.concurrency ?? cap.concurrency, cap.concurrency) : budget.concurrency;
      const reason = daily !== null && counter >= daily ? 'daily_limit'
        : concurrency !== null && active >= concurrency ? 'concurrency_limit' : undefined;
      if (reason) {
        await session.client.query('rollback');
        transaction = false;
        return { admitted: false, reason };
      }
      await session.client.query('insert into request_counters(day_utc,bucket,requests) values ($1,$2,1) on conflict(day_utc,bucket) do update set requests=request_counters.requests+1', [dayUtc, intent.bucket]);
      const row = (await session.client.query<{ id: string }>(
        `insert into usage_ledger(bucket,role,provider,model,occurred_at,status,owner_token,owner_pid,owner_backend_start,task_id,turn_id,tokens_source,cost_source)
         values ($1,$2,$3,$4,$5,'reserved',$6,$7,$8,$9,$10,'unknown','unknown') returning id`,
        [intent.bucket, intent.role, intent.provider, intent.model, admittedAt, session.owner.token, session.identity.pid, session.identity.backendStart, intent.taskId ?? null, intent.turnId ?? null],
      )).rows[0]!;
      check();
      session.markUnresolved();
      committing = true;
      await session.client.query('commit');
      transaction = false;
      check();
      state.reservation = { id: row.id, ownerToken: session.owner.token, bucket: intent.bucket, dayUtc };
      return { admitted: true, reservation: { ...state.reservation } };
    } catch (error) {
      if (committing) throw new Error('Usage reservation commit outcome unknown', { cause: error });
      if (transaction) {
        try { await session.client.query('rollback'); }
        catch { session.markUnresolved(); }
      }
      throw error;
    }
  }
}
