import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import type pg from 'pg';
import { scanUnread } from '../../application/scan-unread.js';
import { prepareArticle, type ArticleQualityClassifier } from '../../application/prepare-article.js';
import { QualityClassifierPause } from '../../application/classify-article-quality.js';
import type { PublicWeb } from '../../ports/public-web.js';
import { ArticleJobs } from './article-jobs.js';
import { ContentStore } from './content-store.js';
import type { FreshRssPort } from '../../ports/freshrss.js';
import type { UnitOfWork } from '../../ports/unit-of-work.js';
import type { TaskQueue } from '../../ports/task-queue.js';
import type { Database } from './client.js';
import { ImportStore, type ImportTransaction } from './import-store.js';
import { TaskStore } from './task-store.js';
import { acknowledgements, appSettings, articles, importContexts, processingRuns, processingTasks } from './schema/index.js';
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

/** Call only under exclusive ownership, after queue preflight and before starting the worker. */
export async function recoverInterruptedAutomaticImports(db: Database): Promise<number> {
  const rows = await db.execute(sql`update processing_tasks set state='failed', error_code='interrupted', updated_at=now(), ended_at=now()
    where action='prepare' and state='running' and (result = '{"automaticImport":{"version":1}}'::jsonb
      or result is null or result = '{}'::jsonb or result->'explicitPreparationRetry'->>'version' = '1') returning id`);
  const missing = await db.execute(sql`update processing_tasks t set error_code='admission_interrupted', updated_at=now()
    where t.action='prepare' and t.state='succeeded' and t.error_code is null
    and (t.result->'automaticImport' = '{"version":1}'::jsonb or t.result ? 'preparationReceipt')
    and not exists(select 1 from processing_tasks c where c.article_id=t.article_id and c.action='category') returning id`);
  return rows.rows.length + missing.rows.length;
}

type AutomaticDependencies = { db: Database; pool: pg.Pool; boss: PgBoss; web: PublicWeb; classifier: ArticleQualityClassifier };

/** Caller must have completed the local inference queue preflight and own the database exclusively. */
export async function startAutomaticImportProcessing(deps: AutomaticDependencies): Promise<{ close(): Promise<void> }> {
  const interruptedCount = await recoverInterruptedAutomaticImports(deps.db);
  if (interruptedCount) console.error(`Automatic processing: ${interruptedCount} interrupted task(s); inspect persisted tasks`);
  const controller = new AbortController();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  const tick = () => {
    if (stopped) return;
    active = (async () => {
      try { while (!stopped && await processAutomaticImportsOnce(deps, controller.signal)) { /* drain serially */ } }
      catch { if (!stopped) console.error('Automatic import processing failed; inspect persisted tasks'); }
      finally { if (!stopped) { timer = setTimeout(tick, 5000); timer.unref(); } }
    })();
  };
  tick();
  return { async close() { stopped = true; if (timer) clearTimeout(timer); controller.abort(); await active; } };
}

export async function processAutomaticImportsOnce(deps: AutomaticDependencies, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const token = randomUUID();
  const claimed = await deps.db.transaction(async tx => {
    // Serialize claim decisions across callers; a running automatic preparation
    // owns the single slot until it is durably settled or startup recovery runs.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('feedrafter-automatic-prepare', 18420))`);
    const running = await tx.execute(sql`select id from processing_tasks where action='prepare' and state='running'
      and result = '{"automaticImport":{"version":1}}'::jsonb limit 1`);
    if (running.rows.length) return null;
    // Failed requests may already have reached the provider. Never retry them;
    // limit subsequent fresh probes to one per cooldown while the outage persists.
    const recentFailure = await tx.execute(sql`select id from processing_tasks where action='prepare' and state='failed'
      and error_code='quality_provider_failed' and result->'automaticImport' = '{"version":1}'::jsonb
      and updated_at > now() - interval '5 minutes' limit 1`);
    if (recentFailure.rows.length) return null;
    // A capacity pause gates the entire automatic backlog. Probe only one paused
    // item every five minutes, instead of fetching and failing the whole burst.
    const paused = await tx.execute<{ id: string; due: boolean }>(sql`select id, updated_at <= now() - interval '5 minutes' as due
      from processing_tasks where action='prepare' and state in ('paused_budget','paused_auth','needs_input')
      and result = '{"automaticImport":{"version":1}}'::jsonb order by updated_at, id limit 1`);
    if (paused.rows[0] && !paused.rows[0].due) return null;
    const pausedId = paused.rows[0]?.id ?? null;
    const result = await tx.execute<{ id: string; article_id: string; url: string | null; kind: string; content_revision: number }>(sql`
      select t.id, a.id as article_id, a.url, a.kind, a.content_revision from processing_tasks t
      join articles a on a.id=t.article_id where t.action='prepare'
      and ((${pausedId}::uuid is null and t.state='queued') or (t.id=${pausedId}::uuid and t.state in ('paused_budget','paused_auth','needs_input')))
      and t.result = '{"automaticImport":{"version":1}}'::jsonb
      order by t.created_at, t.id limit 1 for update of a, t skip locked`);
    const row = result.rows[0];
    if (!row) return null;
    if (!['article', 'video'].includes(row.kind) || !row.url) {
      await tx.update(processingTasks).set({ state: 'failed', errorCode: 'processing_ineligible', updatedAt: new Date(), endedAt: new Date() }).where(eq(processingTasks.id, row.id));
      return { ...row, conflict: true };
    }
    const conflicting = await tx.execute(sql`select id from processing_tasks where article_id=${row.article_id} and id<>${row.id}
      and action in ('prepare','category','tags','scores') limit 1`);
    if (row.content_revision !== 0 || conflicting.rows.length) {
      await tx.update(processingTasks).set({ state: 'failed', errorCode: 'processing_conflict', updatedAt: new Date(), endedAt: new Date() }).where(eq(processingTasks.id, row.id));
      return { ...row, conflict: true };
    }
    const [claimed] = await tx.update(processingTasks).set({ state: 'running', executionToken: token, attemptCount: sql`${processingTasks.attemptCount} + 1`, errorCode: null, startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(processingTasks.id, row.id), inArray(processingTasks.state, ['queued', 'paused_budget', 'paused_auth', 'needs_input']))).returning({ id: processingTasks.id });
    return claimed ? { ...row, url: row.url } : null;
  });
  if (!claimed) return false;
  if ('conflict' in claimed) return true;
  let prepared: Awaited<ReturnType<typeof prepareArticle>>;
  try {
    prepared = await prepareArticle({ web: deps.web, classifier: deps.classifier, content: new ContentStore(deps.db) }, {
      context: { articleId: claimed.article_id, taskId: claimed.id, action: 'prepare', generation: 1, executionToken: token, expectedContentRevision: claimed.content_revision },
      originalUrl: claimed.url, allowPreDispatchPause: true, ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (!(error instanceof QualityClassifierPause)) {
      // Publication may have committed. Fence by execution token and never re-run
      // the model; preserve a committed success while flagging missing handoff.
      await deps.db.update(processingTasks).set({
        state: sql`case when ${processingTasks.state} = 'running' then 'failed' else ${processingTasks.state} end`,
        errorCode: 'publication_unknown', updatedAt: new Date(), endedAt: new Date(),
      }).where(and(eq(processingTasks.id, claimed.id), eq(processingTasks.executionToken, token), inArray(processingTasks.state, ['running', 'succeeded'])));
      throw error;
    }
    await deps.db.update(processingTasks).set({ state: error.kind === 'paused_configuration' ? 'needs_input' : error.kind,
      errorCode: error.reason, executionToken: null, updatedAt: new Date() })
      .where(and(eq(processingTasks.id, claimed.id), eq(processingTasks.state, 'running'), eq(processingTasks.executionToken, token)));
    return false;
  }
  if (prepared.status === 'stale') {
    const at = new Date();
    await deps.db.update(processingTasks).set({ state: 'superseded', errorCode: 'stale_basis', updatedAt: at, endedAt: at })
      .where(and(eq(processingTasks.id, claimed.id), eq(processingTasks.articleId, claimed.article_id), eq(processingTasks.action, 'prepare'), eq(processingTasks.state, 'running'), eq(processingTasks.executionToken, token)));
  }
  if (prepared.status === 'succeeded') {
    try {
      const admission = await new ArticleJobs(deps.db, deps.boss).admitFirstPreparedArticle(claimed.article_id, claimed.id, new Date());
      if (admission.kind !== 'admitted') await deps.db.update(processingTasks).set({ errorCode: 'admission_' + admission.kind, updatedAt: new Date() })
        .where(and(eq(processingTasks.id, claimed.id), eq(processingTasks.state, 'succeeded'), eq(processingTasks.executionToken, token)));
    } catch (error) {
      // The task/queue transaction may have committed despite an ambiguous error; do not retry it.
      await deps.db.update(processingTasks).set({ errorCode: 'admission_unknown', updatedAt: new Date() })
        .where(and(eq(processingTasks.id, claimed.id), eq(processingTasks.state, 'succeeded'), eq(processingTasks.executionToken, token)));
      throw error;
    }
  }
  return true;
}

/** The session holding the lock also executes every fenced write. */
export async function runImport(pool: pg.Pool, runId: string, freshSource: FreshRssPort | (() => Promise<FreshRssPort>), options: {
  lastAttempt: boolean; signal?: AbortSignal; automaticProcessing?: boolean;
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
          const at = new Date();
          const imported = await store.importPageWithIdentitiesInTransaction(tx, run.contextId, items, at);
          if (options.automaticProcessing) {
            for (const item of imported.filter(item => item.inserted)) {
              const [article] = await tx.select({ kind: articles.kind, url: articles.url }).from(articles).where(eq(articles.id, item.id));
              if (article && ['article', 'video'].includes(article.kind) && article.url) await tx.insert(processingTasks).values({ articleId: item.id, action: 'prepare', generation: 1,
                state: 'queued', result: { automaticImport: { version: 1 } }, createdAt: at, updatedAt: at });
            }
          }
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
