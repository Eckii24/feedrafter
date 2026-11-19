import { articleFingerprint, readChainMetadata, readHandoffReceipt, readPreparationReceipt, type ChainMetadataV1, type HandoffReceiptV1, type PreparationReceiptV1 } from '../../domain/article-handoff.js';

export type ScoreHandoff = {
  root: ChainMetadataV1;
  tags: ChainMetadataV1;
  consumer: ChainMetadataV1;
  receipt: HandoffReceiptV1;
  categoryReceipt: HandoffReceiptV1;
  preparationReceipt: PreparationReceiptV1;
  articleInputHash: string;
  contentText: string;
};
type Task = { id: string; articleId: string; action: string; state: string; generation: number; prerequisiteId: string | null; result: unknown };
type Article = { id: string; title: string | null; sourceId: string | null; categoryId: string; contentRevision: number; assignmentRevision: number };
type Reader = { task(id: string): Promise<Task | null>; newer(articleId: string, action: 'prepare' | 'category' | 'tags', generation: number): Promise<boolean>; content(articleId: string): Promise<{ text: string; revision: number } | null> };
const same = (a: string | null, b: string | null) => a?.toLowerCase() === b?.toLowerCase();
const equalBasis = (a: { contentRevision: number; assignmentRevision: number; articleInputHash: string }, b: typeof a) => a.contentRevision === b.contentRevision && a.assignmentRevision === b.assignmentRevision && a.articleInputHash === b.articleInputHash;
const hasChain = (value: unknown) => value !== null && typeof value === 'object' && Object.hasOwn(value, 'articleChain');

/** Read after locking the article and current task. Reader locks each ancestor until commit. */
export async function captureScoreHandoff(score: Task, article: Article, reader: Reader): Promise<{ kind: 'root' } | { kind: 'linked'; value: ScoreHandoff } | { kind: 'invalid_handoff' | 'stale_basis' }> {
  if (!score.prerequisiteId && !hasChain(score.result)) return { kind: 'root' };
  const consumer = readChainMetadata(score.result, 'scores');
  if (!score.prerequisiteId || !consumer || !consumer.requiredHandoff || !consumer.requiredBasis || score.generation < 1) return { kind: 'invalid_handoff' };
  const tag = await reader.task(score.prerequisiteId);
  if (!tag || tag.action !== 'tags' || tag.state !== 'succeeded' || !same(tag.articleId, article.id) || tag.generation < 1 || !same(consumer.requiredHandoff.taskId, tag.id) || consumer.requiredHandoff.generation !== tag.generation || !tag.prerequisiteId) return { kind: 'invalid_handoff' };
  const tags = readChainMetadata(tag.result, 'tags');
  const receipt = readHandoffReceipt(tag.result);
  if (!tags || !tags.requiredHandoff || !tags.requiredBasis || !receipt || receipt.action !== 'tags' || !same(receipt.taskId, tag.id) || !same(receipt.articleId, article.id) || !same(receipt.prerequisiteId, tag.prerequisiteId) || receipt.generation !== tag.generation || !equalBasis(consumer.requiredBasis, receipt.basis)) return { kind: 'invalid_handoff' };
  const category = await reader.task(tag.prerequisiteId);
  if (!category || category.action !== 'category' || category.state !== 'succeeded' || !same(category.articleId, article.id) || category.generation < 1 || !category.prerequisiteId) return { kind: 'invalid_handoff' };
  const root = readChainMetadata(category.result, 'category');
  const categoryReceipt = readHandoffReceipt(category.result);
  if (!root || root.requiredHandoff !== null || !categoryReceipt || categoryReceipt.action !== 'category' || root.targetCount < 1 ||
      !same(root.rootTaskId, category.id) || !same(root.tagsTaskId, tag.id) || !same(root.prepareTaskId, category.prerequisiteId) ||
      !same(tags.rootTaskId, category.id) || !same(tags.prepareTaskId, category.prerequisiteId) ||
      !same(consumer.rootTaskId, category.id) || !same(consumer.prepareTaskId, category.prerequisiteId) ||
      !same(tags.requiredHandoff.taskId, category.id) || tags.requiredHandoff.generation !== category.generation ||
      !same(categoryReceipt.taskId, category.id) || !same(categoryReceipt.articleId, article.id) ||
      !same(categoryReceipt.prerequisiteId, category.prerequisiteId) || categoryReceipt.generation !== category.generation ||
      !equalBasis(tags.requiredBasis, categoryReceipt.basis) ||
      root.requiredBasis.contentRevision !== categoryReceipt.basis.contentRevision || root.requiredBasis.articleInputHash !== categoryReceipt.basis.articleInputHash ||
      categoryReceipt.basis.assignmentRevision < root.requiredBasis.assignmentRevision || categoryReceipt.basis.assignmentRevision - root.requiredBasis.assignmentRevision > 1 ||
      !same(categoryReceipt.categoryId, receipt.categoryId) || receipt.basis.contentRevision !== categoryReceipt.basis.contentRevision ||
      receipt.basis.articleInputHash !== categoryReceipt.basis.articleInputHash || receipt.basis.assignmentRevision < categoryReceipt.basis.assignmentRevision ||
      receipt.basis.assignmentRevision - categoryReceipt.basis.assignmentRevision > 1) return { kind: 'invalid_handoff' };
  const prepare = await reader.task(category.prerequisiteId);
  const preparation = prepare && readPreparationReceipt(prepare.result);
  if (!prepare || prepare.action !== 'prepare' || prepare.state !== 'succeeded' || !same(prepare.articleId, article.id) || !preparation || !same(preparation.taskId, prepare.id) || !same(preparation.articleId, article.id) || preparation.generation !== prepare.generation || preparation.contentRevision !== categoryReceipt.basis.contentRevision) return { kind: 'invalid_handoff' };
  const hash = articleFingerprint(article.title, article.sourceId);
  if (!same(receipt.categoryId, article.categoryId) || receipt.basis.contentRevision !== article.contentRevision || receipt.basis.assignmentRevision !== article.assignmentRevision || receipt.basis.articleInputHash !== hash || await reader.newer(article.id, 'prepare', prepare.generation) || await reader.newer(article.id, 'category', category.generation) || await reader.newer(article.id, 'tags', tag.generation)) return { kind: 'stale_basis' };
  const content = await reader.content(article.id);
  if (!content || content.revision !== article.contentRevision) return { kind: 'stale_basis' };
  return { kind: 'linked', value: { root, tags, consumer, receipt, categoryReceipt, preparationReceipt: preparation, articleInputHash: hash, contentText: content.text } };
}
