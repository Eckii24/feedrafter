import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ContentStore, type ContentExecutionContext } from '../../src/server/adapters/postgres/content-store.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { prepareArticle } from '../../src/server/application/prepare-article.js';
import type { SourceFallbackPermission } from '../../src/server/ports/source-fallback-permission.js';
import { readPreparationReceipt } from '../../src/server/domain/article-handoff.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();
let container = '';
let database: ReturnType<typeof createDatabase>;
let articleId: string;
const at = new Date('2026-01-01Z');
const original = { text: 'original', quality: 'limited', sourceUrl: 'https://example.test', limitation: 'partial', failureCode: 'fetch', capturedAt: at };
const replacement = { text: 'replacement', quality: 'usable', capturedAt: at };

beforeAll(async () => {
  container = docker('run', '--detach', '--rm', '--pull=never', '--name', `feedrafter-publication-${randomUUID()}`, '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
  const port = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'));
  if (!port) throw new Error('Unexpected PostgreSQL port');
  database = createDatabase(`postgresql://postgres:disposable-test-only@127.0.0.1:${port[1]}/feedrafter_test`);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await database.pool.query('select 1'); ready = true; break; } catch { await delay(200); }
  }
  if (!ready) throw new Error('PostgreSQL not ready');
  await migrateDatabase(database.pool);
  const context = await database.pool.query<{ id: string }>("insert into import_contexts(instance, account) values ('test', 'test') returning id");
  const article = await database.pool.query<{ id: string }>("insert into articles(context_id, freshrss_id, imported_at) values ($1, 'test', now()) returning id", [context.rows[0]!.id]);
  articleId = article.rows[0]!.id;
}, 30000);

afterAll(async () => {
  try { if (database) await database.close(); } finally { if (container) docker('rm', '--force', container); }
});

async function fixture() {
  const id = (await database.pool.query<{ id: string }>('insert into articles(context_id, freshrss_id, imported_at) select context_id, $2, now() from articles where id=$1 returning id', [articleId, randomUUID()])).rows[0]!.id;
  const content = new ContentStore(database.db);
  const tasks = new TaskStore(database.db);
  await content.saveSuccessful(id, original);
  async function admit(generation: number) {
    const task = await tasks.createTask({ articleId: id, action: 'prepare', generation, createdAt: at, updatedAt: at });
    const executionToken = randomUUID();
    await tasks.claimTask(task.id, executionToken, at);
    const context: ContentExecutionContext = { taskId: task.id, articleId: id, action: 'prepare', generation, executionToken, expectedContentRevision: 1 };
    return context;
  }
  async function snapshot() {
    return (await database.pool.query('select a.content_revision, c.* from articles a join article_contents c on c.article_id=a.id where a.id=$1', [id])).rows[0];
  }
  return { id, content, tasks, admit, snapshot };
}

describe('atomic content task publication', () => {
  it('fences both outcomes after newer admission even if the newer task failed', async () => {
    const f = await fixture();
    const older = await f.admit(1);
    const before = await f.snapshot();
    const newer = await f.admit(2);
    expect(await f.content.publishTask(newer, { kind: 'failure', errorCode: 'fetch_failed', at })).toBe(1);
    expect(await f.content.publishTask(older, { kind: 'success', content: replacement, at })).toBeNull();
    expect(await f.content.publishTask(older, { kind: 'failure', errorCode: 'stale', at })).toBeNull();
    expect(await f.snapshot()).toEqual(before);
    expect(await f.tasks.getTask(older.taskId)).toMatchObject({ state: 'running', errorCode: null });
    expect(await f.tasks.getTask(newer.taskId)).toMatchObject({ state: 'failed', errorCode: 'fetch_failed' });
  });

  it('rejects reclaimed tokens, changed revision, wrong identity, action, generation and state', async () => {
    const f = await fixture();
    const ctx = await f.admit(1);
    const before = await f.snapshot();
    await database.pool.query("update processing_tasks set state='retry_wait' where id=$1", [ctx.taskId]);
    const token = randomUUID();
    await f.tasks.claimTask(ctx.taskId, token, at);
    const outcome = { kind: 'success' as const, content: replacement, at };
    for (const bad of [ctx, { ...ctx, executionToken: token, expectedContentRevision: 0 }, { ...ctx, executionToken: token, articleId: articleId }, { ...ctx, executionToken: token, action: 'other' as 'prepare' }, { ...ctx, executionToken: token, generation: 2 }, { ...ctx, executionToken: token, taskId: randomUUID() }]) {
      expect(await f.content.publishTask(bad, outcome)).toBeNull();
      expect(await f.content.publishTask(bad, { kind: 'failure', errorCode: 'bad', at })).toBeNull();
    }
    await database.pool.query("update processing_tasks set state='queued' where id=$1", [ctx.taskId]);
    expect(await f.content.publishTask({ ...ctx, executionToken: token }, outcome)).toBeNull();
    expect(await f.snapshot()).toEqual(before);
    expect(await f.tasks.getTask(ctx.taskId)).toMatchObject({ state: 'queued', attemptCount: 2 });
  });

  it('rejects a running task with no execution token and mismatched task identity', async () => {
    const f = await fixture();
    const ctx = await f.admit(1);
    const other = await fixture();
    const wrongArticle = await other.admit(1);
    const wrongAction = await f.tasks.createTask({ articleId: f.id, action: 'other', generation: 1, state: 'running', executionToken: ctx.executionToken, createdAt: at, updatedAt: at });
    await database.pool.query('update processing_tasks set execution_token=null where id=$1', [ctx.taskId]);
    const before = await f.snapshot();
    for (const bad of [{ ...ctx, executionToken: null as unknown as string }, { ...ctx, taskId: wrongArticle.taskId, executionToken: wrongArticle.executionToken }, { ...ctx, taskId: wrongAction.id }]) {
      expect(await f.content.publishTask(bad, { kind: 'success', content: replacement, at })).toBeNull();
      expect(await f.content.publishTask(bad, { kind: 'failure', errorCode: 'bad', at })).toBeNull();
    }
    expect(await f.snapshot()).toEqual(before);
    expect(await f.tasks.getTask(ctx.taskId)).toMatchObject({ state: 'running', errorCode: null });
  });

  it('rejects both outcomes after an independent content revision change', async () => {
    const f = await fixture();
    const ctx = await f.admit(1);
    expect(await f.content.saveSuccessful(f.id, replacement)).toBe(2);
    const before = await f.snapshot();
    expect(await f.content.publishTask(ctx, { kind: 'success', content: original, at })).toBeNull();
    expect(await f.content.publishTask(ctx, { kind: 'failure', errorCode: 'stale', at })).toBeNull();
    expect(await f.snapshot()).toEqual(before);
    expect(await f.tasks.getTask(ctx.taskId)).toMatchObject({ state: 'running', errorCode: null });
  });

  it('commits valid success and clears old provenance at the same revision', async () => {
    const f = await fixture();
    const ctx = await f.admit(1);
    await database.pool.query('update processing_tasks set result=$2 where id=$1', [ctx.taskId, { unrelated: { keep: true } }]);
    expect(await f.content.publishTask(ctx, { kind: 'success', content: replacement, at })).toBe(2);
    expect(await f.snapshot()).toMatchObject({ content_revision: 2, revision: 2, text: 'replacement', quality: 'usable', source_url: null, limitation: null, failure_code: null });
    const task = await f.tasks.getTask(ctx.taskId);
    expect(task).toMatchObject({ state: 'succeeded', endedAt: at, errorCode: null, attemptCount: 1, result: { unrelated: { keep: true } } });
    expect(readPreparationReceipt(task?.result)).toEqual({ version: 1, taskId: ctx.taskId, articleId: f.id, action: 'prepare', generation: 1, contentRevision: 2 });
    expect(await f.content.publishTask(ctx, { kind: 'failure', errorCode: 'late', at })).toBeNull();
  });

  it('does not synthesize missing or malformed receipts on legacy successes', async () => {
    const f = await fixture();
    for (const result of [null, { preparationReceipt: { version: 0 }, keep: true }]) {
      const task = await f.tasks.createTask({ articleId: f.id, action: 'prepare', generation: 0, state: 'succeeded', result, createdAt: at, updatedAt: at });
      const before = await f.tasks.getTask(task.id);
      expect(readPreparationReceipt(before?.result)).toBeNull();
      expect(await f.tasks.getTask(task.id)).toEqual(before);
    }
  });

  it('preserves task metadata on failure and rollback at commit', async () => {
    const f = await fixture();
    const failed = await f.admit(1);
    const metadata = { keep: { nested: 1 }, preparationReceipt: { legacy: true } };
    await database.pool.query('update processing_tasks set result=$2 where id=$1', [failed.taskId, metadata]);
    const before = await f.snapshot();
    expect(await f.content.publishTask(failed, { kind: 'failure', errorCode: 'failure', at })).toBe(1);
    expect(await f.snapshot()).toEqual(before);
    expect(await f.tasks.getTask(failed.taskId)).toMatchObject({ state: 'failed', result: metadata });
    const ctx = await f.admit(2);
    await database.pool.query('update processing_tasks set result=$2 where id=$1', [ctx.taskId, metadata]);
    const taskBefore = await f.tasks.getTask(ctx.taskId);
    await database.pool.query("create function reject_receipt_commit() returns trigger language plpgsql as $$ begin if new.state='succeeded' then raise exception 'deferred receipt failure'; end if; return new; end $$; create constraint trigger reject_receipt_commit after update on processing_tasks deferrable initially deferred for each row execute function reject_receipt_commit()");
    try {
      await expect(f.content.publishTask(ctx, { kind: 'success', content: replacement, at })).rejects.toThrow();
      expect(await f.snapshot()).toEqual(before);
      expect(await f.tasks.getTask(ctx.taskId)).toEqual(taskBefore);
    } finally {
      await database.pool.query('drop trigger reject_receipt_commit on processing_tasks; drop function reject_receipt_commit()');
    }
  });

  it('rolls back content and revision when the task transition fails', async () => {
    const f = await fixture();
    const ctx = await f.admit(1);
    const before = await f.snapshot();
    await database.pool.query("create function reject_success() returns trigger language plpgsql as $$ begin if new.state='succeeded' then raise exception 'injected failure'; end if; return new; end $$; create trigger reject_success before update on processing_tasks for each row execute function reject_success()");
    try {
      await expect(f.content.publishTask(ctx, { kind: 'success', content: replacement, at })).rejects.toThrow();
      expect(await f.snapshot()).toEqual(before);
      expect(await f.tasks.getTask(ctx.taskId)).toMatchObject({ state: 'running', endedAt: null, errorCode: null });
      await expect(f.content.publishTask(ctx, { kind: 'success', content: { ...replacement, text: '' }, at })).rejects.toThrow('invalid content');
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await database.pool.query('drop trigger reject_success on processing_tasks; drop function reject_success()');
    }
  });

  it('preparation preserves real content for failed and stale executions', async () => {
    const f = await fixture();
    const older = await f.admit(1);
    const before = await f.snapshot();
    const deps = {
      content: f.content,
      web: { get: async () => ({ finalUrl: 'https://example.com/a', status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<html><body><article><p>${'Detailed factual reporting. '.repeat(80)}</p></article></body></html>`) }) },
      classifier: { classify: async () => ({ probability: 0.1, usable: false }) },
      now: () => at,
    };
    const newer = await f.admit(2);
    expect((await prepareArticle(deps, { context: newer, originalUrl: 'https://example.com/a' })).status).toBe('failed');
    expect(await f.snapshot()).toEqual(before);
    deps.classifier.classify = async () => ({ probability: 0.9, usable: true });
    expect((await prepareArticle(deps, { context: older, originalUrl: 'https://example.com/a' })).status).toBe('stale');
    expect(await f.snapshot()).toEqual(before);
    expect(await f.tasks.getTask(newer.taskId)).toMatchObject({ state: 'failed', errorCode: 'content_unusable' });
    expect(await f.tasks.getTask(older.taskId)).toMatchObject({ state: 'running' });
    const latest = await f.admit(3);
    expect(await prepareArticle(deps, { context: latest, originalUrl: 'https://example.com/a' })).toEqual({ status: 'succeeded', revision: 2 });
    expect(await f.snapshot()).toMatchObject({ content_revision: 2, revision: 2, quality: 'usable', source_url: 'https://example.com/a' });
    expect(await f.tasks.getTask(latest.taskId)).toMatchObject({ state: 'succeeded' });
  });

  it.each(['paywall', '403', 'charset'])('preserves real content and revision on %s rejection', async scenario => {
    const f = await fixture();
    const ctx = await f.admit(1);
    const before = await f.snapshot();
    const article = `<html><body><article><p>${'Detailed factual reporting. '.repeat(80)}</p></article></body></html>`;
    const fetched: string[] = [];
    const web = { get: async (url: string) => {
      fetched.push(url);
      return {
        finalUrl: url, status: url.includes('/fallback') && scenario === '403' ? 403 : 200,
        headers: { 'content-type': scenario === 'charset' ? 'text/html; charset=iso-8859-1' : 'text/html' },
        body: Buffer.from(url.includes('/fallback') && scenario === 'paywall' ? '<html><body>Subscription required</body></html>' : article),
      };
    } };
    let classifications = 0;
    const classifier = { classify: async () => ++classifications === 1 ? { probability: 0.1, usable: false } : { probability: 0.9, usable: true } };
    const fallback = { extract: async ({ webFetch }: { webFetch: (url: string) => Promise<unknown> }) => {
      await webFetch('https://example.com/fallback').catch(() => {});
      return { text: article, sourceUrl: 'https://example.com/article' };
    } };
    const permission: SourceFallbackPermission = { resolveForArticle: async (id, hostname) => id === f.id && hostname === 'example.com', resolveHost: async () => false };
    expect(await prepareArticle({ content: f.content, web, classifier, fallback, permission, now: () => at }, { context: ctx, originalUrl: 'https://example.com/article' })).toEqual({ status: 'failed', revision: 1 });
    expect(fetched).toEqual(scenario === 'charset' ? ['https://example.com/article'] : ['https://example.com/article', 'https://example.com/fallback']);
    expect(await f.snapshot()).toEqual(before);
    expect(await f.tasks.getTask(ctx.taskId)).toMatchObject({ state: 'failed', errorCode: scenario === 'charset' ? 'unsupported_encoding' : 'access_denied' });
  });

  it('serializes task admission with publication on the article lock', async () => {
    const f = await fixture();
    const older = await f.admit(1);
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      await client.query('select id from articles where id=$1 for update', [f.id]);
      const newer = f.admit(2);
      let admitted = false;
      void newer.then(() => { admitted = true; });
      await delay(100);
      expect(admitted).toBe(false);
      await client.query('commit');
      await newer;
      expect(await f.content.publishTask(older, { kind: 'success', content: replacement, at })).toBeNull();
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
