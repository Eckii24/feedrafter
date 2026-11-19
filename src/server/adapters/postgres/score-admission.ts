import { and, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import type { Database } from './client.js';
import { articles, catalogEpoch, processingTasks, scoreDefinitions } from './schema/index.js';

export const SCORE_QUEUE = 'score';
const unfinished = ['waiting_dependency', 'queued', 'running', 'retry_wait', 'paused_budget', 'paused_auth', 'needs_input'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Administrative provisioning only; no worker is registered here. */
export async function provisionScoreQueue(boss: PgBoss): Promise<void> {
  await boss.createQueue(SCORE_QUEUE);
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Enqueue a caller-owned task inside its existing transaction. The caller owns locking and task state. */
export async function enqueueScoreTask(tx: Transaction, boss: PgBoss, taskId: string) {
  const jobId = await boss.send(SCORE_QUEUE, { taskId }, {
    db: fromDrizzle(tx, sql), retryLimit: 0,
  });
  if (!jobId || !uuid.test(jobId)) throw new Error('Score job was not enqueued');
  const saved = await tx.update(processingTasks).set({ jobId }).where(eq(processingTasks.id, taskId)).returning();
  if (saved.length !== 1 || saved[0]?.jobId?.toLowerCase() !== jobId.toLowerCase()) throw new Error('Score job ID update failed');
  return saved[0];
}

export class ScoreAdmission {
  constructor(private readonly db: Database, private readonly boss: PgBoss) {}

  async admit(articleId: string, at = new Date()) {
    return this.db.transaction(async tx => {
      // Same order as ScoreStore.publishCandidate; catalog writers lock epoch exclusively.
      const [epoch] = await tx.select({ id: catalogEpoch.id }).from(catalogEpoch)
        .where(eq(catalogEpoch.id, 1)).for('share');
      if (!epoch) throw new Error('Missing catalog epoch');
      const targets = await tx.select({ id: scoreDefinitions.id }).from(scoreDefinitions)
        .where(and(eq(scoreDefinitions.active, true), isNull(scoreDefinitions.deletedAt)))
        .orderBy(scoreDefinitions.id).for('share');
      const [article] = await tx.select({ id: articles.id }).from(articles)
        .where(eq(articles.id, articleId)).for('update');
      if (!article) return { result: 'not_found' as const };
      if (!targets.length) return { result: 'ok' as const, tasks: [] };

      const targetIds = targets.map(target => target.id);
      // Separate statement after acquiring article lock: see prior committed admissions.
      const generations = await tx.select({ target: processingTasks.scoreTargetId, generation: max(processingTasks.generation) })
        .from(processingTasks).where(and(eq(processingTasks.articleId, articleId), eq(processingTasks.action, 'scores'),
          inArray(processingTasks.scoreTargetId, targetIds))).groupBy(processingTasks.scoreTargetId);
      const next = new Map(generations.map(row => [row.target, Number(row.generation) + 1]));
      if ([...next.values()].some(value => value > 2147483647)) throw new RangeError('Score task generation overflow');

      const filter = and(eq(processingTasks.articleId, articleId), eq(processingTasks.action, 'scores'),
        inArray(processingTasks.scoreTargetId, targetIds));
      const old = await tx.select({ id: processingTasks.id }).from(processingTasks).where(filter)
        .orderBy(processingTasks.id).for('update');
      if (old.length) await tx.update(processingTasks).set({ state: 'superseded', updatedAt: at, endedAt: at })
        .where(and(inArray(processingTasks.id, old.map(row => row.id)), inArray(processingTasks.state, unfinished)));

      const tasks: (typeof processingTasks.$inferSelect)[] = [];
      for (const target of targets) {
        const [task] = await tx.insert(processingTasks).values({ articleId, action: 'scores', scoreTargetId: target.id,
          generation: next.get(target.id) ?? 1, state: 'queued', createdAt: at, updatedAt: at }).returning();
        if (!task) throw new Error('Score task insert failed');
        tasks.push(await enqueueScoreTask(tx, this.boss, task.id));
      }
      return { result: 'ok' as const, tasks };
    }, { isolationLevel: 'read committed' });
  }
}
