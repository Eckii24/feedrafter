import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { runStoredScoreTask } from '../../application/run-stored-score-task.js';
import type { AiPort } from '../../ports/ai.js';
import type { Database } from './client.js';
import { SCORE_QUEUE } from './score-admission.js';
import { ScoreStore } from './score-store.js';
import { ScoreTaskInputStore, type ScoreTaskModels } from './score-task-input-store.js';
import { TaskStore } from './task-store.js';
import { ContextStore } from './context-store.js';

export type ScoreWorkerDependencies = {
  db: Database;
  pool: pg.Pool;
  boss: PgBoss;
  ai: AiPort;
  resolveModels: () => Promise<ScoreTaskModels | null>;
};

/** Register only; the caller owns queue provisioning and the boss lifecycle. */
export async function startScoreWorker({ db, pool, boss, ai, resolveModels }: ScoreWorkerDependencies): Promise<{ close(): Promise<void> }> {
  const inputs = new ScoreTaskInputStore(pool);
  const scores = new ScoreStore(db);
  const tasks = new TaskStore(db);
  const context = new ContextStore(db);
  const id = await boss.work<{ taskId: string }>(SCORE_QUEUE, { batchSize: 1, localConcurrency: 1 }, async ([job]) => {
    if (!job) return;
    // All returned task outcomes, including obsolete deliveries and pauses, are
    // queue success. Only infrastructure errors escape; admission disables retries.
    await runStoredScoreTask(job.data.taskId, { ai, inputs, scores, tasks, context, models: resolveModels, signal: job.signal });
  });
  return { close: () => boss.offWork(SCORE_QUEUE, { id, wait: true }) };
}
