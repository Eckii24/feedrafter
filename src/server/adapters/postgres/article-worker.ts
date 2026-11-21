import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { runStoredCategoryTask } from '../../application/run-stored-category-task.js';
import { runStoredTagTask } from '../../application/run-stored-tag-task.js';
import type { RequestModel } from '../../application/score-context-request.js';
import type { AiPort } from '../../ports/ai.js';
import { ArticleJobs } from './article-jobs.js';
import { CategoryTaskInputStore } from './category-task-input-store.js';
import type { Database } from './client.js';
import { TagTaskInputStore } from './tag-task-input-store.js';
import { TaskStore } from './task-store.js';

const CATEGORY_QUEUE = 'category';
const TAGS_QUEUE = 'tags';

/** Administrative provisioning only. */
export async function provisionArticleQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(CATEGORY_QUEUE);
  await boss.createQueue(TAGS_QUEUE);
}

/** Register only; caller owns provisioning and boss lifecycle. */
export async function startArticleWorkers({ db, pool, boss, ai, resolveCategoryModel, resolveTagModel }: {
  db: Database; pool: pg.Pool; boss: PgBoss; ai: AiPort;
  resolveCategoryModel: () => Promise<RequestModel | null>;
  resolveTagModel: () => Promise<RequestModel | null>;
}): Promise<{ close(): Promise<void> }> {
  const tasks = new TaskStore(db);
  const catalog = new ArticleJobs(db, boss);
  const categoryInputs = new CategoryTaskInputStore(pool);
  const tagInputs = new TagTaskInputStore(pool);
  const categoryId = await boss.work<{ taskId: string }>(CATEGORY_QUEUE, { batchSize: 1, localConcurrency: 1 }, async ([job]) => {
    if (job) await runStoredCategoryTask(job.data.taskId, { tasks, catalog, inputs: categoryInputs, ai, model: resolveCategoryModel, signal: job.signal });
  });
  let tagId: string;
  try {
    tagId = await boss.work<{ taskId: string }>(TAGS_QUEUE, { batchSize: 1, localConcurrency: 1 }, async ([job]) => {
      if (job) await runStoredTagTask(job.data.taskId, { tasks, catalog, inputs: tagInputs, ai, model: resolveTagModel, signal: job.signal });
    });
  } catch (error) {
    await boss.offWork(CATEGORY_QUEUE, { id: categoryId, wait: true });
    throw error;
  }
  return { async close() {
    await Promise.all([
      boss.offWork(CATEGORY_QUEUE, { id: categoryId, wait: true }),
      boss.offWork(TAGS_QUEUE, { id: tagId, wait: true }),
    ]);
  } };
}
