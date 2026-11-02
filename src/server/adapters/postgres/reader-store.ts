import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { articles } from "./schema/index.js";

export class ReaderStore {
  constructor(private readonly db: Database) {}
  async getArticle(id: string) {
    const [row] = await this.db.select().from(articles).where(eq(articles.id, id));
    return row ?? null;
  }
  async setRead(id: string, isRead: boolean) {
    const [row] = await this.db.update(articles).set({ isRead }).where(eq(articles.id, id)).returning();
    return row ?? null;
  }
}
