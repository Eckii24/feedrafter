import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { articleFingerprint, decodeChainMetadataV1, decodeHandoffReceiptV1, readChainMetadata, readHandoffReceipt, readPreparationReceipt } from '../../domain/article-handoff.js';
import { CatalogStore, type CategoryCandidate, type CategoryPublication } from './catalog-store.js';
import type { Database } from './client.js';
import { articleContents, articles, catalogEpoch, categories, processingTasks, scoreDefinitions } from './schema/index.js';

const unfinished = ['waiting_dependency', 'queued', 'running', 'retry_wait', 'paused_budget', 'paused_auth', 'needs_input'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxGeneration = 2147483647;
class RejectCategoryHandoff extends Error {}

/** Dormant admission and category handoff. Queue provisioning and workers are caller responsibilities. */
export class ArticleJobs {
  constructor(private readonly db: Database, private readonly boss: PgBoss) {}

  async publishCategoryCandidate(candidate: CategoryCandidate, at: Date): Promise<CategoryPublication | null> {
    if (!candidate || ![candidate.taskId, candidate.articleId, candidate.categoryId].every(value => typeof value === 'string' && uuid.test(value))) return null;
    try {
      return await this.db.transaction(async tx => {
        // Acquire the publisher's lock prefix before inspecting the exact successor.
        const [epoch] = await tx.select({ id: catalogEpoch.id }).from(catalogEpoch).where(eq(catalogEpoch.id, 1)).for('share');
        const [category] = await tx.select({ id: categories.id }).from(categories).where(eq(categories.id, candidate.categoryId)).for('share');
        const [article] = await tx.select({ id: articles.id }).from(articles).where(eq(articles.id, candidate.articleId)).for('update');
        if (!epoch || !category || !article) return null;
        const [task] = await tx.select().from(processingTasks).where(eq(processingTasks.id, candidate.taskId)).for('update');
        if (!task || task.articleId !== article.id) return null;
        const hasChain = task.result !== null && Object.hasOwn(task.result, 'articleChain');
        if (!hasChain) return new CatalogStore(this.db).publishCategoryCandidateInTransaction(tx, candidate, at);

        const root = readChainMetadata(task.result, 'category');
        const captured = candidate.chainRoot && decodeChainMetadataV1(candidate.chainRoot, 'category');
        if (!root || root.requiredHandoff !== null || !captured || captured.requiredHandoff !== null ||
            JSON.stringify(root) !== JSON.stringify(captured) || root.rootTaskId.toLowerCase() !== task.id ||
            root.prepareTaskId.toLowerCase() !== task.prerequisiteId || root.requiredBasis.contentRevision !== candidate.contentRevision ||
            root.requiredBasis.assignmentRevision !== candidate.assignmentRevision || root.requiredBasis.articleInputHash !== candidate.articleInputHash) throw new RejectCategoryHandoff();
        const [prepare] = await tx.select().from(processingTasks).where(eq(processingTasks.id, root.prepareTaskId)).for('share');
        const preparation = prepare && readPreparationReceipt(prepare.result);
        if (!prepare || prepare.articleId !== task.articleId || prepare.action !== 'prepare' || prepare.state !== 'succeeded' || !preparation ||
            preparation.taskId.toLowerCase() !== prepare.id || preparation.articleId.toLowerCase() !== task.articleId ||
            preparation.generation !== prepare.generation || preparation.contentRevision !== candidate.contentRevision) throw new RejectCategoryHandoff();
        const [newerPrepare] = await tx.select({ id: processingTasks.id }).from(processingTasks).where(and(eq(processingTasks.articleId, task.articleId),
          eq(processingTasks.action, 'prepare'), gt(processingTasks.generation, prepare.generation))).limit(1);
        if (newerPrepare) throw new RejectCategoryHandoff();
        const [successor] = await tx.select().from(processingTasks).where(eq(processingTasks.id, root.tagsTaskId)).for('update');
        const tags = successor && readChainMetadata(successor.result, 'tags');
        if (!successor || successor.articleId !== task.articleId || successor.action !== 'tags' || successor.state !== 'waiting_dependency' ||
            successor.prerequisiteId !== task.id || successor.jobId !== null || successor.scoreTargetId !== null || successor.generation < 1 ||
            !tags || !tags.requiredHandoff || tags.requiredBasis !== null || tags.rootTaskId.toLowerCase() !== task.id ||
            tags.prepareTaskId.toLowerCase() !== prepare.id || tags.requiredHandoff.taskId.toLowerCase() !== task.id ||
            tags.requiredHandoff.action !== 'category' || tags.requiredHandoff.generation !== task.generation) throw new RejectCategoryHandoff();
        const [newerTags] = await tx.select({ id: processingTasks.id }).from(processingTasks).where(and(eq(processingTasks.articleId, task.articleId),
          eq(processingTasks.action, 'tags'), gt(processingTasks.generation, successor.generation))).limit(1);
        if (newerTags) throw new RejectCategoryHandoff();
        const published = await new CatalogStore(this.db).publishCategoryCandidateInTransaction(tx, candidate, at, true);
        if (!published) return null;
        const receipt = decodeHandoffReceiptV1(published.receipt);
        const [savedRoot] = await tx.select({ result: processingTasks.result }).from(processingTasks).where(eq(processingTasks.id, task.id));
        if (!receipt || receipt.action !== 'category' || receipt.taskId !== task.id || receipt.articleId !== task.articleId ||
            receipt.generation !== task.generation || receipt.prerequisiteId !== task.prerequisiteId || receipt.categoryId !== category.id ||
            receipt.catalogEpoch !== candidate.catalogEpoch || receipt.basis.contentRevision !== candidate.contentRevision ||
            receipt.basis.assignmentRevision !== published.assignmentRevision || receipt.basis.articleInputHash !== candidate.articleInputHash ||
            JSON.stringify(readChainMetadata(savedRoot?.result, 'category')) !== JSON.stringify(root) ||
            JSON.stringify(readHandoffReceipt(savedRoot?.result)) !== JSON.stringify(receipt)) throw new RejectCategoryHandoff();
        const next = decodeChainMetadataV1({ ...tags, requiredBasis: receipt.basis }, 'tags');
        if (!next) throw new RejectCategoryHandoff();
        const queued = await tx.update(processingTasks).set({ state: 'queued', result: { ...successor.result, articleChain: next }, updatedAt: at })
          .where(and(eq(processingTasks.id, successor.id), eq(processingTasks.state, 'waiting_dependency'), isNull(processingTasks.jobId)))
          .returning({ id: processingTasks.id, state: processingTasks.state, result: processingTasks.result });
        if (queued.length !== 1 || queued[0]?.state !== 'queued' || JSON.stringify(readChainMetadata(queued[0]?.result, 'tags')) !== JSON.stringify(next)) throw new Error('Tags activation failed');
        const jobId = await this.boss.send('tags', { taskId: successor.id }, { db: fromDrizzle(tx, sql), retryLimit: 0 });
        if (!jobId || !uuid.test(jobId)) throw new Error('Tags job was not enqueued');
        const saved = await tx.update(processingTasks).set({ jobId }).where(and(eq(processingTasks.id, successor.id), eq(processingTasks.state, 'queued'), isNull(processingTasks.jobId)))
          .returning({ id: processingTasks.id, jobId: processingTasks.jobId });
        if (saved.length !== 1 || saved[0]?.jobId !== jobId.toLowerCase()) throw new Error('Tags job ID update failed');
        return published;
      }, { isolationLevel: 'read committed' });
    } catch (error) {
      if (error instanceof RejectCategoryHandoff) return null;
      throw error;
    }
  }

  async admitPreparedArticle(articleId: string, prepareTaskId: string, at: Date) {
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Error('Invalid admission timestamp');
    if (!uuid.test(articleId)) return { kind: 'not_found' as const };
    if (!uuid.test(prepareTaskId)) return { kind: 'needs_input' as const };
    return this.db.transaction(async tx => {
      const [epoch] = await tx.select({ id: catalogEpoch.id }).from(catalogEpoch).where(eq(catalogEpoch.id, 1)).for('share');
      if (!epoch) throw new Error('Missing catalog epoch');
      const targets = await tx.select({ id: scoreDefinitions.id }).from(scoreDefinitions)
        .where(and(eq(scoreDefinitions.active, true), isNull(scoreDefinitions.deletedAt)))
        .orderBy(scoreDefinitions.id).for('share');
      if (targets.length > maxGeneration) throw new RangeError('Target count overflow');
      const [article] = await tx.select().from(articles).where(eq(articles.id, articleId)).for('update');
      if (!article) return { kind: 'not_found' as const };
      // Fresh statement after the article lock sees all committed admissions and publications.
      const history = await tx.select().from(processingTasks).where(eq(processingTasks.articleId, article.id))
        .orderBy(processingTasks.id).for('update');
      const prepare = history.find(task => task.id === prepareTaskId.toLowerCase());
      const receipt = prepare && readPreparationReceipt(prepare.result);
      const [content] = await tx.select().from(articleContents).where(eq(articleContents.articleId, article.id)).for('share');
      if (!prepare || prepare.action !== 'prepare' || prepare.state !== 'succeeded' || !receipt ||
          receipt.taskId.toLowerCase() !== prepare.id || receipt.articleId.toLowerCase() !== article.id ||
          receipt.generation !== prepare.generation || receipt.contentRevision !== article.contentRevision ||
          !content || content.revision !== article.contentRevision || content.quality !== 'usable' || !content.text.trim() ||
          history.some(task => task.action === 'prepare' && task.generation > prepare.generation)) return { kind: 'needs_input' as const };

      const next = (action: string, target?: string) => {
        const highest = history.reduce((value, task) => task.action === action && (target === undefined || task.scoreTargetId === target)
          ? Math.max(value, task.generation) : value, 0);
        if (highest >= maxGeneration) throw new RangeError('Task generation overflow');
        return highest + 1;
      };
      const categoryGeneration = next('category');
      const tagsGeneration = next('tags');
      const scoreGenerations = targets.map(target => next('scores', target.id));
      const targetIds = new Set(targets.map(target => target.id));
      const oldIds = history.filter(task => {
        if (!unfinished.includes(task.state)) return false;
        if (task.action === 'category' || task.action === 'tags') return true;
        if (task.action !== 'scores') return false;
        const explicitRoot = task.prerequisiteId === null && (task.result === null || !Object.hasOwn(task.result, 'articleChain'));
        return !explicitRoot || (task.scoreTargetId !== null && targetIds.has(task.scoreTargetId));
      }).map(task => task.id);
      if (oldIds.length) {
        const superseded = await tx.update(processingTasks).set({ state: 'superseded', updatedAt: at, endedAt: at })
          .where(and(inArray(processingTasks.id, oldIds), inArray(processingTasks.state, unfinished)))
          .returning({ id: processingTasks.id, state: processingTasks.state });
        if (superseded.length !== oldIds.length || superseded.some(task => task.state !== 'superseded')) throw new Error('Task supersession failed');
      }

      const categoryTaskId = randomUUID();
      const tagsTaskId = randomUUID();
      const basis = { contentRevision: article.contentRevision, assignmentRevision: article.assignmentRevision,
        articleInputHash: articleFingerprint(article.title, article.sourceId) };
      const root = decodeChainMetadataV1({ version: 1, rootTaskId: categoryTaskId, prepareTaskId: prepare.id, tagsTaskId,
        requiredHandoff: null, requiredBasis: basis, targetCount: targets.length }, 'category');
      const tags = decodeChainMetadataV1({ version: 1, rootTaskId: categoryTaskId, prepareTaskId: prepare.id,
        requiredHandoff: { taskId: categoryTaskId, generation: categoryGeneration, action: 'category' }, requiredBasis: null }, 'tags');
      const score = decodeChainMetadataV1({ version: 1, rootTaskId: categoryTaskId, prepareTaskId: prepare.id,
        requiredHandoff: { taskId: tagsTaskId, generation: tagsGeneration, action: 'tags' }, requiredBasis: null }, 'scores');
      if (!root || !tags || !score) throw new Error('Invalid chain metadata');
      await tx.insert(processingTasks).values({ id: categoryTaskId, articleId: article.id, action: 'category', generation: categoryGeneration,
        state: 'queued', prerequisiteId: prepare.id, result: { articleChain: root }, createdAt: at, updatedAt: at });
      await tx.insert(processingTasks).values({ id: tagsTaskId, articleId: article.id, action: 'tags', generation: tagsGeneration,
        state: 'waiting_dependency', prerequisiteId: categoryTaskId, result: { articleChain: tags }, createdAt: at, updatedAt: at });
      const scoreTaskIds = targets.map(() => randomUUID());
      if (targets.length) await tx.insert(processingTasks).values(targets.map((target, index) => ({ id: scoreTaskIds[index]!,
        articleId: article.id, action: 'scores', scoreTargetId: target.id, generation: scoreGenerations[index]!,
        state: 'waiting_dependency', prerequisiteId: tagsTaskId, result: { articleChain: score }, createdAt: at, updatedAt: at })));
      const jobId = await this.boss.send('category', { taskId: categoryTaskId }, { db: fromDrizzle(tx, sql), retryLimit: 0 });
      if (!jobId || !uuid.test(jobId)) throw new Error('Category job was not enqueued');
      const saved = await tx.update(processingTasks).set({ jobId }).where(eq(processingTasks.id, categoryTaskId)).returning({ id: processingTasks.id, jobId: processingTasks.jobId });
      if (saved.length !== 1 || saved[0]?.jobId !== jobId.toLowerCase()) throw new Error('Category job ID update failed');
      return { kind: 'admitted' as const, categoryTaskId, tagsTaskId, scoreTaskIds };
    }, { isolationLevel: 'read committed' });
  }
}
