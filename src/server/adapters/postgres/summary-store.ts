import { and, eq, gt } from 'drizzle-orm';
import { validSummaryString, validSummaryText, type ArticleSummary } from '../../../shared/summaries.js';
import type { SummaryCandidate } from '../../application/summarize-article.js';
import type { Database } from './client.js';
import { articleContents, articles, articleSummaries, processingTasks } from './schema/index.js';

export class SummaryStore {
  constructor(private readonly db: Database) {}

  async get(articleId: string): Promise<ArticleSummary | null> {
    const [summary] = await this.db.select().from(articleSummaries).where(eq(articleSummaries.articleId, articleId));
    return summary ?? null;
  }

  // One snapshot distinguishes a missing article from a missing or outdated summary.
  async getForReader(articleId: string) {
    const [row] = await this.db.select({ revision: articles.contentRevision, summary: articleSummaries })
      .from(articles).leftJoin(articleSummaries, eq(articles.id, articleSummaries.articleId))
      .where(eq(articles.id, articleId));
    if (!row) return null;
    if (!row.summary) return { status: 'missing' as const };
    const { text, contentRevision, limitation, completedAt } = row.summary;
    const status = contentRevision !== row.revision ? 'outdated' : limitation !== null ? 'limited' : 'current';
    return { status, text, contentRevision, limitation, completedAt: completedAt.toISOString() };
  }

  // Caller passes only completed candidates; failure never replaces a saved result.
  async publish(candidate: SummaryCandidate, at: Date): Promise<boolean> {
    if (!validSummaryText(candidate.text) || !(at instanceof Date) || !Number.isFinite(at.getTime()) ||
        typeof candidate.executionToken !== 'string' || !candidate.executionToken ||
        !Number.isInteger(candidate.generation) || candidate.generation < 0 || candidate.generation > 2147483647 ||
        !Number.isInteger(candidate.contentRevision) || candidate.contentRevision < 1 || candidate.contentRevision > 2147483647 ||
        (candidate.limitation !== null && (typeof candidate.limitation !== 'string' || !validSummaryString(candidate.limitation)))) throw new RangeError('invalid summary candidate');
    return this.db.transaction(async tx => {
      const [article] = await tx.select({ revision: articles.contentRevision }).from(articles).where(eq(articles.id, candidate.articleId)).for('update');
      if (!article || article.revision !== candidate.contentRevision) return false;
      const [task] = await tx.select().from(processingTasks).where(eq(processingTasks.id, candidate.taskId)).for('update');
      if (!task || task.articleId !== candidate.articleId || task.action !== 'summary' || task.state !== 'running' ||
          task.executionToken !== candidate.executionToken || task.generation !== candidate.generation) return false;
      const [newer] = await tx.select({ id: processingTasks.id }).from(processingTasks).where(and(
        eq(processingTasks.articleId, candidate.articleId), eq(processingTasks.action, 'summary'), gt(processingTasks.generation, candidate.generation),
      )).limit(1);
      if (newer) return false;
      const [content] = await tx.select({ revision: articleContents.revision, quality: articleContents.quality, limitation: articleContents.limitation }).from(articleContents).where(eq(articleContents.articleId, candidate.articleId));
      if (!content || content.revision !== candidate.contentRevision || content.quality !== 'usable' || content.limitation !== candidate.limitation) return false;
      const value = { text: candidate.text, contentRevision: candidate.contentRevision, limitation: candidate.limitation, completedAt: at };
      await tx.insert(articleSummaries).values({ articleId: candidate.articleId, ...value }).onConflictDoUpdate({ target: articleSummaries.articleId, set: value });
      return true;
    });
  }
}
