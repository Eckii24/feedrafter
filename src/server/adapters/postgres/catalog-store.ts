import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { validateModelRoleSettings, type ModelRoleSettings } from "../../../shared/settings.js";
import { validateScoreDefinition, type ScoreDefinitionInput } from "../../../shared/scores.js";
import { fallbackCategoryId, normalizeTagLabel } from "../../../shared/taxonomy.js";
import { articleFingerprint, decodeHandoffReceiptV1, readHandoffReceipt, type ChainMetadataV1, type HandoffReceiptV1 } from "../../domain/article-handoff.js";
import type { Database } from "./client.js";
import { articleContents, articleTags, catalogEpoch, categories, modelRoles, scoreCategoryPrompts, scoreDefinitions, tags } from "./schema/enrichment.js";
import { articles } from "./schema/import.js";
import { processingTasks } from "./schema/processing.js";

export type CategoryCandidate = {
  taskId: string;
  executionToken: string;
  articleId: string;
  generation: number;
  prerequisiteId: string | null;
  contentRevision: number;
  contentText: string;
  assignmentRevision: number;
  catalogEpoch: number;
  categoryId: string;
  articleInputHash?: string;
  chainRoot?: ChainMetadataV1;
};

export type CategoryPublication = { assignmentRevision: number; receipt: HandoffReceiptV1 };

export type TagCandidate = Omit<CategoryCandidate, 'prerequisiteId'> & {
  prerequisiteTaskId: string;
  prerequisiteGeneration: number;
  categoryPrerequisiteId: string | null;
  title: string | null;
  labels: string[];
};

const candidateUuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const candidateRevision = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647;
const validCategoryCandidate = (candidate: CategoryCandidate, at: Date) => Boolean(candidate &&
  [candidate.taskId, candidate.executionToken, candidate.articleId, candidate.categoryId].every(candidateUuid) &&
  (candidate.prerequisiteId === null || candidateUuid(candidate.prerequisiteId)) && typeof candidate.contentText === 'string' && candidate.contentText.trim() && candidate.contentRevision > 0 &&
  [candidate.generation, candidate.contentRevision, candidate.assignmentRevision, candidate.catalogEpoch].every(candidateRevision) &&
  at instanceof Date && Number.isFinite(at.getTime()));
function normalizedCandidateLabels(candidate: TagCandidate, at: Date): string[] | null {
  if (!candidate || ![candidate.taskId, candidate.executionToken, candidate.articleId, candidate.categoryId, candidate.prerequisiteTaskId].every(candidateUuid) ||
      !(candidate.categoryPrerequisiteId === null || candidateUuid(candidate.categoryPrerequisiteId)) || !(candidate.title === null || typeof candidate.title === 'string') || typeof candidate.contentText !== 'string' || !candidate.contentText.trim() || candidate.contentRevision <= 0 ||
      ![candidate.generation, candidate.prerequisiteGeneration, candidate.contentRevision, candidate.assignmentRevision, candidate.catalogEpoch].every(candidateRevision) ||
      !Array.isArray(candidate.labels) || candidate.labels.length > 10 || !(at instanceof Date) || !Number.isFinite(at.getTime())) return null;
  try {
    const labels = Array.from(candidate.labels, label => normalizeTagLabel(label));
    return labels.some(label => label.includes('\0') || Buffer.from(label, 'utf8').toString('utf8') !== label) ? null : labels;
  } catch { return null; }
}

// Catch only outside the owning transaction: rejection can follow tag writes.
export class RejectTagCandidate extends Error {}

type AssignmentResult = 'ok' | 'catalog_not_found' | 'article_not_found' | 'archived';
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

// Keep this expression identical to the normalize_tag trigger, including ICU casefold.
const tagKey = (label: ReturnType<typeof sql>) => sql`normalize(casefold(btrim(regexp_replace(normalize(${label}, NFKC), '[[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', ' ', 'g')) COLLATE "und-x-icu"), NFKC)`;
async function tagKeysFit(db: Database | Transaction, labels: string[]): Promise<boolean> {
  const elements = sql.join(labels.map(label => sql`${label}`), sql`, `);
  const result = await db.execute<{ valid: boolean }>(sql`select coalesce(bool_and(octet_length(${tagKey(sql`input.label`)}) <= 1000), true) as valid from unnest(ARRAY[${elements}]::text[]) as input(label)`);
  return result.rows[0]?.valid === true;
}

async function lockEpoch(tx: Transaction) {
  const [epoch] = await tx.select().from(catalogEpoch).where(eq(catalogEpoch.id, 1)).for('update');
  if (!epoch) throw new Error('Missing catalog epoch');
}
async function advanceEpoch(tx: Transaction) {
  await tx.update(catalogEpoch).set({ revision: sql`${catalogEpoch.revision} + 1` }).where(eq(catalogEpoch.id, 1));
}
const changed = <T extends object>(before: T, after: T, keys: readonly (keyof T)[]) => keys.some(key => before[key] !== after[key]);
const scoreFields: (keyof ScoreDefinitionInput)[] = ['name', 'description', 'prompt', 'active', 'includeTitle', 'includeContent', 'includeCategory', 'includeTagWeights', 'includeSourceWeight'];

export class CatalogCollision extends Error {}

export class CatalogStore {
  constructor(private readonly db: Database) {}

  listCategories() { return this.db.select().from(categories); }
  async createCategory(label: string) {
    if (typeof label !== "string" || !label.trim()) throw new RangeError("category label is required");
    return this.db.transaction(async tx => {
      await lockEpoch(tx);
      await tx.execute(sql`select pg_advisory_xact_lock(341957212)`);
      const duplicate = await tx.select({ id: categories.id }).from(categories).where(sql`lower(trim(${categories.label})) = lower(trim(${label}))`).limit(1);
      if (duplicate.length) throw new CatalogCollision();
      const [row] = await tx.insert(categories).values({ label }).returning();
      await advanceEpoch(tx);
      return row!;
    });
  }
  async renameCategory(id: string, label: string) {
    if (typeof label !== "string" || !label.trim()) throw new RangeError("category label is required");
    return this.db.transaction(async tx => {
      await lockEpoch(tx);
      await tx.execute(sql`select pg_advisory_xact_lock(341957212)`);
      const current = await tx.select({ id: categories.id, label: categories.label }).from(categories).where(eq(categories.id, id)).limit(1);
      if (!current.length) return null;
      const duplicate = await tx.select({ id: categories.id }).from(categories).where(sql`lower(trim(${categories.label})) = lower(trim(${label})) and ${categories.id} <> ${id}::uuid`).limit(1);
      if (duplicate.length) throw new CatalogCollision();
      const [row] = await tx.update(categories).set({ label }).where(eq(categories.id, id)).returning();
      if (row && row.label !== current[0]!.label) await advanceEpoch(tx);
      return row ?? null;
    });
  }
  async archiveCategory(id: string, at: Date) {
    return this.db.transaction(async tx => {
      await lockEpoch(tx);
      const [row] = await tx.update(categories).set({ archivedAt: at }).where(and(eq(categories.id, id), isNull(categories.archivedAt))).returning();
      if (row) { await advanceEpoch(tx); return row; }
      const [existing] = await tx.select().from(categories).where(eq(categories.id, id));
      return existing ?? null;
    });
  }
  listTags() { return this.db.select().from(tags); }
  listSuggestedTags() { return this.db.select().from(tags).where(isNull(tags.archivedAt)); }
  async createTag(label: string) {
    const normalized = normalizeTagLabel(label);
    return this.db.transaction(async tx => {
      await lockEpoch(tx);
      // Trigger computes the authoritative casefolded key.
      const [row] = await tx.insert(tags).values({ label: normalized, key: "" }).returning();
      await advanceEpoch(tx);
      return row!;
    });
  }
  async renameTag(id: string, label: string) {
    const normalized = normalizeTagLabel(label);
    return this.db.transaction(async tx => {
      await lockEpoch(tx);
      const [before] = await tx.select().from(tags).where(eq(tags.id, id)).for('update');
      const [row] = await tx.update(tags).set({ label: normalized }).where(eq(tags.id, id)).returning();
      if (row && before && row.label !== before.label) await advanceEpoch(tx);
      return row ?? null;
    });
  }
  async archiveTag(id: string, at: Date) {
    return this.db.transaction(async tx => {
      await lockEpoch(tx);
      const [row] = await tx.update(tags).set({ archivedAt: at }).where(and(eq(tags.id, id), isNull(tags.archivedAt))).returning();
      if (row) { await advanceEpoch(tx); return row; }
      const [existing] = await tx.select().from(tags).where(eq(tags.id, id));
      return existing ?? null;
    });
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
  // Capture the catalog and article basis coherently before dispatch. New task
  // generations must lock the article before insertion, as TaskStore does.
  async publishCategoryCandidate(candidate: CategoryCandidate, at: Date): Promise<CategoryPublication | null> {
    if (!validCategoryCandidate(candidate, at)) return null;
    return this.db.transaction(tx => this.publishCategoryCandidateInTransaction(tx, candidate, at));
  }

  async publishCategoryCandidateInTransaction(tx: Transaction, candidate: CategoryCandidate, at: Date, allowChain = false): Promise<CategoryPublication | null> {
    if (!validCategoryCandidate(candidate, at)) return null;
    {
      // Epoch -> category -> article -> category task -> prerequisite -> content.
      const [epoch] = await tx.select().from(catalogEpoch).where(eq(catalogEpoch.id, 1)).for('share');
      if (!epoch || epoch.revision !== candidate.catalogEpoch) return null;
      const [category] = await tx.select().from(categories).where(eq(categories.id, candidate.categoryId)).for('share');
      if (!category || category.archivedAt !== null) return null;
      const [article] = await tx.select().from(articles).where(eq(articles.id, candidate.articleId)).for('update');
      if (!article || article.contentRevision !== candidate.contentRevision || article.assignmentRevision !== candidate.assignmentRevision ||
          (candidate.chainRoot && (!candidate.articleInputHash || articleFingerprint(article.title, article.sourceId) !== candidate.articleInputHash))) return null;
      const [task] = await tx.select().from(processingTasks).where(eq(processingTasks.id, candidate.taskId)).for('update');
      if (!task || task.articleId !== article.id || task.action !== 'category' || task.state !== 'running' ||
          task.executionToken !== candidate.executionToken.toLowerCase() || task.generation !== candidate.generation ||
          task.prerequisiteId !== (candidate.prerequisiteId?.toLowerCase() ?? null)) return null;
      const hasChain = task.result !== null && Object.hasOwn(task.result, 'articleChain');
      if (hasChain !== Boolean(candidate.chainRoot) || (hasChain && !allowChain)) return null;
      if (task.prerequisiteId !== null) {
        const [prerequisite] = await tx.select().from(processingTasks).where(eq(processingTasks.id, task.prerequisiteId)).for('share');
        if (!prerequisite || prerequisite.articleId !== article.id || prerequisite.action !== 'prepare' || prerequisite.state !== 'succeeded') return null;
      }
      const [content] = await tx.select().from(articleContents).where(eq(articleContents.articleId, article.id)).for('share');
      if (!content || content.revision !== candidate.contentRevision || content.text !== candidate.contentText || !content.text.trim() || content.quality !== 'usable') return null;
      const [newer] = await tx.select({ id: processingTasks.id }).from(processingTasks).where(and(
        eq(processingTasks.articleId, article.id), eq(processingTasks.action, 'category'), gt(processingTasks.generation, candidate.generation),
      )).limit(1);
      if (newer) return null;
      const changed = article.categoryId !== category.id;
      if (changed && article.assignmentRevision === 2147483647) return null;
      const assignmentRevision = article.assignmentRevision + (changed ? 1 : 0);
      // A standalone fingerprint records the locked row, not request freshness.
      const receipt = decodeHandoffReceiptV1({ version: 1, taskId: task.id, generation: task.generation, action: 'category', articleId: article.id,
        prerequisiteId: task.prerequisiteId, categoryId: category.id, basis: { contentRevision: article.contentRevision, assignmentRevision,
          articleInputHash: candidate.chainRoot ? candidate.articleInputHash : articleFingerprint(article.title, article.sourceId) }, catalogEpoch: epoch.revision });
      if (!receipt) return null;
      if (changed) {
        const assigned = await tx.update(articles).set({ categoryId: category.id, assignmentRevision }).where(eq(articles.id, article.id))
          .returning({ id: articles.id, categoryId: articles.categoryId, assignmentRevision: articles.assignmentRevision });
        if (assigned.length !== 1 || assigned[0]?.categoryId !== category.id || assigned[0]?.assignmentRevision !== assignmentRevision) throw new Error('Category assignment update failed');
      }
      const updated = await tx.update(processingTasks).set({ state: 'succeeded', result: { ...task.result, handoffReceipt: receipt }, errorCode: null, updatedAt: at, endedAt: at }).where(eq(processingTasks.id, task.id))
        .returning({ id: processingTasks.id, state: processingTasks.state, result: processingTasks.result });
      if (updated.length !== 1 || updated[0]?.state !== 'succeeded' || JSON.stringify(readHandoffReceipt(updated[0]?.result)) !== JSON.stringify(receipt)) throw new Error('Category task success update failed');
      return { assignmentRevision, receipt };
    }
  }
  tagKeysFit(labels: string[]) { return tagKeysFit(this.db, labels); }

  async publishTagCandidate(candidate: TagCandidate, at: Date): Promise<{ assignmentRevision: number; catalogEpoch: number } | null> {
    if (!normalizedCandidateLabels(candidate, at)) return null;
    try {
      return await this.db.transaction(tx => this.publishTagCandidateInTransaction(tx, candidate, at));
    } catch (error) {
      if (error instanceof RejectTagCandidate) return null;
      throw error;
    }
  }

  // RejectTagCandidate must escape the transaction before being translated to null.
  async publishTagCandidateInTransaction(tx: Transaction, candidate: TagCandidate, at: Date): Promise<{ assignmentRevision: number; catalogEpoch: number } | null> {
    const labels = normalizedCandidateLabels(candidate, at);
    if (!labels) return null;
    {
        if (!await tagKeysFit(tx, labels)) return null;
        // Exclusive epoch lock serializes catalog mutations, including tag creation.
        const [epoch] = await tx.select().from(catalogEpoch).where(eq(catalogEpoch.id, 1)).for('update');
        if (!epoch || epoch.revision !== candidate.catalogEpoch) return null;
        const [article] = await tx.select().from(articles).where(eq(articles.id, candidate.articleId)).for('update');
        if (!article || article.title !== candidate.title || article.categoryId !== candidate.categoryId.toLowerCase() || article.contentRevision !== candidate.contentRevision || article.assignmentRevision !== candidate.assignmentRevision) return null;
        const [task] = await tx.select().from(processingTasks).where(eq(processingTasks.id, candidate.taskId)).for('update');
        if (!task || task.articleId !== article.id || task.action !== 'tags' || task.state !== 'running' ||
            task.executionToken !== candidate.executionToken.toLowerCase() || task.generation !== candidate.generation ||
            task.prerequisiteId !== candidate.prerequisiteTaskId.toLowerCase()) return null;
        const [prerequisite] = await tx.select().from(processingTasks).where(eq(processingTasks.id, candidate.prerequisiteTaskId)).for('share');
        if (!prerequisite || prerequisite.articleId !== article.id || prerequisite.action !== 'category' || prerequisite.state !== 'succeeded' || prerequisite.generation !== candidate.prerequisiteGeneration || prerequisite.prerequisiteId !== (candidate.categoryPrerequisiteId?.toLowerCase() ?? null)) return null;
        if (prerequisite.prerequisiteId !== null) {
          const [prepare] = await tx.select().from(processingTasks).where(eq(processingTasks.id, prerequisite.prerequisiteId)).for('share');
          if (!prepare || prepare.articleId !== article.id || prepare.action !== 'prepare' || prepare.state !== 'succeeded') return null;
        }
        const [content] = await tx.select().from(articleContents).where(eq(articleContents.articleId, article.id)).for('share');
        if (!content || content.revision !== candidate.contentRevision || content.text !== candidate.contentText || !content.text.trim() || content.quality !== 'usable') return null;
        const [newer] = await tx.select({ id: processingTasks.id }).from(processingTasks).where(and(
          eq(processingTasks.articleId, article.id), sql`((${processingTasks.action} = 'tags' and ${processingTasks.generation} > ${candidate.generation}) or (${processingTasks.action} = 'category' and ${processingTasks.generation} > ${candidate.prerequisiteGeneration}))`,
        )).limit(1);
        if (newer) return null;
        let created = false, attached = false;
        for (const label of labels) {
          // The trigger normalizes the label and key before the unique check.
          const [inserted] = await tx.insert(tags).values({ label, key: '' }).onConflictDoNothing({ target: tags.key }).returning();
          if (inserted) created = true;
          const [tag] = inserted ? [inserted] : await tx.select().from(tags).where(sql`${tags.key} = ${tagKey(sql`${label}::text`)}`);
          if (!tag || tag.archivedAt) throw new RejectTagCandidate();
          const association = await tx.insert(articleTags).values({ articleId: article.id, tagId: tag.id }).onConflictDoNothing().returning({ tagId: articleTags.tagId });
          if (association.length) attached = true;
        }
        let assignmentRevision = article.assignmentRevision;
        if (attached) {
          if (assignmentRevision === 2147483647) throw new RejectTagCandidate();
          assignmentRevision++;
          const updated = await tx.update(articles).set({ assignmentRevision }).where(eq(articles.id, article.id)).returning({ id: articles.id });
          if (updated.length !== 1) throw new Error('Tag assignment update failed');
        }
        let resultEpoch = epoch.revision;
        if (created) {
          if (resultEpoch === 2147483647) throw new RejectTagCandidate();
          await advanceEpoch(tx);
          resultEpoch++;
        }
        const updated = await tx.update(processingTasks).set({ state: 'succeeded', errorCode: null, updatedAt: at, endedAt: at }).where(eq(processingTasks.id, task.id)).returning({ id: processingTasks.id });
        if (updated.length !== 1) throw new Error('Tag task success update failed');
        return { assignmentRevision, catalogEpoch: resultEpoch };
    }
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
    return this.updateScoreDefinition(id, input);
  }
  async updateScoreDefinition(id: string, input: Partial<ScoreDefinitionInput>) {
    return this.db.transaction(async tx => {
      await lockEpoch(tx);
      const [before] = await tx.select().from(scoreDefinitions).where(and(eq(scoreDefinitions.id, id), isNull(scoreDefinitions.deletedAt))).for('update');
      const [row] = await tx.update(scoreDefinitions).set(input).where(and(eq(scoreDefinitions.id, id), isNull(scoreDefinitions.deletedAt))).returning();
      if (row && before && changed(before, row, scoreFields)) await advanceEpoch(tx);
      return row ?? null;
    });
  }
  async createScoreDefinition(input: ScoreDefinitionInput) {
    validateScoreDefinition(input);
    return this.db.transaction(async tx => {
      await lockEpoch(tx);
      const [row] = await tx.insert(scoreDefinitions).values(input).returning();
      await advanceEpoch(tx);
      return row!;
    });
  }
  async deleteScoreDefinition(id: string, at: Date) {
    return this.db.transaction(async tx => {
      await lockEpoch(tx);
      const [row] = await tx.update(scoreDefinitions).set({ active: false, deletedAt: at }).where(and(eq(scoreDefinitions.id, id), isNull(scoreDefinitions.deletedAt))).returning();
      if (row) { await advanceEpoch(tx); return row; }
      const [existing] = await tx.select().from(scoreDefinitions).where(eq(scoreDefinitions.id, id));
      return existing ?? null;
    });
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
      await lockEpoch(tx);
      const [score] = await tx.select().from(scoreDefinitions).where(eq(scoreDefinitions.id, scoreId)).for('share');
      if (!score) return 'not_found' as const;
      if (score.deletedAt) return 'deleted' as const;
      const [category] = await tx.select().from(categories).where(eq(categories.id, categoryId)).for('share');
      if (!category) return 'not_found' as const;
      if (category.id === fallbackCategoryId || category.archivedAt) return 'invalid_category' as const;
      const condition = and(eq(scoreCategoryPrompts.scoreId, scoreId), eq(scoreCategoryPrompts.categoryId, categoryId));
      const [before] = await tx.select().from(scoreCategoryPrompts).where(condition);
      if (prompt === null) await tx.delete(scoreCategoryPrompts).where(condition);
      else await tx.insert(scoreCategoryPrompts).values({ scoreId, categoryId, prompt }).onConflictDoUpdate({ target: [scoreCategoryPrompts.scoreId, scoreCategoryPrompts.categoryId], set: { prompt } });
      if ((before?.prompt ?? null) !== prompt) await advanceEpoch(tx);
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
    await this.db.transaction(async tx => {
      await lockEpoch(tx);
      const [before] = await tx.select().from(modelRoles).where(eq(modelRoles.role, settings.role));
      await tx.insert(modelRoles).values(values).onConflictDoUpdate({ target: modelRoles.role, set: values });
      if (!before || changed(before, values, ['provider', 'model', 'fallbackProvider', 'fallbackModel'])) await advanceEpoch(tx);
    });
  }
}
