import { modelRoleNames } from '../../shared/settings.js';
import type { ModelUsageBucket, ReservationIntent, TerminalUsage } from '../domain/usage.js';
import type { UsageAdmissionPort } from '../ports/usage.js';

export type AttemptScope = { bucket: ModelUsageBucket; taskId?: string; turnId?: string; signal: AbortSignal };
export type InvokeResult<T> =
  | { kind: 'success'; value: T; terminal: TerminalUsage & { status: 'succeeded' } }
  | { kind: 'failure'; failureKind: 'auth' | 'provider'; terminal: TerminalUsage & { status: 'failed' } }
  | { kind: 'uncertain'; terminal: TerminalUsage & { status: 'uncertain' } };
export type AttemptResult<T> = { kind: 'completed'; value: T; reservationId: string }
  | { kind: 'paused_budget'; reason: 'daily_limit' | 'concurrency_limit' }
  | { kind: 'paused_auth' };
export class UsageAttemptError extends Error {
  constructor(readonly reservationId: string, readonly kind: 'auth' | 'provider' | 'uncertain' | 'aborted') {
    super(`Usage attempt ${kind}`); this.name = 'UsageAttemptError';
  }
}
export class UsageAccountingError extends Error {
  constructor(readonly phase: 'recovery' | 'owner' | 'reservation' | 'settlement' | 'owner_exit', readonly reservationId: string | null) {
    super(`Usage accounting ${phase} failed`); this.name = 'UsageAccountingError';
  }
}

// Nested maps preserve exact physical provider/model identity without delimiter collisions.
const authPaused = new Map<string, Set<string>>();
const isPaused = (intent: ReservationIntent) => authPaused.get(intent.provider)?.has(intent.model) ?? false;
function pause(intent: ReservationIntent): void {
  let models = authPaused.get(intent.provider);
  if (!models) { models = new Set(); authPaused.set(intent.provider, models); }
  models.add(intent.model);
}
const safeTerminal = (status: 'failed' | 'uncertain', outcomeCode: string): TerminalUsage => ({
  status, outcomeCode, inputTokens: null, outputTokens: null, costUsd: null, tokensSource: 'unknown', costSource: 'unknown',
});
class UsageAbortError extends Error { constructor() { super('Usage attempt aborted'); this.name = 'AbortError'; } }
function aborted(): Error { return new UsageAbortError(); }
function trustworthyTerminal(value: TerminalUsage | undefined): value is TerminalUsage {
  const tokens = (n: unknown) => n === null || (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 2147483647);
  return !!value && tokens(value.inputTokens) && tokens(value.outputTokens)
    && (value.costUsd === null || (typeof value.costUsd === 'number' && Number.isFinite(value.costUsd) && value.costUsd >= 0))
    && (value.tokensSource === 'provider' || value.tokensSource === 'unknown')
    && (value.costSource === 'provider' || value.costSource === 'unknown')
    && (value.tokensSource !== 'provider' || (value.inputTokens !== null && value.outputTokens !== null))
    && (value.costSource !== 'provider' || value.costUsd !== null)
    && (value.costSource !== 'unknown' || value.costUsd === null)
    && (value.outcomeCode === null || (typeof value.outcomeCode === 'string' && /^[a-z0-9_]{1,128}$/.test(value.outcomeCode)));
}
function validate(intent: ReservationIntent, scope: AttemptScope): void {
  if (!intent || !scope || !['automatic', 'interactive', 'classifier'].includes(intent.bucket)
    || !(modelRoleNames as readonly string[]).includes(intent.role)
    || typeof intent.provider !== 'string' || !intent.provider.trim() || typeof intent.model !== 'string' || !intent.model.trim()
    || (intent.taskId !== undefined && typeof intent.taskId !== 'string') || (intent.turnId !== undefined && typeof intent.turnId !== 'string')
    || intent.bucket !== scope.bucket || intent.taskId !== scope.taskId || intent.turnId !== scope.turnId
    || !scope.signal || typeof scope.signal.addEventListener !== 'function') throw new RangeError('Invalid usage intent or scope');
}

export class UsageService {
  constructor(private readonly port: UsageAdmissionPort) {}
  async executeAttempt<T>(input: ReservationIntent, scope: AttemptScope, invoke: (signal: AbortSignal) => Promise<InvokeResult<T>>): Promise<AttemptResult<T>> {
    validate(input, scope);
    const intent = { ...input };
    const signal = scope.signal;
    if (isPaused(intent)) return { kind: 'paused_auth' };
    if (signal.aborted) throw aborted();
    try { await this.port.recover(); } catch { throw new UsageAccountingError('recovery', null); }
    if (isPaused(intent)) return { kind: 'paused_auth' };
    if (signal.aborted) throw aborted();
    let phase: UsageAccountingError['phase'] = 'owner';
    let reservationId: string | null = null;
    try {
      return await this.port.withOwner(signal, async (owner) => {
        if (isPaused(intent)) { phase = 'owner_exit'; return { kind: 'paused_auth' }; }
        if (signal.aborted) throw aborted();
        if (owner.signal.aborted) throw new UsageAccountingError('owner', null);
        phase = 'reservation';
        const admission = await this.port.reserve(owner, intent);
        if (!admission.admitted) {
          if (owner.signal.aborted) throw new UsageAccountingError('owner', null);
          if (signal.aborted) throw aborted();
          phase = 'owner_exit';
          if (isPaused(intent)) return { kind: 'paused_auth' };
          return { kind: 'paused_budget', reason: admission.reason };
        }
        const reservation = admission.reservation;
        reservationId = reservation.id;
        let result: InvokeResult<T> | undefined;
        let failure: UsageAttemptError['kind'] | undefined;
        let terminal: TerminalUsage;
        if (owner.signal.aborted) throw new UsageAccountingError('settlement', reservationId);
        if (signal.aborted || isPaused(intent)) {
          failure = signal.aborted ? 'aborted' : 'auth';
          terminal = safeTerminal('failed', signal.aborted ? 'cancelled_before_dispatch' : 'auth_paused');
        } else {
          const combined = AbortSignal.any([signal, owner.signal]);
          // Listen before invoking. Both callback handlers stay attached after abort.
          const winner = await new Promise<{ kind: 'callback'; value: InvokeResult<T> } | { kind: 'thrown' | 'abort' }>((resolve) => {
            const onAbort = () => { combined.removeEventListener('abort', onAbort); resolve({ kind: 'abort' }); };
            combined.addEventListener('abort', onAbort, { once: true });
            if (combined.aborted) { onAbort(); return; }
            try {
              void Promise.resolve(invoke(combined)).then(
                (value) => {
                  // Observe explicit auth even after abort, independently of terminal metadata.
                  if (value?.kind === 'failure' && value.failureKind === 'auth') pause(intent);
                  combined.removeEventListener('abort', onAbort); resolve({ kind: 'callback', value });
                },
                () => { combined.removeEventListener('abort', onAbort); resolve({ kind: 'thrown' }); },
              );
            } catch { combined.removeEventListener('abort', onAbort); resolve({ kind: 'thrown' }); }
          });
          if (owner.signal.aborted) throw new UsageAccountingError('settlement', reservationId);
          if (winner.kind === 'callback' && winner.value && trustworthyTerminal(winner.value.terminal) && (
            (winner.value.kind === 'success' && winner.value.terminal?.status === 'succeeded')
            || (winner.value.kind === 'failure' && winner.value.terminal?.status === 'failed' && ['auth', 'provider'].includes(winner.value.failureKind))
            || (winner.value.kind === 'uncertain' && winner.value.terminal?.status === 'uncertain')
          )) {
            result = winner.value;
            terminal = result.terminal;
            if (result.kind === 'failure') failure = result.failureKind;
            else if (result.kind === 'uncertain') failure = 'uncertain';
          } else { failure = 'uncertain'; terminal = safeTerminal('uncertain', 'outcome_unknown'); }
        }
        phase = 'settlement';
        const settled = await this.port.settle(owner, reservation, terminal);
        if (settled !== 'settled' || owner.signal.aborted) throw new UsageAccountingError('settlement', reservationId);
        phase = 'owner_exit';
        if (failure) throw new UsageAttemptError(reservation.id, failure);
        if (!result || result.kind !== 'success') throw new UsageAttemptError(reservation.id, 'uncertain');
        return { kind: 'completed', value: result.value, reservationId: reservation.id };
      });
    } catch (error) {
      if (error instanceof UsageAttemptError || error instanceof UsageAccountingError || error instanceof UsageAbortError) throw error;
      throw new UsageAccountingError(phase, reservationId);
    }
  }
}
