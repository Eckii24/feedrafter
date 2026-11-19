import { eq, and, gt } from "drizzle-orm";
import { isDeepStrictEqual } from 'node:util';
import { captureScoreHandoff } from './score-handoff.js';
import type { ScoreCandidate } from "../../application/process-context-chunks.js";
import { validateScore } from "../../domain/enrichment.js";
import type { Database } from "./client.js";
import { articleContents, articleScores, catalogEpoch, scoreDefinitions } from "./schema/enrichment.js";
import { articles } from "./schema/import.js";
import { processingTasks } from "./schema/processing.js";

export type SuccessfulScore = typeof articleScores.$inferInsert;

// Call only after a successful provider result. Failed attempts live in task state,
// never in this table. Stale or missing articles return false without changing a score.
export class ScoreStore {
  constructor(private readonly db: Database) {}

  async saveSuccessful(result: SuccessfulScore): Promise<boolean> {
    validateScore(result.value);
    if (![result.contentRevision, result.assignmentRevision].every(revision => Number.isInteger(revision) && revision >= 0 && revision <= 2147483647)) {
      throw new RangeError("invalid score basis revision");
    }
    return this.db.transaction(async tx => {
      // Lock article before score, matching content and assignment writers.
      const [article] = await tx.select({ contentRevision: articles.contentRevision, assignmentRevision: articles.assignmentRevision })
        .from(articles).where(eq(articles.id, result.articleId)).for("update");
      if (!article || article.contentRevision !== result.contentRevision || article.assignmentRevision !== result.assignmentRevision) return false;
      await tx.insert(articleScores).values(result).onConflictDoUpdate({
        target: [articleScores.articleId, articleScores.scoreId],
        set: {
          value: result.value,
          calculatedAt: result.calculatedAt,
          contentRevision: result.contentRevision,
          assignmentRevision: result.assignmentRevision,
          condensed: result.condensed ?? false,
          limited: result.limited ?? false,
        },
      });
      return true;
    });
  }

  // The caller must capture the epoch and request inputs coherently before dispatch.
  // Epoch -> definition -> article -> task matches merge and assignment lock ordering.
  // New generation creators must take the article lock before inserting a task.
  async publishCandidate(candidate: ScoreCandidate, at: Date): Promise<boolean> {
    const basis = candidate?.basis;
    const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    const revision = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647;
    if (!basis || ![basis.taskId, basis.executionToken, basis.articleId, basis.scoreId].every(uuid) ||
        ![basis.contentRevision, basis.assignmentRevision, basis.catalogEpoch, basis.generation].every(revision) ||
        basis.condensed !== false || basis.limited !== false || typeof candidate.value !== 'number' ||
        !Number.isFinite(candidate.value) || candidate.value < 0 || candidate.value > 100 ||
        !(at instanceof Date) || !Number.isFinite(at.getTime())) return false;
    return this.db.transaction(async tx => {
      const [epoch] = await tx.select().from(catalogEpoch).where(eq(catalogEpoch.id, 1)).for('share');
      if (!epoch || epoch.revision !== basis.catalogEpoch) return false;
      const [definition] = await tx.select().from(scoreDefinitions).where(eq(scoreDefinitions.id, basis.scoreId)).for('share');
      if (!definition || !definition.active || definition.deletedAt !== null) return false;
      const [article] = await tx.select().from(articles).where(eq(articles.id, basis.articleId)).for('update');
      if (!article || article.contentRevision !== basis.contentRevision || article.assignmentRevision !== basis.assignmentRevision) return false;
      const [task] = await tx.select().from(processingTasks).where(eq(processingTasks.id, basis.taskId)).for('update');
      if (!task || task.articleId !== article.id || task.action !== 'scores' || task.scoreTargetId !== definition.id ||
          task.state !== 'running' || task.executionToken !== basis.executionToken.toLowerCase() || task.generation !== basis.generation) return false;
      const handoff = await captureScoreHandoff(task, article, {
        task: async id => (await tx.select().from(processingTasks).where(eq(processingTasks.id, id)).for('share'))[0] ?? null,
        newer: async (articleId, action, generation) => !!(await tx.select({ id: processingTasks.id }).from(processingTasks).where(and(eq(processingTasks.articleId, articleId), eq(processingTasks.action, action), gt(processingTasks.generation, generation))).limit(1))[0],
        content: async articleId => (await tx.select({ text: articleContents.text, revision: articleContents.revision }).from(articleContents).where(eq(articleContents.articleId, articleId)).for('share'))[0] ?? null,
      });
      if (handoff.kind === 'root' ? basis.handoff !== undefined :
          handoff.kind !== 'linked' || !isDeepStrictEqual(basis.handoff, handoff.value)) return false;
      const [newer] = await tx.select({ id: processingTasks.id }).from(processingTasks).where(and(
        eq(processingTasks.articleId, article.id), eq(processingTasks.action, 'scores'), eq(processingTasks.scoreTargetId, definition.id),
        gt(processingTasks.generation, basis.generation),
      )).limit(1);
      if (newer) return false;
      const result = { value: candidate.value, calculatedAt: at, contentRevision: basis.contentRevision, assignmentRevision: basis.assignmentRevision, condensed: false, limited: false };
      await tx.insert(articleScores).values({ articleId: article.id, scoreId: definition.id, ...result }).onConflictDoUpdate({
        target: [articleScores.articleId, articleScores.scoreId], set: result,
      });
      await tx.update(processingTasks).set({ state: 'succeeded', errorCode: null, updatedAt: at, endedAt: at }).where(eq(processingTasks.id, task.id));
      return true;
    });
  }

  async get(articleId: string, scoreId: string) {
    const rows = await this.db.select().from(articleScores).where(and(eq(articleScores.articleId, articleId), eq(articleScores.scoreId, scoreId))).limit(1);
    return rows[0] ?? null;
  }
}
