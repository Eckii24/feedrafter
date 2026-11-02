import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { articleContents, contentChunks, chunkResults } from "./schema/enrichment.js";
import { articles } from "./schema/import.js";
import { processingTasks } from "./schema/processing.js";

type Content = Omit<typeof articleContents.$inferInsert, "articleId" | "revision">;
export type ContentExecutionContext = {
  taskId: string;
  articleId: string;
  action: "prepare";
  generation: number;
  executionToken: string;
  expectedContentRevision: number;
};

function validateContent(content: Content) {
  if (typeof content.text !== "string" || !content.text.trim() || typeof content.quality !== "string" || !content.quality.trim() ||
      !(content.capturedAt instanceof Date) || !Number.isFinite(content.capturedAt.getTime()) ||
      [content.sourceUrl, content.limitation, content.failureCode].some(value => value != null && typeof value !== "string")) {
    throw new Error("invalid content");
  }
}

// Persist only a successful refresh. An extraction failure belongs in task state
// and must not remove the previous full text or advance its revision.
export class ContentStore {
  constructor(private readonly db: Database) {}

  async get(articleId: string) {
    const [row] = await this.db.select().from(articleContents).where(eq(articleContents.articleId, articleId));
    return row ?? null;
  }

  async saveChunk(chunk: typeof contentChunks.$inferInsert) {
    const [row] = await this.db.insert(contentChunks).values(chunk).returning();
    return row!;
  }

  listChunks(articleId: string, revision: number) {
    return this.db.select().from(contentChunks).where(and(eq(contentChunks.articleId, articleId), eq(contentChunks.contentRevision, revision))).orderBy(contentChunks.ordinal);
  }

  async saveChunkResult(result: typeof chunkResults.$inferInsert) {
    const [row] = await this.db.insert(chunkResults).values(result).onConflictDoUpdate({
      target: [chunkResults.chunkId, chunkResults.generation, chunkResults.purpose],
      set: { result: result.result, completedAt: result.completedAt },
    }).returning();
    return row!;
  }

  listChunkResults(chunkId: string) { return this.db.select().from(chunkResults).where(eq(chunkResults.chunkId, chunkId)); }

  // Stale executions return null. All task publications use article -> task lock order.
  async publishTask(context: ContentExecutionContext, outcome: { kind: "success"; content: Content; at: Date } | { kind: "failure"; errorCode: string; at: Date }): Promise<number | null> {
    if (outcome.kind === "success") validateContent(outcome.content);
    if (outcome.kind === "failure" && (typeof outcome.errorCode !== "string" || !outcome.errorCode.trim())) throw new Error("invalid error code");
    if (!(outcome.at instanceof Date) || !Number.isFinite(outcome.at.getTime())) throw new Error("invalid timestamp");
    return this.db.transaction(async tx => {
      const [article] = await tx.select({ revision: articles.contentRevision }).from(articles).where(eq(articles.id, context.articleId)).for("update");
      if (!article || article.revision !== context.expectedContentRevision || context.action !== "prepare") return null;
      const [task] = await tx.select().from(processingTasks).where(eq(processingTasks.id, context.taskId)).for("update");
      if (!task || typeof context.executionToken !== "string" || !context.executionToken || task.articleId !== context.articleId ||
          task.action !== context.action || task.generation !== context.generation || task.state !== "running" ||
          task.executionToken !== context.executionToken) return null;
      // Include terminal tasks: a failed newer generation still supersedes this one.
      const [newer] = await tx.select({ id: processingTasks.id }).from(processingTasks).where(and(
        eq(processingTasks.articleId, context.articleId), eq(processingTasks.action, context.action), gt(processingTasks.generation, context.generation),
      )).limit(1);
      if (newer) return null;
      if (outcome.kind === "failure") {
        await tx.update(processingTasks).set({ state: "failed", errorCode: outcome.errorCode, updatedAt: outcome.at, endedAt: outcome.at }).where(eq(processingTasks.id, task.id));
        return article.revision;
      }
      const revision = article.revision + 1;
      const { text, quality, capturedAt, sourceUrl, limitation, failureCode } = outcome.content;
      const replacement = { text, quality, capturedAt, sourceUrl: sourceUrl ?? null, limitation: limitation ?? null, failureCode: failureCode ?? null, revision };
      await tx.update(articles).set({ contentRevision: revision }).where(eq(articles.id, context.articleId));
      await tx.insert(articleContents).values({ ...replacement, articleId: context.articleId }).onConflictDoUpdate({ target: articleContents.articleId, set: replacement });
      await tx.update(processingTasks).set({ state: "succeeded", errorCode: null, updatedAt: outcome.at, endedAt: outcome.at }).where(eq(processingTasks.id, task.id));
      return revision;
    });
  }

  async saveSuccessful(articleId: string, content: Content): Promise<number> {
    return this.db.transaction(async tx => {
      const [article] = await tx.update(articles).set({ contentRevision: sql`${articles.contentRevision} + 1` })
        .where(eq(articles.id, articleId)).returning({ revision: articles.contentRevision });
      if (!article) throw new Error("article not found");
      await tx.insert(articleContents).values({ ...content, articleId, revision: article.revision }).onConflictDoUpdate({
        target: articleContents.articleId,
        // A successful refresh replaces metadata as well as text; omitted fields clear it.
        set: { ...content, sourceUrl: content.sourceUrl ?? null, limitation: content.limitation ?? null, failureCode: content.failureCode ?? null, revision: article.revision },
      });
      return article.revision;
    });
  }
}
