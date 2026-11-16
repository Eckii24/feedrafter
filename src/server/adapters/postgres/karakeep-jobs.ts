import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { validOriginalUrl } from '../karakeep/schemas.js';
import type { KarakeepPort } from '../../ports/karakeep.js';
import type { Database } from './client.js';
import { articles, processingTasks } from './schema/index.js';

export const KARAKEEP_QUEUE = 'karakeep';
const action = 'karakeep';

/** No second create is authorized by a repeated request, including after uncertainty. */
export class KarakeepJobs {
  constructor(private readonly db: Database, private readonly boss: PgBoss) {}

  async start(articleId: string) {
    return this.db.transaction(async tx => {
      const [article] = await tx.select({ id: articles.id, url: articles.url }).from(articles)
        .where(eq(articles.id, articleId)).for('update');
      if (!article) return { kind: 'not_found' as const };
      const [existing] = await tx.select().from(processingTasks).where(and(
        eq(processingTasks.articleId, articleId), eq(processingTasks.action, action),
      )).orderBy(processingTasks.createdAt, processingTasks.id).limit(1);
      if (existing) return { kind: 'task' as const, task: existing, reused: true };
      if (!article.url || article.url.length > 4000 || !validOriginalUrl(article.url)) return { kind: 'invalid_url' as const };
      const now = new Date();
      const [task] = await tx.insert(processingTasks).values({ articleId, action, state: 'queued', createdAt: now,
        updatedAt: now, result: { originalUrl: article.url } }).returning();
      const jobId = await this.boss.send(KARAKEEP_QUEUE, { taskId: task!.id }, {
        db: fromDrizzle(tx, sql), retryLimit: 0, expireInSeconds: 120, heartbeatSeconds: 30,
      });
      if (!jobId) throw new Error('Karakeep job was not enqueued');
      const [saved] = await tx.update(processingTasks).set({ jobId }).where(eq(processingTasks.id, task!.id)).returning();
      return { kind: 'task' as const, task: saved!, reused: false };
    });
  }
}

type AuthPause = { paused: boolean };

/** A running claim is a dispatch intent; only a definitive auth rejection permits resumption. */
export async function runKarakeep(db: Database, client: KarakeepPort, taskId: string, signal?: AbortSignal, auth: AuthPause = { paused: false }): Promise<void> {
  if (auth.paused) {
    await db.update(processingTasks).set({ state: 'paused_auth', errorCode: 'karakeep_auth', updatedAt: new Date() })
      .where(and(eq(processingTasks.id, taskId), eq(processingTasks.action, action), eq(processingTasks.state, 'queued')));
    return;
  }
  const token = randomUUID();
  const now = new Date();
  const [claimed] = await db.update(processingTasks).set({ state: 'running', executionToken: token,
    attemptCount: sql`${processingTasks.attemptCount} + 1`, startedAt: now, updatedAt: now })
    .where(and(eq(processingTasks.id, taskId), eq(processingTasks.action, action), eq(processingTasks.state, 'queued'))).returning();
  if (!claimed) return;
  const originalUrl = claimed.result?.originalUrl;
  let outcome: Awaited<ReturnType<KarakeepPort['create']>> = { kind: 'uncertain' };
  try {
    if (typeof originalUrl === 'string' && validOriginalUrl(originalUrl)) outcome = await client.create(originalUrl, signal);
  } catch { /* Once claimed, every failure is conservatively uncertain. */ }
  if (outcome.kind === 'auth_error') auth.paused = true;
  const succeeded = (outcome.kind === 'created' || outcome.kind === 'existing') && typeof originalUrl === 'string' && outcome.bookmark.url === originalUrl;
  await db.update(processingTasks).set({ state: outcome.kind === 'auth_error' ? 'paused_auth' : succeeded ? 'succeeded' : 'needs_input', executionToken: null,
    updatedAt: new Date(), endedAt: outcome.kind === 'auth_error' ? null : new Date(), errorCode: outcome.kind === 'auth_error' ? 'karakeep_auth' : succeeded ? null : 'karakeep_uncertain',
    result: succeeded && (outcome.kind === 'created' || outcome.kind === 'existing') ? { originalUrl, outcome: outcome.kind, bookmarkId: outcome.bookmark.id } : outcome.kind === 'auth_error' ? { originalUrl } : { originalUrl, outcome: 'uncertain' },
  }).where(and(eq(processingTasks.id, taskId), eq(processingTasks.action, action), eq(processingTasks.state, 'running'), eq(processingTasks.executionToken, token)));
}

/** Recover only jobs no longer live. Running intents may already have reached Karakeep. */
export async function recoverKarakeep(db: Database, boss: PgBoss): Promise<void> {
  await db.transaction(async tx => {
    const rows = await tx.execute<{ id: string; state: string; job_id: string | null }>(sql`
      select id, state, job_id from processing_tasks where action = ${action} and state in ('queued', 'running') for update`);
    for (const task of rows.rows) {
      const jobs = task.job_id ? await tx.execute<{ state: string }>(sql`select state from pgboss.job where id = ${task.job_id} and name = ${KARAKEEP_QUEUE}`) : { rows: [] };
      if (jobs.rows.some(job => ['created', 'retry', 'active'].includes(job.state))) continue;
      if (task.state === 'running') {
        await tx.execute(sql`update processing_tasks set state = 'needs_input', execution_token = null, error_code = 'karakeep_uncertain', updated_at = now(), ended_at = now(), result = coalesce(result, '{}'::jsonb) || '{"outcome":"uncertain"}'::jsonb where id = ${task.id}`);
      } else {
        const jobId = await boss.send(KARAKEEP_QUEUE, { taskId: task.id }, { db: fromDrizzle(tx, sql), retryLimit: 0, expireInSeconds: 120, heartbeatSeconds: 30 });
        if (!jobId) throw new Error('Karakeep recovery job was not enqueued');
        await tx.execute(sql`update processing_tasks set job_id = ${jobId}, updated_at = now() where id = ${task.id}`);
      }
    }
  });
}

/** Only startup may resume definitive auth failures or jobs never dispatched during a pause. */
async function resumePausedAuth(db: Database, boss: PgBoss): Promise<void> {
  await db.transaction(async tx => {
    const rows = await tx.execute<{ id: string }>(sql`select id from processing_tasks where action = ${action} and state = 'paused_auth' for update`);
    for (const task of rows.rows) {
      const jobId = await boss.send(KARAKEEP_QUEUE, { taskId: task.id }, { db: fromDrizzle(tx, sql), retryLimit: 0, expireInSeconds: 120, heartbeatSeconds: 30 });
      if (!jobId) throw new Error('Karakeep auth recovery job was not enqueued');
      await tx.execute(sql`update processing_tasks set state = 'queued', job_id = ${jobId}, error_code = null, updated_at = now() where id = ${task.id}`);
    }
  });
}

export async function startKarakeepWorker(db: Database, boss: PgBoss, client: KarakeepPort): Promise<KarakeepJobs> {
  await recoverKarakeep(db, boss);
  await resumePausedAuth(db, boss);
  const auth: AuthPause = { paused: false };
  // Serialize dispatches even if the queue worker is configured to overlap callbacks.
  let previous: Promise<void> = Promise.resolve();
  await boss.work<{ taskId: string }>(KARAKEEP_QUEUE, { heartbeatRefreshSeconds: 15 }, async ([job]) => {
    if (!job) return;
    const before = previous;
    let release!: () => void;
    previous = new Promise<void>(resolve => { release = resolve; });
    await before;
    try { await runKarakeep(db, client, job.data.taskId, job.signal, auth); } finally { release(); }
  });
  return new KarakeepJobs(db, boss);
}
