import { and, eq, sql } from "drizzle-orm";
import type { FreshRssEntry } from "../../ports/freshrss.js";
import type { Database } from "./client.js";
import { acknowledgements, appSettings, articles, importContexts, sources } from "./schema/index.js";

export type ImportTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type ImportedArticleIdentity = { id: string; inserted: boolean };

export class ImportStore {
  constructor(private readonly db: Database) {}

  async ensureContext(instance: string, account: string) {
    const [row] = await this.db.insert(importContexts).values({ instance, account })
      .onConflictDoUpdate({ target: [importContexts.instance, importContexts.account], set: { instance } }).returning();
    return row!;
  }

  // A page commits article identities and acknowledgement intents atomically.
  async importPage(contextId: string, entries: readonly FreshRssEntry[], importedAt: Date) {
    return this.db.transaction((tx) => this.importPageInTransaction(tx, contextId, entries, importedAt));
  }

  async importPageInTransaction(tx: ImportTransaction, contextId: string, entries: readonly FreshRssEntry[], importedAt: Date) {
    return (await this.importPageWithIdentitiesInTransaction(tx, contextId, entries, importedAt)).map(article => article.id);
  }

  async importPageWithIdentities(contextId: string, entries: readonly FreshRssEntry[], importedAt: Date): Promise<ImportedArticleIdentity[]> {
    return this.db.transaction((tx) => this.importPageWithIdentitiesInTransaction(tx, contextId, entries, importedAt));
  }

  // `inserted` describes this occurrence, and is durable only if the transaction commits.
  async importPageWithIdentitiesInTransaction(tx: ImportTransaction, contextId: string, entries: readonly FreshRssEntry[], importedAt: Date): Promise<ImportedArticleIdentity[]> {
    // Merge takes this row exclusively before locking tags or articles.
    const epoch = await tx.execute(sql`select revision from catalog_epoch where id = 1 for share`);
    if (!epoch.rowCount) throw new Error("Missing catalog epoch");
    const identities: ImportedArticleIdentity[] = [];
    for (const entry of entries) {
      let sourceId: string | null = null;
      if (entry.feedId !== null) {
        const [source] = await tx.insert(sources).values({ contextId, externalFeedId: entry.feedId, title: entry.feedTitle })
          .onConflictDoUpdate({ target: [sources.contextId, sources.externalFeedId], set: { title: entry.feedTitle } }).returning();
        sourceId = source!.id;
      }
      // PostgreSQL 18 exposes the old row for a conflict update, and NULL for an insert.
      const [article] = await tx.insert(articles).values({
        contextId, freshrssId: entry.id, sourceId, title: entry.title, url: entry.url,
        author: entry.author, publishedAt: entry.publishedAt, importedAt,
      }).onConflictDoUpdate({
        target: [articles.contextId, articles.freshrssId],
        set: { sourceId, title: entry.title, url: entry.url, author: entry.author, publishedAt: entry.publishedAt },
      }).returning({ id: articles.id, inserted: sql<boolean>`old.id is null` });
      identities.push(article!);
      // An entry observed unread again needs a new confirmation; existing pending
      // intents keep their eligibility and diagnostics until reconciliation.
      await tx.insert(acknowledgements).values({ contextId, articleId: article!.id })
        .onConflictDoUpdate({
          target: [acknowledgements.contextId, acknowledgements.articleId],
          set: { status: "pending", eligible: false, confirmedAt: null },
          setWhere: eq(acknowledgements.status, "confirmed"),
        });
    }
    return identities;
  }

  async pendingAcknowledgements(contextId: string) {
    return this.db.select({ acknowledgement: acknowledgements, freshrssId: articles.freshrssId })
      .from(acknowledgements).innerJoin(articles, eq(acknowledgements.articleId, articles.id))
      .where(and(eq(acknowledgements.contextId, contextId), eq(acknowledgements.status, "pending"), eq(acknowledgements.eligible, true)));
  }

  // Call only after the complete scan has committed; never during pagination.
  async makePendingEligible(contextId: string) {
    return this.db.update(acknowledgements).set({ eligible: true })
      .where(and(eq(acknowledgements.contextId, contextId), eq(acknowledgements.status, "pending"))).returning();
  }

  async recordAttempt(id: string, at: Date, diagnostic: string | null) {
    return this.db.update(acknowledgements).set({ attempts: sql`${acknowledgements.attempts} + 1`, lastAttemptAt: at, diagnostic })
      .where(and(eq(acknowledgements.id, id), eq(acknowledgements.status, "pending"), eq(acknowledgements.eligible, true))).returning();
  }

  async confirm(id: string, at: Date) {
    return this.db.update(acknowledgements).set({ status: "confirmed", confirmedAt: at, diagnostic: null })
      .where(and(eq(acknowledgements.id, id), eq(acknowledgements.status, "pending"), eq(acknowledgements.eligible, true))).returning();
  }

  async getSettings() {
    const [row] = await this.db.select().from(appSettings).where(eq(appSettings.id, 1));
    return row ?? { id: 1, importEnabled: true, importIntervalSeconds: 14400, nextImportAt: null, preferenceHalfLifeDays: 90 };
  }

  async patchSettings(patch: { importEnabled?: boolean; importIntervalSeconds?: number }, now: Date) {
    return this.db.transaction(async tx => {
      await tx.insert(appSettings).values({ id: 1 }).onConflictDoNothing();
      const [old] = await tx.select().from(appSettings).where(eq(appSettings.id, 1)).for('update');
      const interval = patch.importIntervalSeconds ?? old!.importIntervalSeconds;
      const [row] = await tx.update(appSettings).set({ importEnabled: patch.importEnabled ?? old!.importEnabled, importIntervalSeconds: interval, nextImportAt: new Date(now.getTime() + interval * 1000) }).where(eq(appSettings.id, 1)).returning();
      return row!;
    });
  }

  async saveSettings(settings: { importEnabled: boolean; importIntervalSeconds: number; nextImportAt: Date | null }) {
    if (typeof settings.importEnabled !== "boolean" || !Number.isSafeInteger(settings.importIntervalSeconds) ||
        settings.importIntervalSeconds <= 0 || settings.importIntervalSeconds > 2147483647 ||
        (settings.nextImportAt !== null && (!(settings.nextImportAt instanceof Date) || !Number.isFinite(settings.nextImportAt.getTime())))) {
      throw new TypeError("Invalid import settings");
    }
    const [row] = await this.db.insert(appSettings).values({ id: 1, ...settings })
      .onConflictDoUpdate({ target: appSettings.id, set: settings }).returning();
    return row!;
  }
}
