import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { CatalogStore } from '../../src/server/adapters/postgres/catalog-store.js';
import { TagTaskInputStore } from '../../src/server/adapters/postgres/tag-task-input-store.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { assignTags } from '../../src/server/application/assign-tags.js';
import type { AiPort } from '../../src/server/ports/ai.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let context: string;
const at = new Date('2026-01-02T03:04:05Z');
const model = { model: { provider: 'fake', model: 'tags' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: () => 1 };
beforeAll(async () => {
  db = await createUsageDatabase(); await migrateDatabase(db.pool);
  context = (await db.pool.query("insert into import_contexts(instance,account) values ('tags-races','test') returning id")).rows[0].id;
  await db.pool.query("update model_roles set provider='fake',model='tags' where role='tags'");
}, 30000);
afterAll(async () => { if (db) await db.dispose(); });
async function fixture() {
  const article = (await db.pool.query("insert into articles(context_id,freshrss_id,title,imported_at) values ($1,$2,'Title',now()) returning id", [context, randomUUID()])).rows[0].id as string;
  await new ContentStore(db.db).saveSuccessful(article, { text: 'Body', quality: 'usable', capturedAt: at });
  const tasks = new TaskStore(db.db), catalog = new CatalogStore(db.db);
  const prepare = await tasks.createTask({ articleId: article, action: 'prepare', generation: 1, state: 'succeeded', createdAt: at, updatedAt: at });
  const category = await tasks.createTask({ articleId: article, action: 'category', generation: 1, prerequisiteId: prepare.id, createdAt: at, updatedAt: at });
  const categoryToken = randomUUID(); await tasks.claimTask(category.id, categoryToken, at);
  const basis = (await db.pool.query('select category_id,content_revision,assignment_revision,(select revision from catalog_epoch where id=1) as epoch from articles where id=$1', [article])).rows[0];
  expect(await catalog.publishCategoryCandidate({ taskId: category.id, executionToken: categoryToken, articleId: article, generation: 1, prerequisiteId: prepare.id, contentRevision: basis.content_revision, contentText: 'Body', assignmentRevision: basis.assignment_revision, catalogEpoch: basis.epoch, categoryId: basis.category_id }, at)).not.toBeNull();
  const task = await tasks.createTask({ articleId: article, action: 'tags', generation: 1, prerequisiteId: category.id, createdAt: at, updatedAt: at });
  const token = randomUUID(); await tasks.claimTask(task.id, token, at);
  const label = `candidate-${randomUUID()}`;
  const ai = { generate: vi.fn<AiPort['generate']>().mockResolvedValue({ kind: 'completed', value: { text: JSON.stringify({ tags: [label] }), usage: null } }), classify: vi.fn<AiPort['classify']>(), createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() };
  const deps = { ai, inputs: new TagTaskInputStore(db.pool), catalog, tasks, model, signal: new AbortController().signal, now: () => at };
  return { article, prepare, category, task, token, label, deps, run: () => assignTags(task.id, token, deps) };
}

it.each(['category', 'prepare', 'content', 'new category'])('holds %s fence through publication commit', async target => {
  const f = await fixture(); const blocker = await db.pool.connect();
  let pending: Promise<unknown> | undefined, mutation: Promise<unknown> | undefined;
  try {
    await blocker.query('begin'); await blocker.query('select pg_advisory_xact_lock(712346, 99)');
    await db.pool.query(`create function tag_commit_barrier() returns trigger language plpgsql as $$ begin if new.id = '${f.task.id}'::uuid and new.state='succeeded' then perform pg_advisory_xact_lock(712346, 99); end if; return new; end $$`);
    await db.pool.query('create trigger tag_commit_barrier before update on processing_tasks for each row execute function tag_commit_barrier()');
    pending = f.run();
    let publisherPid = 0;
    for (let i = 0; i < 100 && !publisherPid; i++) {
      const rows = await db.pool.query<{ pid: number }>("select pid from pg_stat_activity where datname=current_database() and wait_event='advisory' and query like '%processing_tasks%'");
      publisherPid = rows.rows[0]?.pid ?? 0;
      if (!publisherPid) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(publisherPid).not.toBe(0);
    if (target === 'category') mutation = db.pool.query("update processing_tasks set state='failed' where id=$1", [f.category.id]);
    if (target === 'prepare') mutation = db.pool.query("update processing_tasks set state='failed' where id=$1", [f.prepare.id]);
    if (target === 'content') mutation = db.pool.query("update article_contents set quality='unusable' where article_id=$1", [f.article]);
    if (target === 'new category') mutation = f.deps.tasks.createTask({ articleId: f.article, action: 'category', generation: 2, state: 'failed', createdAt: at, updatedAt: at });
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const rows = await db.pool.query<{ waiting: boolean }>('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting', [publisherPid]);
      waiting = rows.rows[0]!.waiting; if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await blocker.query('commit'); expect(await pending).toEqual({ kind: 'published' }); await mutation;
    expect(await f.deps.tasks.getTask(f.task.id)).toMatchObject({ state: 'succeeded' });
  } finally {
    await blocker.query('rollback'); await Promise.allSettled([...(pending ? [pending] : []), ...(mutation ? [mutation] : [])]);
    await db.pool.query('drop trigger if exists tag_commit_barrier on processing_tasks'); await db.pool.query('drop function if exists tag_commit_barrier()'); blocker.release();
  }
}, 15000);

it('rolls back label and association when task success fails', async () => {
  const f = await fixture();
  await db.pool.query(`create function fail_tag_kernel_success() returns trigger language plpgsql as $$ begin if new.id = '${f.task.id}'::uuid and new.state='succeeded' then raise exception 'test failure'; end if; return new; end $$`);
  await db.pool.query('create trigger fail_tag_kernel_success before update on processing_tasks for each row execute function fail_tag_kernel_success()');
  try {
    await expect(f.run()).rejects.toThrow('Tag publication failed');
    expect((await db.pool.query('select id from tags where label=$1', [f.label])).rowCount).toBe(0);
    expect(await f.deps.catalog.listArticleTags(f.article)).toHaveLength(0);
    expect(await f.deps.tasks.getTask(f.task.id)).toMatchObject({ state: 'running' });
  } finally { await db.pool.query('drop trigger fail_tag_kernel_success on processing_tasks'); await db.pool.query('drop function fail_tag_kernel_success()'); }
});
