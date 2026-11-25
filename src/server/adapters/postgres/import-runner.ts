import { and, inArray, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import type pg from 'pg';
import type { FreshRssPort } from '../../ports/freshrss.js';
import type { Database } from './client.js';
import { processingRuns } from './schema/index.js';
import { ImportJobs, IMPORT_QUEUE, runImport, WAKE_QUEUE } from './import-jobs.js';

/** Administrative setup only. Normal runtime must start with migrations disabled. */
export async function provisionImportQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(IMPORT_QUEUE);
  await boss.createQueue(WAKE_QUEUE);
}

/** Re-enqueue active runs only when no live pg-boss job references them. */
export async function recoverImports(db: Database, boss: PgBoss, contextIds?: readonly string[]): Promise<void> {
  if (contextIds?.length === 0) return;
  const rows = await db.select({ id: processingRuns.id }).from(processingRuns)
    .where(and(inArray(processingRuns.status, ['queued', 'running']), contextIds ? inArray(processingRuns.contextId, [...contextIds]) : undefined));
  for (const row of rows) {
    await db.transaction(async (tx) => {
      const locked = await tx.execute<{ id: string }>(sql`select id from processing_runs where id = ${row.id} and status in ('queued','running') for update`);
      if (!locked.rows.length) return;
      const jobs = await tx.execute<{ state: string }>(sql`select state from pgboss.job where name = ${IMPORT_QUEUE} and data->>'runId' = ${row.id} order by created_on desc`);
      if (jobs.rows.some((job) => ['created', 'retry', 'active'].includes(job.state))) return;
      if (jobs.rows[0]?.state === 'failed') {
        await tx.execute(sql`update processing_runs set status = 'failed', execution_owner = null, error_code = 'import_failed', ended_at = now() where id = ${row.id}`);
        return;
      }
      await tx.execute(sql`update processing_runs set status = 'queued', execution_owner = null where id = ${row.id}`);
      const { fromDrizzle } = await import('pg-boss');
      const id = await boss.send(IMPORT_QUEUE, { runId: row.id }, {
        db: fromDrizzle(tx, sql), retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 3600, heartbeatSeconds: 60,
      });
      if (!id) throw new Error('Recovery job was not enqueued');
    });
  }
}

export async function startImportWorkers(pool: pg.Pool, db: Database, boss: PgBoss,
  freshForContext: (contextId: string) => Promise<FreshRssPort>, contextIds?: readonly string[], automaticProcessing = false): Promise<ImportJobs> {
  const imports = new ImportJobs(db, boss);
  await recoverImports(db, boss, contextIds);
  await boss.work<{ runId: string }>(IMPORT_QUEUE, { localConcurrency: 2, heartbeatRefreshSeconds: 30 }, async ([job]) => {
    if (!job) return;
    const rows = await pool.query<{ context_id: string }>('select context_id from processing_runs where id=$1', [job.data.runId]);
    if (!rows.rows[0]) return;
    const contextId = rows.rows[0].context_id;
    await runImport(pool, job.data.runId, () => freshForContext(contextId), { lastAttempt: job.retryCount >= 2, signal: job.signal, automaticProcessing });
  });
  await boss.work(WAKE_QUEUE, async () => { await recoverImports(db, boss, contextIds); await imports.wakeDue(new Date(), contextIds); });
  await boss.schedule(WAKE_QUEUE, '* * * * *');
  await imports.wakeDue(new Date(), contextIds);
  return imports;
}
