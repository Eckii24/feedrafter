import { eq, and } from "drizzle-orm";
import { validateScore } from "../../domain/enrichment.js";
import type { Database } from "./client.js";
import { articleScores } from "./schema/enrichment.js";

export type SuccessfulScore = typeof articleScores.$inferInsert;

// Call only after a successful provider result. Failed attempts live in task state,
// never in this table; the single upsert atomically replaces one score.
export class ScoreStore {
  constructor(private readonly db: Database) {}

  async saveSuccessful(result: SuccessfulScore): Promise<void> {
    validateScore(result.value);
    await this.db.insert(articleScores).values(result).onConflictDoUpdate({
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
  }

  async get(articleId: string, scoreId: string) {
    const rows = await this.db.select().from(articleScores).where(and(eq(articleScores.articleId, articleId), eq(articleScores.scoreId, scoreId))).limit(1);
    return rows[0] ?? null;
  }
}
