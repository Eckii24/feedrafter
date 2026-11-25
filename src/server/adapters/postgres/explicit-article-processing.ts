import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { prepareArticle, type ArticleQualityClassifier, type ArticleExtractionFallback } from '../../application/prepare-article.js';
import type { PublicWeb } from '../../ports/public-web.js';
import type { SourceFallbackPermission } from '../../ports/source-fallback-permission.js';
import { ArticleJobs } from './article-jobs.js';
import type { Database } from './client.js';
import { ContentStore } from './content-store.js';
import { articleContents, articles, processingTasks } from './schema/index.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ARTICLES = 20;

/** Explicit, first-time processing only. Does not provision queues, register workers, or recover tasks. */
type Dependencies = {
  db: Database; boss: PgBoss; web: PublicWeb; classifier: ArticleQualityClassifier;
  fallback?: ArticleExtractionFallback; permission?: SourceFallbackPermission;
};
export async function processExplicitArticles(deps: Dependencies, articleIds: readonly string[], signal?: AbortSignal) {
  return processArticles(deps, articleIds, signal);
}

/** User-authorized retry only. A previous failed task may already have dispatched an AI call;
 * this starts a new call through the supplied classifier and its normal usage admission. */
export async function retryFailedPreparation(deps: Dependencies, attempts: readonly { articleId: string; failedTaskId: string }[], signal?: AbortSignal) {
  if (!Array.isArray(attempts) || attempts.length < 1 || attempts.length > MAX_ARTICLES ||
      attempts.some(item => !item || typeof item.articleId !== 'string' || !uuid.test(item.articleId) ||
        typeof item.failedTaskId !== 'string' || !uuid.test(item.failedTaskId))) throw new Error('Expected 1–20 distinct article IDs and failed task IDs');
  const snapshot = attempts.map(item => ({ articleId: item.articleId.toLowerCase(), failedTaskId: item.failedTaskId.toLowerCase() }));
  if (new Set(snapshot.map(item => item.articleId)).size !== snapshot.length) throw new Error('Expected 1–20 distinct article IDs and failed task IDs');
  return processArticles(deps, snapshot.map(item => item.articleId), signal, new Map(snapshot.map(item => [item.articleId, item.failedTaskId])));
}

async function processArticles(deps: Dependencies, articleIds: readonly string[], signal?: AbortSignal, retry?: ReadonlyMap<string, string>) {
  if (!Array.isArray(articleIds)) throw new Error('Expected 1–20 distinct article IDs');
  const snapshot = [...articleIds];
  if (snapshot.length < 1 || snapshot.length > MAX_ARTICLES || snapshot.some(id => typeof id !== 'string' || !uuid.test(id))) {
    throw new Error('Expected 1–20 distinct article IDs');
  }
  const ids = snapshot.map(id => id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new Error('Expected 1–20 distinct article IDs');
  const content = new ContentStore(deps.db);
  const jobs = new ArticleJobs(deps.db, deps.boss);
  const results: Array<
    | { articleId: string; kind: 'not_found' | 'ineligible' | 'already_started' }
    | { articleId: string; kind: 'failed' | 'stale'; prepareTaskId: string }
    | { articleId: string; kind: 'admission'; prepareTaskId: string; admission: Awaited<ReturnType<ArticleJobs['admitFirstPreparedArticle']>> }
  > = [];
  for (const articleId of ids) {
    signal?.throwIfAborted();
    const token = randomUUID();
    const started = await deps.db.transaction(async tx => {
      const [article] = await tx.select().from(articles).where(eq(articles.id, articleId)).for('update');
      if (!article) return { kind: 'not_found' as const };
      if (!['article', 'video'].includes(article.kind) || !article.url) return { kind: 'ineligible' as const };
      const history = await tx.select().from(processingTasks).where(eq(processingTasks.articleId, articleId)).orderBy(processingTasks.id).for('update');
      const [existingContent] = await tx.select({ articleId: articleContents.articleId }).from(articleContents).where(eq(articleContents.articleId, articleId)).for('share');
      if (article.contentRevision !== 0 || existingContent) return { kind: 'already_started' as const };
      let generation = 1;
      let result: Record<string, unknown> | undefined;
      if (retry) {
        const prior = history.filter(task => task.action === 'prepare').sort((a, b) => b.generation - a.generation);
        const last = prior[0];
        if (!last || last.id !== retry.get(articleId) || prior.some(task => task.state !== 'failed' || !task.endedAt || task.generation < 1) ||
            new Set(prior.map(task => task.generation)).size !== prior.length ||
            history.some(task => ['category', 'tags', 'scores'].includes(task.action) ||
              ['waiting_dependency', 'queued', 'running', 'retry_wait', 'paused_budget', 'paused_auth', 'needs_input'].includes(task.state))) return { kind: 'already_started' as const };
        if (last.generation >= 2147483647) throw new RangeError('Task generation overflow');
        generation = last.generation + 1;
        result = { explicitPreparationRetry: { version: 1, previousTaskId: last.id } };
      } else if (history.some(task => ['prepare', 'category', 'tags', 'scores'].includes(task.action))) return { kind: 'already_started' as const };
      const at = new Date();
      const [task] = await tx.insert(processingTasks).values({ articleId, action: 'prepare', generation, state: 'running',
        executionToken: token, attemptCount: 1, ...(result ? { result } : {}), createdAt: at, updatedAt: at, startedAt: at }).returning({ id: processingTasks.id });
      if (!task) throw new Error('Preparation task creation failed');
      return { kind: 'started' as const, taskId: task.id, url: article.url, revision: article.contentRevision, generation };
    }, { isolationLevel: 'read committed' });
    if (started.kind !== 'started') { results.push({ articleId, kind: started.kind }); continue; }
    const prepared = await prepareArticle({ web: deps.web, classifier: deps.classifier, content,
      ...(deps.fallback ? { fallback: deps.fallback } : {}), ...(deps.permission ? { permission: deps.permission } : {}) }, {
      context: { articleId, taskId: started.taskId, action: 'prepare', generation: started.generation, executionToken: token, expectedContentRevision: started.revision },
      originalUrl: started.url, ...(signal ? { signal } : {}),
    });
    if (prepared.status !== 'succeeded') {
      results.push({ articleId, kind: prepared.status, prepareTaskId: started.taskId });
      signal?.throwIfAborted();
      continue;
    }
    signal?.throwIfAborted();
    // Admission owns its task/queue transaction. Never retry an ambiguous failure here.
    const admission = await jobs.admitFirstPreparedArticle(articleId, started.taskId, new Date());
    results.push({ articleId, kind: 'admission', prepareTaskId: started.taskId, admission });
  }
  return results;
}
