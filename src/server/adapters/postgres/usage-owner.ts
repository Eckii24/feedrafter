import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { UsageOwner } from '../../ports/usage.js';

/** Adapter-only session state. Application code receives only owner. */
export interface UsageOwnerSession {
  readonly owner: UsageOwner;
  readonly client: pg.PoolClient;
  readonly identity: { readonly pid: number; readonly backendStart: string };
  markUnresolved(): void;
  markSettled(): void;
  invalidate(): void;
}

async function checkout(pool: pg.Pool, signal: AbortSignal): Promise<pg.PoolClient> {
  signal.throwIfAborted();
  const pending = pool.connect();
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const onAbort = () => { cancelled = true; reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void pending.then((client) => {
      signal.removeEventListener('abort', onAbort);
      if (cancelled) client.release();
      else resolve(client);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      if (!cancelled) reject(error);
    });
  });
}

/** One session for one attempt; never reconnect or pool an unresolved owner. */
export async function withUsageOwner<T>(pool: pg.Pool, signal: AbortSignal, action: (session: UsageOwnerSession) => Promise<T>): Promise<T> {
  const client = await checkout(pool, signal);
  const lost = new AbortController();
  const onError = () => lost.abort(new Error('Usage owner connection lost'));
  client.on('error', onError);
  let heartbeat: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let unresolved = false;
  let configured = false;
  let succeeded = false;
  let released = false;
  try {
    signal.throwIfAborted();
    const token = randomUUID();
    const result = await client.query<{ pid: number; backend_start: string }>(
      'select pid, backend_start::text as backend_start from pg_stat_activity where pid = pg_backend_pid()',
    ).catch((error: unknown) => { onError(); throw error; });
    const row = result.rows[0];
    if (!row || !row.pid || !row.backend_start) { onError(); throw new Error('Usage owner identity unavailable'); }
    lost.signal.throwIfAborted();
    signal.throwIfAborted();
    await client.query("select set_config('application_name', $1, false)", [`feedrafter-usage:${token}`])
      .catch((error: unknown) => { onError(); throw error; });
    configured = true;
    lost.signal.throwIfAborted();
    signal.throwIfAborted();
    heartbeat = setInterval(() => {
      if (inFlight || lost.signal.aborted) return;
      inFlight = client.query('select 1').then(() => {}, onError).finally(() => { inFlight = undefined; });
    }, 5000);
    heartbeat.unref();
    const value = await action({
      owner: Object.freeze({ token, signal: lost.signal }), client, identity: { pid: row.pid, backendStart: row.backend_start },
      markUnresolved() { lost.signal.throwIfAborted(); unresolved = true; },
      markSettled() { lost.signal.throwIfAborted(); unresolved = false; },
      invalidate() {
        onError();
        if (!released) { released = true; client.release(true); }
      },
    });
    lost.signal.throwIfAborted();
    succeeded = true;
    return value;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (inFlight && !lost.signal.aborted && !unresolved) {
      // A healthy session must wait before reset/reuse, but loss while waiting
      // makes the query unsafe to await. Its rejection handler remains attached.
      await new Promise<void>((resolve) => {
        const done = () => { lost.signal.removeEventListener('abort', done); resolve(); };
        lost.signal.addEventListener('abort', done, { once: true });
        if (lost.signal.aborted) done();
        else void inFlight!.then(done);
      });
    }
    try {
      if (!lost.signal.aborted && !unresolved && configured) await client.query('reset application_name');
    } catch { onError(); }
    try { if (!released) client.release(lost.signal.aborted || unresolved); }
    finally { client.removeListener('error', onError); }
    if (succeeded) lost.signal.throwIfAborted();
  }
}
