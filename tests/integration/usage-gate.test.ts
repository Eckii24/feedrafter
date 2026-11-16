import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSingleSendFetch } from '../../src/server/adapters/pi/single-send-transport.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { PostgresUsageAdmissionStore } from '../../src/server/adapters/postgres/usage-admission-store.js';
import { UsageService, type AttemptDispatchPermit } from '../../src/server/application/usage.js';
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
  it('issues a one-use permit only after the reservation is visible in PostgreSQL', async () => {
    let issued!: AttemptDispatchPermit;
    const result = await service.executeAttempt(intent, scope(), async (_signal, permit) => {
      issued = permit;
      expect((await db.pool.query('select status from usage_ledger')).rows).toEqual([{ status: 'reserved' }]);
      permit.consume();
      expect(() => permit.consume()).toThrow('Dispatch permit unavailable');
      return { kind: 'success', value: 'ok', terminal: terminal('succeeded') };
    });
    expect(result.kind).toBe('completed');
    expect(() => issued.consume()).toThrow('Dispatch permit unavailable');
  });
  it('holds a committed reservation behind a barrier and revokes concurrent and late permit use', async () => {
    let release!: () => void; let ready!: (permit: AttemptDispatchPermit) => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<AttemptDispatchPermit>((resolve) => { ready = resolve; });
    const pending = service.executeAttempt(intent, scope(), async (_signal, permit) => {
      ready(permit);
      await barrier;
      return { kind: 'success', value: 'ok', terminal: terminal('succeeded') };
    });
    const permit = await started;
    try {
      expect((await db.pool.query('select status from usage_ledger')).rows).toEqual([{ status: 'reserved' }]);
      expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 1 }]);
      const results = await Promise.allSettled([Promise.resolve().then(() => permit.consume()), Promise.resolve().then(() => permit.consume())]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    } finally {
      release();
      await pending;
    }
    expect(() => permit.consume()).toThrow('Dispatch permit unavailable');
    expect((await db.pool.query('select status from usage_ledger')).rows).toEqual([{ status: 'succeeded' }]);
  });
  it('transmits once with a database-issued permit after the reservation commits', async () => {
    let ready!: () => void; let response!: import('node:http').ServerResponse;
    const arrived = new Promise<void>(resolve => { ready = resolve; });
    let count = 0;
    const server = createServer((_req, res) => { count++; response = res; ready(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const pending = service.executeAttempt(intent, scope(), async (signal, permit) => {
      const send = createSingleSendFetch({ url, signal, permit, timeoutMs: 5000, maxResponseBytes: 1024 });
      await expect(send(`${url}/other`, { method: 'POST' })).rejects.toThrow('route');
      expect(await (await send(url, { method: 'POST', body: 'test' })).text()).toBe('ok');
      await expect(send(url, { method: 'POST' })).rejects.toThrow('already used');
      return { kind: 'success', value: 'ok', terminal: terminal('succeeded') };
    });
    try {
      await arrived;
      expect(count).toBe(1);
      expect((await db.pool.query('select status from usage_ledger')).rows).toEqual([{ status: 'reserved' }]);
      expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 1 }]);
    } finally {
      response?.end('ok');
      try { await pending; } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    }
    expect(count).toBe(1);
    expect((await db.pool.query('select status from usage_ledger')).rows).toEqual([{ status: 'succeeded' }]);
  });
  it('correlates concurrent held wires with exact reservations through reverse completion and denial', async () => {
    await db.pool.query("update budget_settings set concurrency=2 where bucket='automatic'");
    const received = new Map<string, import('node:http').ServerResponse>();
    const arrivals = new Map<string, () => void>();
    const server = createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; });
      req.on('end', () => { const marker = JSON.parse(body) as { taskId: string; turnId: string }; received.set(JSON.stringify(marker), res); arrivals.get(JSON.stringify(marker))?.(); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const markers = Array.from({ length: 3 }, () => ({ taskId: randomUUID(), turnId: randomUUID() }));
    const arrived = markers.slice(0, 2).map(marker => new Promise<void>(resolve => arrivals.set(JSON.stringify(marker), resolve)));
    const attempts = markers.slice(0, 2).map(marker => service.executeAttempt({ ...intent, ...marker }, { ...scope(), ...marker }, async (signal, permit) => {
      const opts = { url, signal, permit, timeoutMs: 5000, maxResponseBytes: 1024 };
      const first = createSingleSendFetch(opts)(url, { method: 'POST', body: JSON.stringify(marker) });
      await expect(createSingleSendFetch(opts)(url, { method: 'POST', body: JSON.stringify({ duplicate: marker }) })).rejects.toThrow('Dispatch permit unavailable');
      expect(await (await first).text()).toBe('ok');
      return { kind: 'success', value: marker, terminal: terminal('succeeded') };
    }));
    try {
      await Promise.all(arrived);
      const rows = (await db.pool.query('select id, task_id, turn_id, status from usage_ledger')).rows;
      expect(rows).toHaveLength(2); expect(received.size).toBe(2);
      for (const marker of markers.slice(0, 2)) expect(rows).toContainEqual(expect.objectContaining({ task_id: marker.taskId, turn_id: marker.turnId, status: 'reserved' }));
      const denied = markers[2]!; const invoke = vi.fn();
      expect(await service.executeAttempt({ ...intent, ...denied }, { ...scope(), ...denied }, invoke)).toEqual({ kind: 'paused_budget', reason: 'concurrency_limit' });
      expect(invoke).not.toHaveBeenCalled();
      received.get(JSON.stringify(markers[1]))!.end('ok');
      const second = await attempts[1];
      expect(second).toMatchObject({ kind: 'completed', reservationId: rows.find(row => row.task_id === markers[1]!.taskId)!.id });
      expect((await db.pool.query('select status from usage_ledger where id=$1', [rows.find(row => row.task_id === markers[0]!.taskId)!.id])).rows[0]).toEqual({ status: 'reserved' });
      received.get(JSON.stringify(markers[0]))!.end('ok');
      const first = await attempts[0];
      expect(first).toMatchObject({ kind: 'completed', reservationId: rows.find(row => row.task_id === markers[0]!.taskId)!.id });
      expect((await db.pool.query('select status from usage_ledger')).rows).toEqual([{ status: 'succeeded' }, { status: 'succeeded' }]);
      expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 2 }]);
      expect(received.size).toBe(2);
    } finally {
      for (const response of received.values()) if (!response.writableEnded) response.end('ok');
      await Promise.allSettled(attempts); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('blocks a not-yet-dispatched permit after a peer observes auth while another wire finishes', async () => {
    await db.pool.query("update budget_settings set concurrency=3 where bucket='automatic'");
    const pair = { ...intent, provider: 'pg-auth-wire-race' };
    const blockedMarker = { taskId: randomUUID(), turnId: randomUUID() };
    const peerMarker = { taskId: randomUUID(), turnId: randomUUID() };
    const authMarker = { taskId: randomUUID(), turnId: randomUUID() };
    let enter!: () => void; let release!: () => void; let peerArrived!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { peerArrived = resolve; });
    let peerResponse!: import('node:http').ServerResponse; const wires: string[] = [];
    const server = createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; });
      req.on('end', () => { wires.push(body); if (body === peerMarker.taskId) { peerResponse = res; peerArrived(); } else { res.writeHead(401); res.end(); } });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const blocked = service.executeAttempt({ ...pair, ...blockedMarker }, { ...scope(), ...blockedMarker }, async (signal, permit) => {
      enter(); await barrier;
      await createSingleSendFetch({ url, signal, permit, timeoutMs: 5000, maxResponseBytes: 1024 })(url, { method: 'POST', body: blockedMarker.taskId });
      return { kind: 'success', value: 1, terminal: terminal('succeeded') };
    });
    const blockedResult = expect(blocked).rejects.toMatchObject({ kind: 'auth' });
    await entered;
    const peer = service.executeAttempt({ ...pair, ...peerMarker }, { ...scope(), ...peerMarker }, async (signal, permit) => {
      await (await createSingleSendFetch({ url, signal, permit, timeoutMs: 5000, maxResponseBytes: 1024 })(url, { method: 'POST', body: peerMarker.taskId })).text();
      return { kind: 'success', value: 2, terminal: terminal('succeeded') };
    });
    try {
      await arrived;
      await expect(service.executeAttempt({ ...pair, ...authMarker }, { ...scope(), ...authMarker }, async (signal, permit) => {
        const response = await createSingleSendFetch({ url, signal, permit, timeoutMs: 5000, maxResponseBytes: 1024 })(url, { method: 'POST', body: authMarker.taskId });
        expect(response.status).toBe(401);
        return { kind: 'failure', failureKind: 'auth', terminal: terminal('failed') };
      })).rejects.toMatchObject({ kind: 'auth' });
      release(); await blockedResult;
      const rows = (await db.pool.query('select task_id, turn_id, status, outcome_code from usage_ledger')).rows;
      expect(rows).toContainEqual({ task_id: blockedMarker.taskId, turn_id: blockedMarker.turnId, status: 'failed', outcome_code: 'auth_paused' });
      expect(rows).toHaveLength(3);
      expect((await db.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 3 }]);
      expect(await service.executeAttempt(pair, scope(), vi.fn())).toEqual({ kind: 'paused_auth' });
      peerResponse.end('ok'); expect(await peer).toMatchObject({ kind: 'completed', value: 2 });
      expect(wires.sort()).toEqual([peerMarker.taskId, authMarker.taskId].sort());
    } finally {
      release(); peerResponse?.end('ok'); await Promise.allSettled([blocked, peer]); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
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
