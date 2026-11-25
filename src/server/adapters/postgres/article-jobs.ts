import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { articleFingerprint, decodeChainMetadataV1, decodeHandoffReceiptV1, readChainMetadata, readHandoffReceipt, readPreparationReceipt } from '../../domain/article-handoff.js';
import { CatalogStore, RejectTagCandidate, type CategoryCandidate, type CategoryPublication, type TagCandidate, type TagPublication } from './catalog-store.js';
import { enqueueScoreTask } from './score-admission.js';
import type { Database } from './client.js';
import { articleContents, articles, catalogEpoch, categories, processingTasks, scoreDefinitions } from './schema/index.js';

const unfinished = ['waiting_dependency', 'queued', 'running', 'retry_wait', 'paused_budget', 'paused_auth', 'needs_input'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxGeneration = 2147483647;
class RejectCategoryHandoff extends Error {}
class RejectTagHandoff extends Error {}

/** Dormant admission and atomic category/tag handoffs. Queue provisioning and workers are caller responsibilities. */
export class ArticleJobs extends CatalogStore {
  constructor(db: Database, private readonly boss: PgBoss) { super(db); }

  tagKeysFit(labels: string[]) { return new CatalogStore(this.db).tagKeysFit(labels); }

  async publishTagCandidate(candidate: TagCandidate, at: Date): Promise<TagPublication | null> {
    if (!candidate || ![candidate.taskId, candidate.articleId, candidate.prerequisiteTaskId, candidate.categoryId].every(value => typeof value === 'string' && uuid.test(value))) return null;
    try {
      return await this.db.transaction(async tx => {
        // Exclusive from the start: tag creation and release share this lock through commit.
        const [epoch] = await tx.select().from(catalogEpoch).where(eq(catalogEpoch.id, 1)).for('update');
        if (!epoch) throw new Error('Missing catalog epoch');
        const definitions = await tx.select().from(scoreDefinitions).orderBy(scoreDefinitions.id).for('share');
        await tx.select({ id: categories.id }).from(categories).where(eq(categories.id, candidate.categoryId)).for('share');
        if (!await this.lockTagTargets(tx, candidate, at)) return null;
        const [article] = await tx.select().from(articles).where(eq(articles.id, candidate.articleId)).for('update');
        if (!article) return null;
        // Fresh after article lock. Include rewired rows still pointing to this tags task.
        const history = await tx.select().from(processingTasks).where(or(eq(processingTasks.articleId, article.id), eq(processingTasks.prerequisiteId, candidate.taskId)))
          .orderBy(processingTasks.id).for('update');
        const task = history.find(row => row.id === candidate.taskId.toLowerCase());
        const category = history.find(row => row.id === candidate.prerequisiteTaskId.toLowerCase());
        if (!task || !category) return null;
        const chainPresent = Boolean(task.result && Object.hasOwn(task.result, 'articleChain')) || Boolean(category.result && Object.hasOwn(category.result, 'articleChain')) || Boolean(candidate.chainRoot || candidate.chainConsumer);
        if (!chainPresent) return new CatalogStore(this.db).publishTagCandidateInTransaction(tx, candidate, at);
        const root = readChainMetadata(category.result, 'category');
        const tags = readChainMetadata(task.result, 'tags');
        const categoryReceipt = readHandoffReceipt(category.result);
        const prepare = root && history.find(row => row.id === root.prepareTaskId.toLowerCase());
        const preparation = prepare && readPreparationReceipt(prepare.result);
        if (!root || root.requiredHandoff !== null || !tags || !tags.requiredHandoff || !tags.requiredBasis || !categoryReceipt || !prepare || !preparation ||
            task.articleId !== article.id || task.action !== 'tags' || task.state !== 'running' || task.generation < 1 || task.scoreTargetId !== null ||
            category.articleId !== article.id || category.action !== 'category' || category.state !== 'succeeded' || category.generation < 1 ||
            root.rootTaskId.toLowerCase() !== category.id || root.tagsTaskId.toLowerCase() !== task.id || root.prepareTaskId.toLowerCase() !== category.prerequisiteId ||
            task.prerequisiteId !== category.id || tags.rootTaskId.toLowerCase() !== category.id || tags.prepareTaskId.toLowerCase() !== prepare.id ||
            tags.requiredHandoff.taskId.toLowerCase() !== category.id || tags.requiredHandoff.generation !== category.generation ||
            JSON.stringify(candidate.chainRoot && decodeChainMetadataV1(candidate.chainRoot, 'category')) !== JSON.stringify(root) ||
            JSON.stringify(candidate.chainConsumer && decodeChainMetadataV1(candidate.chainConsumer, 'tags')) !== JSON.stringify(tags) ||
            categoryReceipt.action !== 'category' || categoryReceipt.taskId.toLowerCase() !== category.id || categoryReceipt.articleId.toLowerCase() !== article.id ||
            categoryReceipt.generation !== category.generation || categoryReceipt.prerequisiteId?.toLowerCase() !== prepare.id ||
            JSON.stringify(categoryReceipt) !== JSON.stringify(candidate.prerequisiteReceipt) || JSON.stringify(tags.requiredBasis) !== JSON.stringify(categoryReceipt.basis) ||
            root.requiredBasis.contentRevision !== categoryReceipt.basis.contentRevision || root.requiredBasis.articleInputHash !== categoryReceipt.basis.articleInputHash ||
            categoryReceipt.basis.assignmentRevision < root.requiredBasis.assignmentRevision || categoryReceipt.basis.assignmentRevision - root.requiredBasis.assignmentRevision > 1 ||
            categoryReceipt.categoryId.toLowerCase() !== article.categoryId || categoryReceipt.basis.contentRevision !== article.contentRevision ||
            categoryReceipt.basis.assignmentRevision !== article.assignmentRevision || categoryReceipt.basis.articleInputHash !== articleFingerprint(article.title, article.sourceId) ||
            prepare.articleId !== article.id || prepare.action !== 'prepare' || prepare.state !== 'succeeded' || preparation.taskId.toLowerCase() !== prepare.id ||
            preparation.articleId.toLowerCase() !== article.id || preparation.generation !== prepare.generation || preparation.contentRevision !== article.contentRevision ||
            history.some(row => row.articleId === article.id && ((row.action === 'prepare' && row.generation > prepare.generation) ||
              (row.action === 'category' && row.generation > category.generation) || (row.action === 'tags' && row.generation > task.generation)))) throw new RejectTagHandoff();
        const scores = history.filter(row => row.prerequisiteId === task.id || (row.action === 'scores' && readChainMetadata(row.result, 'scores')?.rootTaskId.toLowerCase() === category.id));
        const targetIds = new Set<string>();
        if (scores.length !== root.targetCount) throw new RejectTagHandoff();
        for (const score of scores) {
          const link = readChainMetadata(score.result, 'scores');
          if (score.articleId !== article.id || score.action !== 'scores' || score.prerequisiteId !== task.id || !score.scoreTargetId ||
              targetIds.has(score.scoreTargetId) || score.generation < 1 || !link || !link.requiredHandoff || link.rootTaskId.toLowerCase() !== category.id ||
              link.prepareTaskId.toLowerCase() !== prepare.id || link.requiredHandoff.taskId.toLowerCase() !== task.id || link.requiredHandoff.generation !== task.generation ||
              (score.state === 'waiting_dependency' && (link.requiredBasis !== null || score.jobId !== null)) ||
              (!['waiting_dependency', 'succeeded', 'failed', 'superseded'].includes(score.state))) throw new RejectTagHandoff();
          targetIds.add(score.scoreTargetId);
        }
        const published = await this.publishTagCandidateInternal(tx, candidate, at, true);
        if (!published) return null;
        const receipt = decodeHandoffReceiptV1(published.receipt);
        const [savedTag] = await tx.select().from(processingTasks).where(eq(processingTasks.id, task.id));
        if (!savedTag || savedTag.state !== 'succeeded' || JSON.stringify(readChainMetadata(savedTag.result, 'tags')) !== JSON.stringify(tags) ||
            JSON.stringify(readHandoffReceipt(savedTag.result)) !== JSON.stringify(receipt)) throw new RejectTagHandoff();
        const savedScores = await tx.select().from(processingTasks).where(inArray(processingTasks.id, scores.map(score => score.id))).orderBy(processingTasks.id);
        if (JSON.stringify(savedScores) !== JSON.stringify(scores)) throw new RejectTagHandoff();
        if (!receipt || receipt.action !== 'tags' || receipt.taskId.toLowerCase() !== task.id || receipt.articleId.toLowerCase() !== article.id ||
            receipt.generation !== task.generation || receipt.prerequisiteId?.toLowerCase() !== category.id || receipt.categoryId.toLowerCase() !== article.categoryId ||
            receipt.basis.contentRevision !== article.contentRevision || receipt.basis.assignmentRevision !== published.assignmentRevision ||
            receipt.basis.articleInputHash !== articleFingerprint(article.title, article.sourceId) || receipt.catalogEpoch !== published.catalogEpoch) throw new RejectTagHandoff();
        for (const score of scores) {
          if (score.state !== 'waiting_dependency') continue;
          const definition = definitions.find(row => row.id === score.scoreTargetId);
          const newer = history.some(row => row.articleId === article.id && row.action === 'scores' && row.scoreTargetId === score.scoreTargetId && row.generation > score.generation);
          const reason = !definition || !definition.active || definition.deletedAt ? 'target_unavailable' : newer ? 'newer_generation' : null;
          if (reason) {
            const retired = await tx.update(processingTasks).set({ state: 'superseded', errorCode: reason, updatedAt: at, endedAt: at }).where(and(eq(processingTasks.id, score.id), eq(processingTasks.state, 'waiting_dependency'))).returning();
            if (retired.length !== 1 || retired[0]?.state !== 'superseded' || retired[0]?.errorCode !== reason) throw new Error('Score retirement failed');
            continue;
          }
          const link = readChainMetadata(score.result, 'scores')!;
          const next = decodeChainMetadataV1({ ...link, requiredBasis: receipt.basis }, 'scores');
          if (!next) throw new RejectTagHandoff();
          const activated = await tx.update(processingTasks).set({ state: 'queued', result: { ...score.result, articleChain: next }, updatedAt: at })
            .where(and(eq(processingTasks.id, score.id), eq(processingTasks.state, 'waiting_dependency'), isNull(processingTasks.jobId))).returning();
          if (activated.length !== 1 || activated[0]?.state !== 'queued' || JSON.stringify(readChainMetadata(activated[0]?.result, 'scores')) !== JSON.stringify(next)) throw new Error('Score activation failed');
          const saved = await enqueueScoreTask(tx, this.boss, score.id);
          if (saved.state !== 'queued' || saved.articleId !== article.id || saved.action !== 'scores' || saved.prerequisiteId !== task.id ||
              saved.scoreTargetId !== score.scoreTargetId || saved.generation !== score.generation ||
              JSON.stringify(readChainMetadata(saved.result, 'scores')) !== JSON.stringify(next)) throw new Error('Score job persistence failed');
        }
        return published;
      }, { isolationLevel: 'read committed' });
    } catch (error) {
      if (error instanceof RejectTagHandoff || error instanceof RejectTagCandidate) return null;
      throw error;
    }
  }

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
    return this.admitPreparedArticleInternal(articleId, prepareTaskId, at, false);
  }

  async admitFirstPreparedArticle(articleId: string, prepareTaskId: string, at: Date) {
    return this.admitPreparedArticleInternal(articleId, prepareTaskId, at, true);
  }

  private async admitPreparedArticleInternal(articleId: string, prepareTaskId: string, at: Date, firstTimeOnly: boolean) {
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
      // Explicit retry is the sole exception to first-time history. Never infer that
      // failed attempts did not dispatch; preserve and validate every prior task.
      if (firstTimeOnly) {
        const others = history.filter(task => task.id !== prepareTaskId.toLowerCase());
        const relevant = others.filter(task => ['prepare', 'category', 'tags', 'scores'].includes(task.action));
        if (relevant.length) {
          const marker = prepare?.result?.explicitPreparationRetry;
          const prior = relevant.filter(task => task.action === 'prepare').sort((a, b) => b.generation - a.generation);
          const latest = prior[0];
          if (!marker || typeof marker !== 'object' || Array.isArray(marker) ||
              Object.keys(marker).sort().join(',') !== 'previousTaskId,version' ||
              (marker as Record<string, unknown>).version !== 1 || (marker as Record<string, unknown>).previousTaskId !== latest?.id ||
              !prepare || !latest || prepare.generation !== latest.generation + 1 ||
              prior.length !== relevant.length || prior.some(task => task.state !== 'failed' || !task.endedAt || task.generation < 1) ||
              new Set(prior.map(task => task.generation)).size !== prior.length ||
              others.some(task => unfinished.includes(task.state))) return { kind: 'already_started' as const };
        }
      }
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
