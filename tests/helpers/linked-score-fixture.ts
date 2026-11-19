import { randomUUID } from 'node:crypto';
import type { createUsageDatabase } from './usage-database.js';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { CatalogStore } from '../../src/server/adapters/postgres/catalog-store.js';
import { TagTaskInputStore } from '../../src/server/adapters/postgres/tag-task-input-store.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { articleFingerprint } from '../../src/server/domain/article-handoff.js';

// Consumer-only: real receipts precede synthetic scheduling linkage. Not release evidence.
export async function linkedScoreFixture(db: Pick<Awaited<ReturnType<typeof createUsageDatabase>>, 'db' | 'pool'>, context: string, scoreId: string, at: Date) {
  const article = (await db.pool.query("insert into articles(context_id,freshrss_id,title,imported_at) values ($1,$2,'Linked title',now()) returning id", [context, randomUUID()])).rows[0].id as string;
  const tasks = new TaskStore(db.db), catalog = new CatalogStore(db.db);
  const prepare = await tasks.createTask({ articleId: article, action: 'prepare', generation: 1, createdAt: at, updatedAt: at });
  const prepareToken = randomUUID(); await tasks.claimTask(prepare.id, prepareToken, at);
  if (await new ContentStore(db.db).publishTask({ taskId: prepare.id, articleId: article, action: 'prepare', generation: 1, executionToken: prepareToken, expectedContentRevision: 0 }, { kind: 'success', content: { text: 'Linked body', quality: 'usable', capturedAt: at }, at }) !== 1) throw new Error('prepare publication failed');
  const category = await tasks.createTask({ articleId: article, action: 'category', generation: 1, prerequisiteId: prepare.id, createdAt: at, updatedAt: at });
  const categoryToken = randomUUID(); await tasks.claimTask(category.id, categoryToken, at);
  const basis = (await db.pool.query('select category_id,content_revision,assignment_revision,(select revision from catalog_epoch where id=1) epoch from articles where id=$1', [article])).rows[0];
  const categoryPublication = await catalog.publishCategoryCandidate({ taskId: category.id, executionToken: categoryToken, articleId: article, generation: 1, prerequisiteId: prepare.id, contentRevision: basis.content_revision, contentText: 'Linked body', assignmentRevision: basis.assignment_revision, catalogEpoch: basis.epoch, categoryId: basis.category_id }, at);
  if (!categoryPublication) throw new Error('category publication failed');
  const tag = await tasks.createTask({ articleId: article, action: 'tags', generation: 1, prerequisiteId: category.id, createdAt: at, updatedAt: at });
  const tagToken = randomUUID(); await tasks.claimTask(tag.id, tagToken, at);
  await db.pool.query("update model_roles set provider='fake',model='tags' where role='tags'");
  const tagModel = { model: { provider: 'fake', model: 'tags' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: () => 1 };
  const input = await new TagTaskInputStore(db.pool).loadResult(tag.id, tagToken, tagModel, new AbortController().signal);
  if (input.kind !== 'loaded') throw new Error(`tag input: ${input.kind}`);
  const tagPublication = await catalog.publishTagCandidate({ ...input.input.basis, labels: [] }, at);
  if (!tagPublication) throw new Error('tag publication failed');
  const score = await tasks.createTask({ articleId: article, action: 'scores', generation: 1, scoreTargetId: scoreId, prerequisiteId: tag.id, createdAt: at, updatedAt: at });
  const root = { version: 1, rootTaskId: category.id, prepareTaskId: prepare.id, tagsTaskId: tag.id, requiredHandoff: null, requiredBasis: { contentRevision: basis.content_revision, assignmentRevision: basis.assignment_revision, articleInputHash: articleFingerprint('Linked title', null) }, targetCount: 1 };
  const tags = { version: 1, rootTaskId: category.id, prepareTaskId: prepare.id, requiredHandoff: { taskId: category.id, generation: 1, action: 'category' }, requiredBasis: categoryPublication.receipt.basis };
  const consumer = { version: 1, rootTaskId: category.id, prepareTaskId: prepare.id, requiredHandoff: { taskId: tag.id, generation: 1, action: 'tags' }, requiredBasis: tagPublication.receipt.basis };
  for (const [id, chain] of [[category.id, root], [tag.id, tags], [score.id, consumer]] as const) await db.pool.query("update processing_tasks set result=coalesce(result,'{}'::jsonb) || jsonb_build_object('articleChain',$2::jsonb) where id=$1", [id, JSON.stringify(chain)]);
  return { article, prepare, category, tag, score, tasks, root, tags, consumer, tagReceipt: tagPublication.receipt };
}
