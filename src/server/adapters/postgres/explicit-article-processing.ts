import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { prepareArticle, type ArticleQualityClassifier, type ArticleExtractionFallback } from '../../application/prepare-article.js';
import type { PublicWeb } from '../../ports/public-web.js';
import type { SourceFallbackPermission } from '../../ports/source-fallback-permission.js';
import { ArticleJobs } from './article-jobs.js';
import type { Database } from './client.js';
import { ContentStore } from './content-store.js';
import { articles, processingTasks } from './schema/index.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ARTICLES = 20;

/** Explicit, first-time processing only. Does not provision queues, register workers, or recover tasks. */
export async function processExplicitArticles(deps: {
  db: Database; boss: PgBoss; web: PublicWeb; classifier: ArticleQualityClassifier;
  fallback?: ArticleExtractionFallback; permission?: SourceFallbackPermission;
}, articleIds: readonly string[], signal?: AbortSignal) {
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
      if (article.kind !== 'article' || !article.url) return { kind: 'ineligible' as const };
      // No implicit retries, refreshes, or takeover of pre-existing processing.
      const [existing] = await tx.select({ id: processingTasks.id }).from(processingTasks).where(and(
        eq(processingTasks.articleId, articleId), inArray(processingTasks.action, ['prepare', 'category', 'tags', 'scores']),
      )).limit(1);
      if (existing || article.contentRevision !== 0) return { kind: 'already_started' as const };
      const at = new Date();
      const [task] = await tx.insert(processingTasks).values({ articleId, action: 'prepare', generation: 1, state: 'running',
        executionToken: token, attemptCount: 1, createdAt: at, updatedAt: at, startedAt: at }).returning({ id: processingTasks.id });
      if (!task) throw new Error('Preparation task creation failed');
      return { kind: 'started' as const, taskId: task.id, url: article.url, revision: article.contentRevision };
    }, { isolationLevel: 'read committed' });
    if (started.kind !== 'started') { results.push({ articleId, kind: started.kind }); continue; }
    const prepared = await prepareArticle({ web: deps.web, classifier: deps.classifier, content,
      ...(deps.fallback ? { fallback: deps.fallback } : {}), ...(deps.permission ? { permission: deps.permission } : {}) }, {
      context: { articleId, taskId: started.taskId, action: 'prepare', generation: 1, executionToken: token, expectedContentRevision: started.revision },
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
