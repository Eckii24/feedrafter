import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { articles, processingRuns, processingTasks } from "./schema/index.js";

export class TaskStore {
  constructor(private readonly db: Database) {}
  async createRun(contextId: string, startedAt: Date) {
    const [row] = await this.db.insert(processingRuns).values({ contextId, startedAt }).returning();
    return row!;
  }
  async getRun(id: string) {
    const [row] = await this.db.select().from(processingRuns).where(eq(processingRuns.id, id));
    return row ?? null;
  }
  async claimRun(id: string, owner: string) {
    const [row] = await this.db.update(processingRuns).set({ status: "running", executionOwner: owner })
      .where(and(eq(processingRuns.id, id), eq(processingRuns.status, "queued"))).returning();
    return row ?? null;
  }
  // Caller must hold the context's session advisory lock before taking over a run.
  async claimCoordinatedRun(id: string, owner: string) {
    const [row] = await this.db.update(processingRuns).set({ status: "running", executionOwner: owner, errorCode: null })
      .where(and(eq(processingRuns.id, id), inArray(processingRuns.status, ["queued", "running"]))).returning();
    return row ?? null;
  }
  async updateOwnedRun(id: string, owner: string, update: Partial<Pick<typeof processingRuns.$inferInsert,
    "status" | "phase" | "fetchedCount" | "pendingCount" | "confirmedCount" | "endedAt" | "errorCode">>) {
    const [row] = await this.db.update(processingRuns).set(update)
      .where(and(eq(processingRuns.id, id), eq(processingRuns.executionOwner, owner), eq(processingRuns.status, "running"))).returning();
    return row ?? null;
  }
  async createTask(task: typeof processingTasks.$inferInsert) {
    return this.db.transaction(async tx => {
      // Publication takes the same article lock before examining the task generation.
      const [article] = await tx.select({ id: articles.id }).from(articles).where(eq(articles.id, task.articleId)).for("update");
      if (!article) throw new Error("article not found");
      const [row] = await tx.insert(processingTasks).values(task).returning();
      return row!;
    });
  }
  async getTask(id: string) {
    const [row] = await this.db.select().from(processingTasks).where(eq(processingTasks.id, id));
    return row ?? null;
  }
  async claimTask(id: string, token: string, at: Date) {
    return this.claim(id, token, at);
  }
  // Queue consumers must fence the action in the same statement as the claim.
  async claimTaskForAction(id: string, action: 'category' | 'tags' | 'scores', token: string, at: Date) {
    return this.claim(id, token, at, action);
  }
  private async claim(id: string, token: string, at: Date, action?: 'category' | 'tags' | 'scores') {
    const [row] = await this.db.update(processingTasks).set({
      state: "running", executionToken: token, startedAt: at, updatedAt: at,
      attemptCount: sql`${processingTasks.attemptCount} + 1`,
    }).where(and(eq(processingTasks.id, id), inArray(processingTasks.state, ["queued", "retry_wait"]),
      action === undefined ? undefined : eq(processingTasks.action, action))).returning();
    return row ?? null;
  }
  // Fenced updates cannot commit results after ownership changes.
  async updateOwnedTask(id: string, token: string, update: Partial<Pick<typeof processingTasks.$inferInsert,
    "state" | "updatedAt" | "endedAt" | "errorCode" | "result" | "jobId">>) {
    const [row] = await this.db.update(processingTasks).set(update)
      .where(and(eq(processingTasks.id, id), eq(processingTasks.executionToken, token), eq(processingTasks.state, "running"))).returning();
    return row ?? null;
  }
}
