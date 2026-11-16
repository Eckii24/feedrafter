import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { CatalogStore } from '../../src/server/adapters/postgres/catalog-store.js';
import { CategoryTaskInputStore } from '../../src/server/adapters/postgres/category-task-input-store.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { categorize } from '../../src/server/application/categorize.js';
import { fallbackCategoryId } from '../../src/shared/taxonomy.js';
import type { AiPort } from '../../src/server/ports/ai.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let context: string;
const at = new Date('2026-01-02T03:04:05Z');
const model = { model: { provider: 'fake', model: 'classifier' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: () => 1 };
beforeAll(async () => {
  db = await createUsageDatabase(); await migrateDatabase(db.pool);
  context = (await db.pool.query("insert into import_contexts(instance,account) values ('category-races','test') returning id")).rows[0].id;
  await db.pool.query("update model_roles set provider='fake',model='classifier' where role='category'");
}, 30000);
afterAll(async () => { if (db) await db.dispose(); });
async function fixture() {
  const article = (await db.pool.query("insert into articles(context_id,freshrss_id,title,imported_at) values ($1,$2,'Title',now()) returning id", [context, randomUUID()])).rows[0].id as string;
  await new ContentStore(db.db).saveSuccessful(article, { text: 'Body', quality: 'usable', capturedAt: at });
  const tasks = new TaskStore(db.db); const catalog = new CatalogStore(db.db);
  const task = await tasks.createTask({ articleId: article, action: 'category', generation: 1, state: 'queued', createdAt: at, updatedAt: at });
  const token = randomUUID(); await tasks.claimTask(task.id, token, at);
  const chosen = (await db.pool.query('select id from categories where archived_at is null and id<>$1 order by id limit 1', [fallbackCategoryId])).rows[0].id as string;
  const classify = vi.fn<AiPort['classify']>().mockImplementation(async request => {
    const q = request.questions.category!; if (q.type !== 'choice') throw new Error('choice required');
    return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: chosen, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(id => [id, id === chosen ? 1 : 0])) } }, usage: null } };
  });
  const deps = { ai: { classify, generate: vi.fn<AiPort['generate']>(), createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() }, inputs: new CategoryTaskInputStore(db.pool), catalog, tasks, model, signal: new AbortController().signal, now: () => at };
  const run = () => categorize(task.id, token, deps);
  const record = async () => ({ task: await tasks.getTask(task.id), article: (await db.pool.query('select category_id,assignment_revision from articles where id=$1', [article])).rows[0] });
  return { article, task, token, chosen, deps, run, record };
}

it('offers only active categories including fallback', async () => {
  const f = await fixture();
  const archived = await f.deps.catalog.createCategory('Archived for category test');
  await f.deps.catalog.archiveCategory(archived.id, at);
  expect(await f.run()).toEqual({ kind: 'published' });
  const request = f.deps.ai.classify.mock.calls[0]![0];
  const question = request.questions.category!;
  if (question.type !== 'choice') throw new Error('choice required');
  const active = await db.pool.query('select id,label from categories where archived_at is null order by id');
  expect(question.criteria).toEqual(Object.fromEntries(active.rows.map(row => [row.id, row.label])));
  expect(question.criteria).toHaveProperty(fallbackCategoryId);
  expect(question.criteria).not.toHaveProperty(archived.id);
});

it.each(['ownership', 'newer', 'catalog', 'content'])('fences %s change during inference', async change => {
  const f = await fixture();
  const original = f.deps.ai.classify.getMockImplementation()!;
  f.deps.ai.classify.mockImplementation(async (request, scope) => {
    if (change === 'ownership') await db.pool.query('update processing_tasks set execution_token=$2 where id=$1', [f.task.id, randomUUID()]);
    if (change === 'newer') await f.deps.tasks.createTask({ articleId: f.article, action: 'category', generation: 2, state: 'failed', createdAt: at, updatedAt: at });
    if (change === 'catalog') await f.deps.catalog.createCategory(`New ${randomUUID()}`);
    if (change === 'content') await new ContentStore(db.db).saveSuccessful(f.article, { text: 'Changed', quality: 'usable', capturedAt: at });
    return original(request, scope);
  });
  expect(await f.run()).toEqual({ kind: change === 'ownership' ? 'ownership_lost' : 'superseded' });
  const row = await f.record();
  expect(row.article.category_id).toBe(fallbackCategoryId);
  expect(row.task?.state).toBe(change === 'ownership' ? 'running' : 'superseded');
});

it.each(['rewire', 'prerequisite state', 'quality', 'text', 'missing content'])('rejects %s after capture', async change => {
  const f = await fixture();
  const prerequisite = await f.deps.tasks.createTask({ articleId: f.article, action: 'prepare', generation: 1, state: 'succeeded', createdAt: at, updatedAt: at });
  await db.pool.query('update processing_tasks set prerequisite_id=$2 where id=$1', [f.task.id, prerequisite.id]);
  const original = f.deps.ai.classify.getMockImplementation()!;
  f.deps.ai.classify.mockImplementation(async (request, scope) => {
    if (change === 'rewire') await db.pool.query('update processing_tasks set prerequisite_id=null where id=$1', [f.task.id]);
    if (change === 'prerequisite state') await db.pool.query("update processing_tasks set state='failed' where id=$1", [prerequisite.id]);
    if (change === 'quality') await db.pool.query("update article_contents set quality='unusable' where article_id=$1", [f.article]);
    if (change === 'text') await db.pool.query("update article_contents set text='Changed without revision' where article_id=$1", [f.article]);
    if (change === 'missing content') await db.pool.query('delete from article_contents where article_id=$1', [f.article]);
    return original(request, scope);
  });
  expect(await f.run()).toEqual({ kind: 'superseded' });
  expect((await f.record()).article.category_id).toBe(fallbackCategoryId);
});

it('rejects a root rewired to a successful prerequisite after capture', async () => {
  const f = await fixture();
  const prerequisite = await f.deps.tasks.createTask({ articleId: f.article, action: 'prepare', generation: 1, state: 'succeeded', createdAt: at, updatedAt: at });
  const original = f.deps.ai.classify.getMockImplementation()!;
  f.deps.ai.classify.mockImplementation(async (request, scope) => {
    await db.pool.query('update processing_tasks set prerequisite_id=$2 where id=$1', [f.task.id, prerequisite.id]);
    return original(request, scope);
  });
  expect(await f.run()).toEqual({ kind: 'superseded' });
  expect((await f.record()).article.category_id).toBe(fallbackCategoryId);
});

it.each(['prerequisite', 'content'])('holds %s eligibility through commit', async target => {
  const f = await fixture();
  const prerequisite = await f.deps.tasks.createTask({ articleId: f.article, action: 'prepare', generation: 1, state: 'succeeded', createdAt: at, updatedAt: at });
  await db.pool.query('update processing_tasks set prerequisite_id=$2 where id=$1', [f.task.id, prerequisite.id]);
  const blocker = await db.pool.connect();
  let pending: Promise<unknown> | undefined;
  let mutation: Promise<unknown> | undefined;
  try {
    await blocker.query('begin');
    await blocker.query('select pg_advisory_xact_lock(712345, 99)');
    await db.pool.query(`create function category_commit_barrier() returns trigger language plpgsql as $$ begin if new.id = '${f.task.id}'::uuid and new.state='succeeded' then perform pg_advisory_xact_lock(712345, 99); end if; return new; end $$`);
    await db.pool.query('create trigger category_commit_barrier before update on processing_tasks for each row execute function category_commit_barrier()');
    pending = f.run();
    let publisherPid = 0;
    for (let i = 0; i < 100 && !publisherPid; i++) {
      const rows = await db.pool.query<{ pid: number }>("select pid from pg_stat_activity where datname=current_database() and wait_event='advisory' and query like '%processing_tasks%'");
      publisherPid = rows.rows[0]?.pid ?? 0;
      if (!publisherPid) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(publisherPid).not.toBe(0);
    mutation = target === 'prerequisite'
      ? db.pool.query("update processing_tasks set state='failed' where id=$1", [prerequisite.id])
      : db.pool.query("update article_contents set quality='unusable' where article_id=$1", [f.article]);
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const rows = await db.pool.query<{ waiting: boolean }>('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting', [publisherPid]);
      waiting = rows.rows[0]!.waiting;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await blocker.query('commit');
    expect(await pending).toEqual({ kind: 'published' });
    await mutation;
    expect((await f.record()).task?.state).toBe('succeeded');
  } finally {
    await blocker.query('rollback');
    await Promise.allSettled([...(pending ? [pending] : []), ...(mutation ? [mutation] : [])]);
    await db.pool.query('drop trigger if exists category_commit_barrier on processing_tasks');
    await db.pool.query('drop function if exists category_commit_barrier()');
    blocker.release();
  }
});

it('does not publish if aborted after the completed call', async () => {
  const f = await fixture();
  const controller = new AbortController();
  f.deps.signal = controller.signal;
  const publish = vi.spyOn(f.deps.catalog, 'publishCategoryCandidate');
  const original = f.deps.ai.classify.getMockImplementation()!;
  f.deps.ai.classify.mockImplementation(async (request, scope) => { const result = await original(request, scope); controller.abort(); return result; });
  expect(await f.run()).toEqual({ kind: 'failed' });
  expect((await f.record()).task).toMatchObject({ state: 'failed', errorCode: 'cancelled_before_publication' });
  expect(publish).not.toHaveBeenCalled();
  expect(f.deps.ai.classify).toHaveBeenCalledOnce();
});

it('does not undo publication when aborted after publisher entry', async () => {
  const f = await fixture();
  const controller = new AbortController();
  f.deps.signal = controller.signal;
  const publish = f.deps.catalog.publishCategoryCandidate.bind(f.deps.catalog);
  f.deps.catalog.publishCategoryCandidate = async (...args) => { controller.abort(); return publish(...args); };
  expect(await f.run()).toEqual({ kind: 'published' });
  expect((await f.record()).task?.state).toBe('succeeded');
});

it('sees a newer generation committed while the loader waits for the article lock', async () => {
  const f = await fixture();
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    await client.query('select id from articles where id=$1 for update', [f.article]);
    await client.query("insert into processing_tasks(article_id,action,generation,state,created_at,updated_at) values ($1,'category',2,'failed',$2,$2)", [f.article, at]);
    const pending = f.run();
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      const result = await db.pool.query<{ waiting: boolean }>("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting", [pid]);
      blocked = result.rows[0]!.waiting;
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    await client.query('commit');
    expect(await pending).toEqual({ kind: 'superseded' });
    expect(f.deps.ai.classify).not.toHaveBeenCalled();
  } finally { await client.query('rollback'); client.release(); }
});

it('rolls back assignment when task success update fails', async () => {
  const f = await fixture();
  await db.pool.query(`create function reject_category_success() returns trigger language plpgsql as $$ begin if new.id = '${f.task.id}'::uuid and new.state='succeeded' then raise exception 'fixture'; end if; return new; end $$`);
  await db.pool.query('create trigger reject_category_success before update on processing_tasks for each row execute function reject_category_success()');
  try {
    await expect(f.run()).rejects.toThrow('Category publication failed');
    const row = await f.record();
    expect(row.task?.state).toBe('running');
    expect(row.article).toMatchObject({ category_id: fallbackCategoryId, assignment_revision: 0 });
  } finally {
    await db.pool.query('drop trigger reject_category_success on processing_tasks');
    await db.pool.query('drop function reject_category_success()');
  }
});
