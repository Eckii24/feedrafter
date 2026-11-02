import { describe, expect, it, vi } from 'vitest';
import { UsageAccountingError, UsageAttemptError, UsageService, type InvokeResult } from '../../src/server/application/usage.js';
import type { UsageAdmissionPort, UsageOwner } from '../../src/server/ports/usage.js';
import type { ReservationIntent, TerminalUsage } from '../../src/server/domain/usage.js';

const terminal = <S extends TerminalUsage['status']>(status: S): TerminalUsage & { status: S } => ({ status, inputTokens: null, outputTokens: null, costUsd: null, tokensSource: 'unknown', costSource: 'unknown', outcomeCode: null });
const intent: ReservationIntent = { bucket: 'automatic', role: 'summary', provider: 'unit-provider', model: 'unit-model' };
const scope = () => ({ bucket: 'automatic' as const, signal: new AbortController().signal });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const order: string[] = [];
  const owner: UsageOwner = { token: 'owner', signal: new AbortController().signal };
  const port: UsageAdmissionPort = {
    recover: vi.fn(async () => { order.push('recover'); return 0; }),
    withOwner: vi.fn(async (_signal, action) => { order.push('owner'); const result = await action(owner); order.push('exit'); return result; }),
    reserve: vi.fn<UsageAdmissionPort['reserve']>(async () => { order.push('reserve'); return { admitted: true, reservation: { id: 'r', ownerToken: 'owner', bucket: 'automatic', dayUtc: '2026-01-01' } }; }),
    settle: vi.fn<UsageAdmissionPort['settle']>(async () => { order.push('settle'); return 'settled'; }),
  };
  return { port, order, owner };
}
describe('usage gate', () => {
  it('recovers, reserves, invokes once, settles and exits before returning', async () => {
    const { port, order } = fixture();
    const result = await new UsageService(port).executeAttempt(intent, scope(), async () => { order.push('invoke'); return { kind: 'success', value: 42, terminal: terminal('succeeded') }; });
    expect(result).toEqual({ kind: 'completed', value: 42, reservationId: 'r' });
    expect(order).toEqual(['recover', 'owner', 'reserve', 'invoke', 'settle', 'exit']);
  });

  it('rejects mismatched scope and pre-abort before recovery', async () => {
    const { port } = fixture(); const service = new UsageService(port); const invoke = vi.fn();
    await expect(service.executeAttempt(intent, { ...scope(), taskId: 'other' }, invoke)).rejects.toThrow(RangeError);
    const controller = new AbortController(); controller.abort('secret');
    await expect(service.executeAttempt(intent, { ...scope(), signal: controller.signal }, invoke)).rejects.toMatchObject({ name: 'AbortError', message: 'Usage attempt aborted' });
    expect(port.recover).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });

  it('returns budget denial without invoking and sanitizes recovery/reservation errors', async () => {
    const { port } = fixture(); const invoke = vi.fn();
    vi.mocked(port.reserve).mockResolvedValueOnce({ admitted: false, reason: 'daily_limit' });
    expect(await new UsageService(port).executeAttempt(intent, scope(), invoke)).toEqual({ kind: 'paused_budget', reason: 'daily_limit' });
    vi.mocked(port.recover).mockRejectedValueOnce(new Error('secret db'));
    await expect(new UsageService(port).executeAttempt(intent, scope(), invoke)).rejects.toMatchObject({ phase: 'recovery', reservationId: null, message: 'Usage accounting recovery failed' });
    vi.mocked(port.reserve).mockRejectedValueOnce(new Error('secret db'));
    await expect(new UsageService(port).executeAttempt(intent, scope(), invoke)).rejects.toMatchObject({ phase: 'reservation', reservationId: null });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('latches explicit auth across service instances and roles before settlement, not raw throws', async () => {
    const { port } = fixture(); const authIntent = { ...intent, provider: 'auth-unit' };
    vi.mocked(port.settle).mockRejectedValueOnce(new Error('secret'));
    await expect(new UsageService(port).executeAttempt(authIntent, scope(), async () => ({ kind: 'failure', failureKind: 'auth', terminal: terminal('failed') }))).rejects.toBeInstanceOf(UsageAccountingError);
    expect(await new UsageService(port).executeAttempt({ ...authIntent, role: 'chat' }, scope(), vi.fn())).toEqual({ kind: 'paused_auth' });
    const throwIntent = { ...intent, provider: 'throws-unit' };
    await expect(new UsageService(port).executeAttempt(throwIntent, scope(), async () => { throw new Error('401 auth secret'); })).rejects.toMatchObject({ kind: 'uncertain', reservationId: 'r' });
    expect(await new UsageService(port).executeAttempt(throwIntent, scope(), async () => ({ kind: 'success', value: 1, terminal: terminal('succeeded') }))).toMatchObject({ kind: 'completed' });
    expect(await new UsageService(port).executeAttempt({ ...authIntent, model: 'other' }, scope(), async () => ({ kind: 'success', value: 2, terminal: terminal('succeeded') }))).toMatchObject({ kind: 'completed' });
  });

  it.each([
    { status: 'failed', inputTokens: -1 },
    { status: 'succeeded' },
    undefined,
  ])('latches explicit auth with untrustworthy terminal metadata %#', async (badTerminal) => {
    const { port } = fixture(); const pair = { ...intent, provider: `bad-auth-${badTerminal?.status ?? 'missing'}-${badTerminal?.inputTokens ?? 'none'}` };
    const response = { kind: 'failure', failureKind: 'auth', terminal: badTerminal } as unknown as InvokeResult<never>;
    await expect(new UsageService(port).executeAttempt(pair, scope(), async () => response)).rejects.toMatchObject({ kind: 'uncertain', reservationId: 'r' });
    expect(port.settle).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ status: 'uncertain', outcomeCode: 'outcome_unknown', inputTokens: null, tokensSource: 'unknown' }));
    const next = fixture(); const invoke = vi.fn();
    expect(await new UsageService(next.port).executeAttempt({ ...pair, role: 'chat' }, scope(), invoke)).toEqual({ kind: 'paused_auth' });
    expect(next.port.recover).not.toHaveBeenCalled(); expect(next.port.reserve).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
    expect(await new UsageService(next.port).executeAttempt({ ...pair, model: 'other' }, scope(), async () => ({ kind: 'success', value: 1, terminal: terminal('succeeded') }))).toMatchObject({ kind: 'completed' });
  });

  it.each(['already_terminal', 'ownership_lost', 'error'] as const)('never publishes success for settlement %s', async (outcome) => {
    const { port } = fixture();
    if (outcome === 'error') vi.mocked(port.settle).mockRejectedValueOnce(new Error('secret'));
    else vi.mocked(port.settle).mockResolvedValueOnce(outcome);
    const invoke = vi.fn(async () => ({ kind: 'success' as const, value: 1, terminal: terminal('succeeded') }));
    await expect(new UsageService(port).executeAttempt(intent, scope(), invoke)).rejects.toMatchObject({ phase: 'settlement', reservationId: 'r', message: 'Usage accounting settlement failed' });
    expect(invoke).toHaveBeenCalledTimes(1); expect(port.settle).toHaveBeenCalledTimes(1);
  });

  it('settles pre-invoke abort as failed without invoking', async () => {
    const { port } = fixture(); const controller = new AbortController(); const original = vi.mocked(port.reserve).getMockImplementation()!;
    vi.mocked(port.reserve).mockImplementation(async (...args) => { const result = await original(...args); controller.abort('secret'); return result; });
    const invoke = vi.fn();
    await expect(new UsageService(port).executeAttempt(intent, { ...scope(), signal: controller.signal }, invoke)).rejects.toMatchObject({ kind: 'aborted', reservationId: 'r' });
    expect(invoke).not.toHaveBeenCalled(); expect(port.settle).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ status: 'failed', outcomeCode: 'cancelled_before_dispatch' }));
  });

  it('aborts in-flight invocation as uncertain and ignores late success', async () => {
    const { port } = fixture(); const controller = new AbortController();
    let finish!: (value: { kind: 'success'; value: number; terminal: ReturnType<typeof terminal<'succeeded'>> }) => void;
    const callback = new Promise<{ kind: 'success'; value: number; terminal: ReturnType<typeof terminal<'succeeded'>> }>((resolve) => { finish = resolve; });
    const started = deferred<void>();
    const pending = new UsageService(port).executeAttempt(intent, { ...scope(), signal: controller.signal }, async (signal) => { expect(signal.aborted).toBe(false); started.resolve(); return callback; });
    await started.promise; controller.abort('secret');
    await expect(pending).rejects.toMatchObject({ kind: 'uncertain', reservationId: 'r' });
    finish({ kind: 'success', value: 7, terminal: terminal('succeeded') }); await Promise.resolve();
    expect(port.settle).toHaveBeenCalledTimes(1); expect(port.settle).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ status: 'uncertain' }));
  });

  it('latches late explicit auth after abort without changing uncertain settlement', async () => {
    const { port } = fixture(); const controller = new AbortController();
    const pair = { ...intent, provider: 'late-auth-unit', model: 'exact-model' };
    const started = deferred<void>(); const observed = deferred<void>(); const callback = deferred<InvokeResult<never>>();
    const invoke = vi.fn(() => { started.resolve(); return callback.promise; });
    const pending = new UsageService(port).executeAttempt(pair, { ...scope(), signal: controller.signal }, invoke);
    await started.promise; controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'uncertain', reservationId: 'r' });
    expect(port.settle).toHaveBeenCalledTimes(1);
    expect(port.settle).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ status: 'uncertain', outcomeCode: 'outcome_unknown' }));
    callback.resolve({ kind: 'failure', get failureKind(): 'auth' { observed.resolve(); return 'auth'; }, terminal: { ...terminal('failed'), inputTokens: -1 } });
    await observed.promise;
    const next = fixture(); const nextInvoke = vi.fn();
    expect(await new UsageService(next.port).executeAttempt({ ...pair, role: 'chat' }, scope(), nextInvoke)).toEqual({ kind: 'paused_auth' });
    expect(next.port.recover).not.toHaveBeenCalled(); expect(next.port.withOwner).not.toHaveBeenCalled();
    expect(next.port.reserve).not.toHaveBeenCalled(); expect(next.port.settle).not.toHaveBeenCalled(); expect(nextInvoke).not.toHaveBeenCalled();
    expect(port.recover).toHaveBeenCalledTimes(1); expect(port.withOwner).toHaveBeenCalledTimes(1);
    expect(port.reserve).toHaveBeenCalledTimes(1); expect(port.settle).toHaveBeenCalledTimes(1); expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('treats a truncated terminal as uncertain instead of publishing success', async () => {
    const { port } = fixture();
    const truncated = { kind: 'success', value: 'not trusted', terminal: { status: 'succeeded' } } as unknown as InvokeResult<string>;
    await expect(new UsageService(port).executeAttempt(intent, scope(), async () => truncated)).rejects.toMatchObject({ kind: 'uncertain', reservationId: 'r' });
    expect(port.settle).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ status: 'uncertain', outcomeCode: 'outcome_unknown' }));
  });

  it('consumes late callback rejection after caller abort', async () => {
    const { port } = fixture(); const controller = new AbortController(); const started = deferred<void>();
    let reject!: (error: Error) => void;
    const callback = new Promise<never>((_resolve, fail) => { reject = fail; });
    const pending = new UsageService(port).executeAttempt(intent, { ...scope(), signal: controller.signal }, async () => { started.resolve(); return callback; });
    await started.promise; controller.abort(); await expect(pending).rejects.toMatchObject({ kind: 'uncertain' });
    reject(new Error('late secret')); await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(port.settle).toHaveBeenCalledTimes(1);
  });

  it('waits for settlement and owner exit; owner cleanup failure prevents success', async () => {
    const { port } = fixture(); const settle = deferred<'settled'>(); const started = deferred<void>();
    vi.mocked(port.settle).mockImplementation(async () => { started.resolve(); return settle.promise; });
    let completed = false;
    const pending = new UsageService(port).executeAttempt(intent, scope(), async () => ({ kind: 'success', value: 1, terminal: terminal('succeeded') })).then(() => { completed = true; });
    await started.promise; expect(completed).toBe(false); settle.resolve('settled'); await pending; expect(completed).toBe(true);
    const other = fixture(); const original = other.port.withOwner;
    other.port.withOwner = async (signal, action) => { await original(signal, action); throw new Error('secret reset'); };
    await expect(new UsageService(other.port).executeAttempt(intent, scope(), async () => ({ kind: 'success', value: 1, terminal: terminal('succeeded') }))).rejects.toMatchObject({ phase: 'owner_exit', reservationId: 'r' });
  });

  it('loses owner while invoking, ignores late result and leaves row for recovery', async () => {
    const { port, owner } = fixture(); const lost = new AbortController();
    Object.defineProperty(owner, 'signal', { value: lost.signal });
    const callback = deferred<{ kind: 'success'; value: number; terminal: ReturnType<typeof terminal<'succeeded'>> }>();
    const started = deferred<void>();
    const pending = new UsageService(port).executeAttempt(intent, scope(), async (signal) => { started.resolve(); expect(signal.aborted).toBe(false); return callback.promise; });
    await started.promise; lost.abort();
    await expect(pending).rejects.toMatchObject({ phase: 'settlement', reservationId: 'r' });
    callback.resolve({ kind: 'success', value: 1, terminal: terminal('succeeded') }); await Promise.resolve();
    expect(port.settle).not.toHaveBeenCalled();
  });

  it('latches before pending settlement and keeps exact pair keys distinct', async () => {
    const { port } = fixture(); const settle = deferred<'settled'>(); const started = deferred<void>();
    vi.mocked(port.settle).mockImplementation(async () => { started.resolve(); return settle.promise; });
    const pair = { ...intent, provider: 'collision:a', model: 'b' };
    const pending = new UsageService(port).executeAttempt(pair, scope(), async () => ({ kind: 'failure', failureKind: 'auth', terminal: terminal('failed') }));
    await started.promise;
    const other = fixture();
    expect(await new UsageService(other.port).executeAttempt(pair, scope(), vi.fn())).toEqual({ kind: 'paused_auth' });
    expect(other.port.recover).not.toHaveBeenCalled();
    expect(await new UsageService(other.port).executeAttempt({ ...pair, provider: 'collision', model: 'a:b' }, scope(), async () => ({ kind: 'success', value: 1, terminal: terminal('succeeded') }))).toMatchObject({ kind: 'completed' });
    settle.resolve('settled'); await expect(pending).rejects.toMatchObject({ kind: 'auth', reservationId: 'r' });
  });

  it('waits for owner exit before publishing', async () => {
    const { port } = fixture(); const release = deferred<void>(); const exiting = deferred<void>(); const original = port.withOwner;
    port.withOwner = async (signal, action) => { const value = await original(signal, action); exiting.resolve(); await release.promise; return value; };
    let done = false;
    const pending = new UsageService(port).executeAttempt(intent, scope(), async () => ({ kind: 'success', value: 1, terminal: terminal('succeeded') })).then(() => { done = true; });
    await exiting.promise; expect(done).toBe(false); release.resolve(); await pending; expect(done).toBe(true);
  });

  it('rechecks auth after committed reservation without invoking', async () => {
    const first = fixture(); const second = fixture(); const pair = { ...intent, provider: 'recheck-auth' };
    const reserved = deferred<void>(); const release = deferred<void>(); const original = vi.mocked(second.port.reserve).getMockImplementation()!;
    vi.mocked(second.port.reserve).mockImplementation(async (...args) => { const result = await original(...args); reserved.resolve(); await release.promise; return result; });
    const invoke = vi.fn(); const pending = new UsageService(second.port).executeAttempt(pair, scope(), invoke);
    await reserved.promise;
    await expect(new UsageService(first.port).executeAttempt(pair, scope(), async () => ({ kind: 'failure', failureKind: 'auth', terminal: terminal('failed') }))).rejects.toMatchObject({ kind: 'auth' });
    release.resolve(); await expect(pending).rejects.toMatchObject({ kind: 'auth', reservationId: 'r' });
    expect(invoke).not.toHaveBeenCalled();
    expect(second.port.settle).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ status: 'failed', outcomeCode: 'auth_paused' }));
  });

  it('checks abort after recovery before acquiring owner', async () => {
    const { port } = fixture(); const controller = new AbortController();
    vi.mocked(port.recover).mockImplementation(async () => { controller.abort(); return 0; });
    await expect(new UsageService(port).executeAttempt(intent, { ...scope(), signal: controller.signal }, vi.fn())).rejects.toMatchObject({ name: 'AbortError' });
    expect(port.withOwner).not.toHaveBeenCalled(); expect(port.reserve).not.toHaveBeenCalled();
  });

  it('settles trustworthy provider failure and uncertain outcome', async () => {
    for (const result of [{ kind: 'failure', failureKind: 'provider', terminal: terminal('failed') }, { kind: 'uncertain', terminal: terminal('uncertain') }] as const) {
      const { port } = fixture();
      await expect(new UsageService(port).executeAttempt(intent, scope(), async () => result)).rejects.toBeInstanceOf(UsageAttemptError);
      expect(port.settle).toHaveBeenCalledWith(expect.anything(), expect.anything(), result.terminal);
    }
  });
});
