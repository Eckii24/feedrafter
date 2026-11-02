import { and, eq, isNull, sql } from "drizzle-orm";
import { validateModelRoleSettings, type ModelRoleSettings } from "../../../shared/settings.js";
import { validateScoreDefinition, type ScoreDefinitionInput } from "../../../shared/scores.js";
import { fallbackCategoryId, normalizeTagLabel } from "../../../shared/taxonomy.js";
import type { Database } from "./client.js";
import { articleTags, categories, modelRoles, scoreCategoryPrompts, scoreDefinitions, tags } from "./schema/enrichment.js";
import { articles } from "./schema/import.js";

type AssignmentResult = 'ok' | 'catalog_not_found' | 'article_not_found' | 'archived';

export class CatalogCollision extends Error {}

export class CatalogStore {
  constructor(private readonly db: Database) {}

  listCategories() { return this.db.select().from(categories); }
  async createCategory(label: string) {
    if (typeof label !== "string" || !label.trim()) throw new RangeError("category label is required");
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(341957212)`);
      const duplicate = await tx.select({ id: categories.id }).from(categories).where(sql`lower(trim(${categories.label})) = lower(trim(${label}))`).limit(1);
      if (duplicate.length) throw new CatalogCollision();
      const [row] = await tx.insert(categories).values({ label }).returning();
      return row!;
    });
  }
  async renameCategory(id: string, label: string) {
    if (typeof label !== "string" || !label.trim()) throw new RangeError("category label is required");
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(341957212)`);
      const current = await tx.select({ id: categories.id }).from(categories).where(eq(categories.id, id)).limit(1);
      if (!current.length) return null;
      const duplicate = await tx.select({ id: categories.id }).from(categories).where(sql`lower(trim(${categories.label})) = lower(trim(${label})) and ${categories.id} <> ${id}::uuid`).limit(1);
      if (duplicate.length) throw new CatalogCollision();
      const [row] = await tx.update(categories).set({ label }).where(eq(categories.id, id)).returning();
      return row ?? null;
    });
  }
  async archiveCategory(id: string, at: Date) {
    const [row] = await this.db.update(categories).set({ archivedAt: at }).where(and(eq(categories.id, id), isNull(categories.archivedAt))).returning();
    if (row) return row;
    const [existing] = await this.db.select().from(categories).where(eq(categories.id, id));
    return existing ?? null;
  }
  listTags() { return this.db.select().from(tags); }
  listSuggestedTags() { return this.db.select().from(tags).where(isNull(tags.archivedAt)); }
  async createTag(label: string) {
    // Trigger computes the authoritative casefolded key.
    const [row] = await this.db.insert(tags).values({ label: normalizeTagLabel(label), key: "" }).returning();
    return row!;
  }
  async renameTag(id: string, label: string) {
    const [row] = await this.db.update(tags).set({ label: normalizeTagLabel(label) }).where(eq(tags.id, id)).returning();
    return row ?? null;
  }
  async archiveTag(id: string, at: Date) {
    const [row] = await this.db.update(tags).set({ archivedAt: at }).where(and(eq(tags.id, id), isNull(tags.archivedAt))).returning();
    if (row) return row;
    const [existing] = await this.db.select().from(tags).where(eq(tags.id, id));
    return existing ?? null;
  }
  listArticleTags(articleId: string) {
    return this.db.select({ id: tags.id, label: tags.label, key: tags.key, archivedAt: tags.archivedAt }).from(articleTags).innerJoin(tags, eq(tags.id, articleTags.tagId)).where(eq(articleTags.articleId, articleId));
  }
  async articleCatalog(articleId: string) {
    return this.db.transaction(async tx => {
      const [article] = await tx.select({ categoryId: articles.categoryId, assignmentRevision: articles.assignmentRevision }).from(articles).where(eq(articles.id, articleId)).for('share');
      if (!article) return null;
      const [category] = await tx.select().from(categories).where(eq(categories.id, article.categoryId));
      const assignedTags = await tx.select({ id: tags.id, label: tags.label, key: tags.key, archivedAt: tags.archivedAt }).from(articleTags).innerJoin(tags, eq(tags.id, articleTags.tagId)).where(eq(articleTags.articleId, articleId));
      return { category: category!, tags: assignedTags, assignmentRevision: article.assignmentRevision };
    });
  }
  async setCategory(articleId: string, categoryId: string): Promise<AssignmentResult> {
    return this.db.transaction(async tx => {
      // Catalog target before article: compatible with catalog archive and future merges.
      const [category] = await tx.select().from(categories).where(eq(categories.id, categoryId)).for('no key update');
      if (!category) return 'catalog_not_found';
      const [article] = await tx.select().from(articles).where(eq(articles.id, articleId)).for('update');
      if (!article) return 'article_not_found';
      if (category.archivedAt) return 'archived';
      if (article.categoryId !== categoryId.toLowerCase()) await tx.update(articles).set({ categoryId, assignmentRevision: sql`${articles.assignmentRevision} + 1` }).where(eq(articles.id, articleId));
      return 'ok';
    });
  }
  async changeTag(articleId: string, tagId: string, attach: boolean): Promise<AssignmentResult> {
    return this.db.transaction(async tx => {
      const [tag] = await tx.select().from(tags).where(eq(tags.id, tagId)).for('no key update');
      if (!tag) return 'catalog_not_found';
      const [article] = await tx.select({ id: articles.id }).from(articles).where(eq(articles.id, articleId)).for('update');
      if (!article) return 'article_not_found';
      if (attach && tag.archivedAt) return 'archived';
      const changed = attach
        ? await tx.insert(articleTags).values({ articleId, tagId }).onConflictDoNothing().returning()
        : await tx.delete(articleTags).where(and(eq(articleTags.articleId, articleId), eq(articleTags.tagId, tagId))).returning();
      if (changed.length) await tx.update(articles).set({ assignmentRevision: sql`${articles.assignmentRevision} + 1` }).where(eq(articles.id, articleId));
      return 'ok';
    });
  }
  async attachTag(articleId: string, tagId: string): Promise<boolean> {
    return await this.changeTag(articleId, tagId, true) === 'ok';
  }
  listScoreDefinitions() { return this.db.select().from(scoreDefinitions); }
  async saveScoreDefinition(id: string, input: ScoreDefinitionInput) {
    validateScoreDefinition(input);
    const [row] = await this.db.update(scoreDefinitions).set(input).where(and(eq(scoreDefinitions.id, id), isNull(scoreDefinitions.deletedAt))).returning();
    return row ?? null;
  }
  async updateScoreDefinition(id: string, input: Partial<ScoreDefinitionInput>) {
    const [row] = await this.db.update(scoreDefinitions).set(input).where(and(eq(scoreDefinitions.id, id), isNull(scoreDefinitions.deletedAt))).returning();
    return row ?? null;
  }
  async createScoreDefinition(input: ScoreDefinitionInput) {
    validateScoreDefinition(input);
    const [row] = await this.db.insert(scoreDefinitions).values(input).returning();
    return row!;
  }
  async deleteScoreDefinition(id: string, at: Date) {
    const [row] = await this.db.update(scoreDefinitions).set({ active: false, deletedAt: at }).where(and(eq(scoreDefinitions.id, id), isNull(scoreDefinitions.deletedAt))).returning();
    if (row) return row;
    const [existing] = await this.db.select().from(scoreDefinitions).where(eq(scoreDefinitions.id, id));
    return existing ?? null;
  }
  listScoreCategoryPrompts() { return this.db.select().from(scoreCategoryPrompts); }
  async scoreCategoryPromptsForScore(scoreId: string) {
    return this.db.transaction(async tx => {
      const [score] = await tx.select().from(scoreDefinitions).where(eq(scoreDefinitions.id, scoreId)).for('share');
      if (!score) return { result: 'not_found' as const };
      if (score.deletedAt) return { result: 'deleted' as const };
      const items = await tx.select().from(scoreCategoryPrompts).where(eq(scoreCategoryPrompts.scoreId, scoreId));
      return { result: 'ok' as const, items };
    });
  }
  private async changeScoreCategoryPrompt(scoreId: string, categoryId: string, prompt: string | null) {
    return this.db.transaction(async tx => {
      const [score] = await tx.select().from(scoreDefinitions).where(eq(scoreDefinitions.id, scoreId)).for('share');
      if (!score) return 'not_found' as const;
      if (score.deletedAt) return 'deleted' as const;
      const [category] = await tx.select().from(categories).where(eq(categories.id, categoryId)).for('share');
      if (!category) return 'not_found' as const;
      if (category.id === fallbackCategoryId || category.archivedAt) return 'invalid_category' as const;
      if (prompt === null) await tx.delete(scoreCategoryPrompts).where(and(eq(scoreCategoryPrompts.scoreId, scoreId), eq(scoreCategoryPrompts.categoryId, categoryId)));
      else await tx.insert(scoreCategoryPrompts).values({ scoreId, categoryId, prompt }).onConflictDoUpdate({ target: [scoreCategoryPrompts.scoreId, scoreCategoryPrompts.categoryId], set: { prompt } });
      return 'ok' as const;
    });
  }
  async saveScoreCategoryPrompt(scoreId: string, categoryId: string, prompt: string) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 10000 || prompt.includes('\0')) throw new RangeError('invalid prompt');
    return this.changeScoreCategoryPrompt(scoreId, categoryId, prompt);
  }
  async deleteScoreCategoryPrompt(scoreId: string, categoryId: string) {
    return this.changeScoreCategoryPrompt(scoreId, categoryId, null);
  }
  listModelRoles() { return this.db.select().from(modelRoles); }
  async saveModelRole(settings: ModelRoleSettings) {
    validateModelRoleSettings(settings);
    const values = { role: settings.role, provider: settings.primary?.provider ?? null, model: settings.primary?.model ?? null, fallbackProvider: settings.fallback?.provider ?? null, fallbackModel: settings.fallback?.model ?? null };
    await this.db.insert(modelRoles).values(values).onConflictDoUpdate({ target: modelRoles.role, set: values });
  }
}
