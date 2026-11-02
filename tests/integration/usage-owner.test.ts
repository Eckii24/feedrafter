import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withUsageOwner } from '../../src/server/adapters/postgres/usage-owner.js';
import { createUsageDatabase } from '../helpers/usage-database.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
beforeAll(async () => { db = await createUsageDatabase(); }, 30_000);
afterAll(async () => { await db?.dispose(); }, 30_000);

const controller = () => new AbortController();
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('dedicated usage owner', () => {
  it('holds distinct backends and exact textual identities with unique UUID names', async () => {
    const ready = deferred<void>();
    const done = deferred<void>();
    let first!: { token: string; pid: number; start: string };
    const a = withUsageOwner(db.pool, controller().signal, async ({ owner, client, identity }) => {
      first = { token: owner.token, pid: identity.pid, start: identity.backendStart };
      const row = (await client.query<{ pid: number; start: string; name: string }>("select pid, backend_start::text as start, current_setting('application_name') as name from pg_stat_activity where pid = pg_backend_pid()")).rows[0]!;
      expect(row).toEqual({ pid: first.pid, start: first.start, name: `feedrafter-usage:${first.token}` });
      ready.resolve();
      await done.promise;
    });
    await ready.promise;
    try {
      await withUsageOwner(db.pool, controller().signal, async ({ owner, identity }) => {
        expect(owner.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(owner.token).not.toBe(first.token);
        expect(identity.pid).not.toBe(first.pid);
      });
    } finally { done.resolve(); await a; }
  });

  it('cleans metadata on normal, thrown and caller-aborted actions', async () => {
    const abort = controller();
    let pid = 0;
    await expect(withUsageOwner(db.pool, abort.signal, async ({ owner, identity }) => {
      pid = identity.pid;
      abort.abort();
      expect(owner.signal.aborted).toBe(false);
      throw new Error('action failed');
    })).rejects.toThrow('action failed');
    const client = await db.pool.connect();
    try {
      const row = (await client.query<{ pid: number; name: string }>("select pg_backend_pid() as pid, current_setting('application_name') as name")).rows[0]!;
      expect(row.pid).toBe(pid);
      expect(row.name).not.toMatch(/^feedrafter-usage:/);
    } finally { client.release(); }
  });

  it('aborts owner loss on backend termination and never reuses the dead client', async () => {
    let pid = 0;
    await expect(withUsageOwner(db.pool, controller().signal, async ({ owner, identity }) => {
      pid = identity.pid;
      const lost = new Promise<void>((resolve) => owner.signal.addEventListener('abort', () => resolve(), { once: true }));
      await db.pool.query('select pg_terminate_backend($1)', [pid]);
      await Promise.race([lost, delay(3000).then(() => { throw new Error('owner loss not signalled'); })]);
      expect(owner.signal.aborted).toBe(true);
    })).rejects.toThrow('Usage owner connection lost');
    const row = (await db.pool.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!;
    expect(row.pid).not.toBe(pid);
  });

  it('runs a five-second heartbeat without overlap and signals query failure', async () => {
    const client = await db.pool.connect();
    const original = client.query.bind(client);
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const gate = deferred<void>();
    const spy = vi.spyOn(client, 'query').mockImplementation(((...args: unknown[]) => {
      if (args[0] !== 'select 1') return (original as (...args: unknown[]) => unknown)(...args);
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      return gate.promise.then(() => { active--; throw new Error('heartbeat failed'); });
    }) as typeof client.query);
    const pool = { connect: async () => client } as unknown as pg.Pool;
    try {
      await expect(withUsageOwner(pool, controller().signal, async ({ owner }) => {
        await delay(10_300);
        expect(calls).toBe(1);
        expect(maxActive).toBe(1);
        const lost = new Promise<void>((resolve) => owner.signal.addEventListener('abort', () => resolve(), { once: true }));
        gate.resolve();
        await lost;
        expect(owner.signal.aborted).toBe(true);
      })).rejects.toThrow('Usage owner connection lost');
    } finally { spy.mockRestore(); }
  }, 15_000);

  it.each(['unresolved return', 'unresolved throw', 'unresolved release error', 'lost before exit', 'lost during cleanup'] as const)(
    'destroys promptly with a pending heartbeat: %s', async (mode) => {
      const pool = new pg.Pool({ ...db.pool.options, max: 1 });
      const client = await pool.connect();
      const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      const original = client.query.bind(client);
      const gate = deferred<void>();
      const heartbeatStarted = deferred<void>();
      const finishAction = deferred<void>();
      const query = vi.spyOn(client, 'query').mockImplementation(((...args: unknown[]) => {
        if (args[0] !== 'select 1') return (original as (...args: unknown[]) => unknown)(...args);
        heartbeatStarted.resolve();
        return gate.promise.then(() => { throw new Error('late heartbeat failure'); });
      }) as typeof client.query);
      const originalRelease = client.release.bind(client);
      const release = vi.spyOn(client, 'release').mockImplementation((destroy) => {
        if (mode.startsWith('lost') || mode === 'unresolved release error') client.emit('error', new Error('error during destruction'));
        originalRelease(destroy);
      });
      const interval = globalThis.setInterval;
      let tick!: () => void;
      const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
        tick = callback;
        return interval(callback, 60_000);
      }) as typeof setInterval);
      let ownerListener!: (...args: unknown[]) => void;
      let ownerSignal!: AbortSignal;
      const result = withUsageOwner({ connect: async () => client } as unknown as pg.Pool, controller().signal, async ({ owner, markUnresolved }) => {
        ownerListener = client.listeners('error')[0] as (...args: unknown[]) => void;
        ownerSignal = owner.signal;
        timer.mockRestore();
        tick();
        await heartbeatStarted.promise;
        if (mode.startsWith('unresolved')) markUnresolved();
        if (mode === 'lost before exit') client.emit('error', new Error('connection lost'));
        await finishAction.promise;
        if (mode === 'unresolved throw') throw new Error('action failed');
      });
      // Observe rejection immediately, even if the prompt-completion assertion fails.
      const observed = result.then(() => 'returned', (error: Error) => error.message);
      try {
        await heartbeatStarted.promise;
        finishAction.resolve();
        if (mode === 'lost during cleanup') {
          await new Promise<void>((resolve) => setImmediate(resolve));
          client.emit('error', new Error('connection lost'));
        }
        const outcome = await Promise.race([observed, delay(500).then(() => 'timed out')]);
        expect(outcome).toBe(mode === 'unresolved return' ? 'returned' : mode === 'unresolved throw' ? 'action failed' : 'Usage owner connection lost');
        expect(release).toHaveBeenCalledExactlyOnceWith(true);
        expect(client.listeners('error')).not.toContain(ownerListener);
        expect((await pool.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid).not.toBe(pid);
        gate.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(ownerSignal.aborted).toBe(true);
      } finally {
        gate.resolve();
        finishAction.resolve();
        await observed;
        timer.mockRestore();
        query.mockRestore();
        release.mockRestore();
        await pool.end();
      }
    }, 10_000,
  );

  it('waits for a healthy pending heartbeat before resetting and reusing the client', async () => {
    const pool = new pg.Pool({ ...db.pool.options, max: 1 });
    const client = await pool.connect();
    const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    const original = client.query.bind(client);
    const gate = deferred<void>();
    const started = deferred<void>();
    const query = vi.spyOn(client, 'query').mockImplementation(((...args: unknown[]) => {
      if (args[0] !== 'select 1') return (original as (...args: unknown[]) => unknown)(...args);
      started.resolve();
      return gate.promise;
    }) as typeof client.query);
    const release = vi.spyOn(client, 'release');
    const interval = globalThis.setInterval;
    let tick!: () => void;
    const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
      tick = callback;
      return interval(callback, 60_000);
    }) as typeof setInterval);
    const result = withUsageOwner({ connect: async () => client } as unknown as pg.Pool, controller().signal, async () => {
      timer.mockRestore();
      tick();
      await started.promise;
    });
    try {
      await started.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(release).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalledWith('reset application_name');
      gate.resolve();
      await result;
      expect(query).toHaveBeenCalledWith('reset application_name');
      expect(release).toHaveBeenCalledExactlyOnceWith(false);
      expect((await pool.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid).toBe(pid);
    } finally {
      gate.resolve();
      await result;
      timer.mockRestore();
      query.mockRestore();
      release.mockRestore();
      await pool.end();
    }
  });

  it('releases a late checkout without SQL or action after caller cancellation', async () => {
    const pool = new pg.Pool({ ...db.pool.options, max: 1 });
    const client = await pool.connect();
    const query = vi.spyOn(client, 'query');
    const abort = controller();
    const action = vi.fn();
    try {
      const result = withUsageOwner(pool, abort.signal, action);
      expect(pool.waitingCount).toBe(1);
      abort.abort(new Error('cancelled'));
      await expect(result).rejects.toThrow('cancelled');
      client.release();
      for (let i = 0; i < 100 && pool.idleCount !== 1; i++) await delay(10);
      expect(pool.idleCount).toBe(1);
      expect(pool.waitingCount).toBe(0);
      expect(query).not.toHaveBeenCalled();
      expect(action).not.toHaveBeenCalled();
    } finally { query.mockRestore(); await pool.end(); }
  });

  it('destroys a client when metadata reset fails', async () => {
    const client = await db.pool.connect();
    const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    const original = client.query.bind(client);
    let ownerListener: unknown;
    const spy = vi.spyOn(client, 'query').mockImplementation(((...args: unknown[]) => {
      if (args[0] === 'reset application_name') return Promise.reject(new Error('reset failed'));
      return (original as (...args: unknown[]) => unknown)(...args);
    }) as typeof client.query);
    try {
      await expect(withUsageOwner({ connect: async () => client } as unknown as pg.Pool, controller().signal, async () => {
        ownerListener = client.listeners('error')[0]!;
      })).rejects.toThrow('Usage owner connection lost');
    } finally { spy.mockRestore(); }
    expect(ownerListener).toBeDefined();
    expect(client.listeners('error')).not.toContain(ownerListener);
    expect((await db.pool.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid).not.toBe(pid);
  });

  it('destroys unresolved owners but releases settled owners', async () => {
    let unresolved = 0;
    await withUsageOwner(db.pool, controller().signal, async ({ identity, markUnresolved }) => {
      unresolved = identity.pid;
      markUnresolved();
    });
    let settled = 0;
    await withUsageOwner(db.pool, controller().signal, async ({ identity, markUnresolved, markSettled }) => {
      settled = identity.pid;
      expect(settled).not.toBe(unresolved);
      markUnresolved();
      markSettled();
    });
    expect((await db.pool.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid).toBe(settled);
  });
});
