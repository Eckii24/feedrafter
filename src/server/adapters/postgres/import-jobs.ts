import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import type pg from 'pg';
import { scanUnread } from '../../application/scan-unread.js';
import type { FreshRssPort } from '../../ports/freshrss.js';
import type { UnitOfWork } from '../../ports/unit-of-work.js';
import type { TaskQueue } from '../../ports/task-queue.js';
import type { Database } from './client.js';
import { ImportStore, type ImportTransaction } from './import-store.js';
import { TaskStore } from './task-store.js';
import { acknowledgements, appSettings, articles, importContexts, processingRuns } from './schema/index.js';
import * as schema from './schema/index.js';

export const IMPORT_QUEUE = 'import';
export const WAKE_QUEUE = 'import-wake';

class PgUnitOfWork implements UnitOfWork {
  readonly unitOfWork = 'unit-of-work' as const;
  constructor(readonly tx: ImportTransaction) {}
}

export class PgImportQueue implements TaskQueue {
  constructor(private readonly boss: PgBoss) {}
  async enqueueImport(unitOfWork: UnitOfWork, runId: string): Promise<void> {
    if (!(unitOfWork instanceof PgUnitOfWork)) throw new TypeError('Foreign unit of work');
    const id = await this.boss.send(IMPORT_QUEUE, { runId }, {
      db: fromDrizzle(unitOfWork.tx, sql), retryLimit: 2, retryDelay: 30, retryBackoff: true,
      expireInSeconds: 3600, heartbeatSeconds: 60,
    });
    if (!id) throw new Error('Import job was not enqueued');
  }
}

/** Context row lock serializes starts; the run and its job commit together. */
export class ImportJobs {
  private readonly queue: TaskQueue;
  constructor(private readonly db: Database, boss: PgBoss) { this.queue = new PgImportQueue(boss); }

  private async startInTransaction(tx: ImportTransaction, contextId: string, now: Date) {
    const [context] = await tx.select({ id: importContexts.id }).from(importContexts)
      .where(eq(importContexts.id, contextId)).for('update');
    if (!context) throw new Error('Import context not found');
    const [existing] = await tx.select().from(processingRuns).where(and(
      eq(processingRuns.contextId, contextId), inArray(processingRuns.status, ['queued', 'running']),
    ));
    if (existing) return { run: existing, reused: true };
    const [run] = await tx.insert(processingRuns).values({ contextId, startedAt: now }).returning();
    await this.queue.enqueueImport(new PgUnitOfWork(tx), run!.id);
    return { run: run!, reused: false };
  }

  async startImport(contextId: string, now = new Date()) {
    return this.db.transaction((tx) => this.startInTransaction(tx, contextId, now));
  }

  /** One elapsed-interval catch-up, irrespective of how long the process was stopped. */
  async wakeDue(now = new Date(), contextIds?: readonly string[]) {
    return this.db.transaction(async (tx) => {
      await tx.insert(appSettings).values({ id: 1 }).onConflictDoNothing();
      const [settings] = await tx.select().from(appSettings).where(eq(appSettings.id, 1)).for('update');
      if (!settings!.importEnabled || (settings!.nextImportAt && settings!.nextImportAt > now)) return 0;
      const contexts = contextIds?.length === 0 ? [] : await tx.select({ id: importContexts.id }).from(importContexts)
        .where(contextIds ? inArray(importContexts.id, [...contextIds]) : undefined).orderBy(importContexts.id);
      for (const context of contexts) await this.startInTransaction(tx, context.id, now);
      await tx.update(appSettings).set({ nextImportAt: new Date(now.getTime() + settings!.importIntervalSeconds * 1000) })
        .where(eq(appSettings.id, 1));
      return contexts.length;
    });
  }
}

/** The session holding the lock also executes every fenced write. */
export async function runImport(pool: pg.Pool, runId: string, freshSource: FreshRssPort | (() => Promise<FreshRssPort>), options: {
  lastAttempt: boolean; signal?: AbortSignal;
}): Promise<void> {
  const client = await pool.connect();
  const abort = new AbortController();
  const onError = () => abort.abort(new Error('Coordinator connection lost'));
  client.on('error', onError);
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(55 * 60_000), ...(options.signal ? [options.signal] : [])]);
  const db: Database = drizzle({ client, schema });
  const store = new ImportStore(db);
  const tasks = new TaskStore(db);
  const owner = randomUUID();
  let locked = false;
  let contextId: string | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    const initial = await tasks.getRun(runId);
    if (!initial || !['queued', 'running'].includes(initial.status)) return;
    contextId = initial.contextId;
    await client.query("select set_config('application_name', $1, false)", [`feedrafter-import:${runId}`]);
    const result = await client.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 18420)) as locked', [initial.contextId]);
    if (!result.rows[0]?.locked) throw new Error('Import coordinator busy');
    locked = true;
    // Detect lost idle connections while an HTTP request is in flight.
    heartbeat = setInterval(() => { void client.query('select 1').catch(onError); }, 5000);
    heartbeat.unref();
    const run = await tasks.claimCoordinatedRun(runId, owner);
    if (!run) return;
    const fresh = typeof freshSource === 'function' ? await freshSource() : freshSource;
    signal.throwIfAborted();
    const fence = async (tx: ImportTransaction, values: Partial<typeof processingRuns.$inferInsert>) => {
      signal.throwIfAborted();
      const rows = await tx.update(processingRuns).set(values).where(and(eq(processingRuns.id, runId),
        eq(processingRuns.executionOwner, owner), eq(processingRuns.status, 'running'))).returning({ id: processingRuns.id });
      if (!rows.length) throw new Error('Import ownership lost');
    };
    if (run.phase === 'fetch') {
      // A retry starts at page one. Previously saved identities and intents deduplicate.
      await db.transaction((tx) => fence(tx, { fetchedCount: 0 }));
      let fetched = 0;
      await scanUnread(fresh, async (items) => {
        await db.transaction(async (tx) => {
          await fence(tx, { fetchedCount: fetched + items.length });
          await store.importPageInTransaction(tx, run.contextId, items, new Date());
        });
        fetched += items.length;
      }, signal);
      await db.transaction(async (tx) => {
        await fence(tx, { phase: 'ack', fetchedCount: fetched });
        await tx.update(acknowledgements).set({ eligible: true }).where(and(
          eq(acknowledgements.contextId, run.contextId), eq(acknowledgements.status, 'pending')));
      });
    }
    // Reconcile all durable intents, not just IDs observed on this scan. Each intent
    // gets at most one attempt per run; failures remain visible for a later run.
    const pending = await store.pendingAcknowledgements(run.contextId);
    let confirmed = run.confirmedCount;
    for (const item of pending) {
      signal.throwIfAborted();
      const id = item.freshrssId;
      try {
        await db.transaction(async (tx) => {
          await fence(tx, { confirmedCount: confirmed });
          await tx.update(acknowledgements).set({ attempts: sql`${acknowledgements.attempts} + 1`, lastAttemptAt: new Date(), diagnostic: null })
            .where(and(eq(acknowledgements.id, item.acknowledgement.id), eq(acknowledgements.status, 'pending')));
        });
        const states = await fresh.getReadState([id], signal);
        signal.throwIfAborted();
        if (!states.has(id)) throw new Error('Unknown read state');
        if (!states.get(id)) await fresh.markRead([id], signal);
        signal.throwIfAborted();
        await db.transaction(async (tx) => {
          await fence(tx, { confirmedCount: confirmed + 1 });
          await tx.update(acknowledgements).set({ status: 'confirmed', confirmedAt: new Date(), diagnostic: null })
            .where(and(eq(acknowledgements.id, item.acknowledgement.id), eq(acknowledgements.status, 'pending')));
        });
        confirmed++;
      } catch {
        signal.throwIfAborted();
        await db.transaction(async (tx) => {
          await fence(tx, { confirmedCount: confirmed });
          await tx.update(acknowledgements).set({ diagnostic: 'acknowledgement_unconfirmed' })
            .where(and(eq(acknowledgements.id, item.acknowledgement.id), eq(acknowledgements.status, 'pending')));
        });
      }
    }
    await db.transaction(async (tx) => {
      const remaining = await tx.select({ id: acknowledgements.id }).from(acknowledgements)
        .innerJoin(articles, eq(articles.id, acknowledgements.articleId))
        .where(and(eq(acknowledgements.contextId, run.contextId), eq(acknowledgements.status, 'pending')));
      await fence(tx, { status: 'succeeded', phase: 'complete', pendingCount: remaining.length,
        confirmedCount: confirmed, endedAt: new Date(), errorCode: remaining.length ? 'acknowledgement_pending' : null });
    });
  } catch (error) {
    if (locked && !signal.aborted) {
      const allPending = await db.select({ id: acknowledgements.id }).from(acknowledgements).where(and(
        eq(acknowledgements.contextId, contextId!), eq(acknowledgements.status, 'pending')));
      await db.update(processingRuns).set({ status: options.lastAttempt ? 'failed' : 'queued',
        pendingCount: allPending.length,
        executionOwner: null, errorCode: 'import_failed', endedAt: options.lastAttempt ? new Date() : null })
        .where(and(eq(processingRuns.id, runId), eq(processingRuns.executionOwner, owner), eq(processingRuns.status, 'running')));
    }
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try {
      if (locked) await client.query('select pg_advisory_unlock(hashtextextended($1, 18420))', [contextId]);
      await client.query('reset application_name');
    } catch { abort.abort(); }
    client.removeListener('error', onError);
    client.release(abort.signal.aborted);
  }
}
