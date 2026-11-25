import { expect, it } from 'vitest';
import { ImportJobs, runImport } from '../../src/server/adapters/postgres/import-jobs.js';
import { provisionImportQueues } from '../../src/server/adapters/postgres/import-runner.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { PgBoss } from 'pg-boss';
import * as automatic from '../../src/server/adapters/postgres/import-jobs.js';
import { provisionArticleQueues } from '../../src/server/adapters/postgres/article-worker.js';
import { provisionScoreQueue } from '../../src/server/adapters/postgres/score-admission.js';
import { articleProcessingFixture, eventually } from '../helpers/article-processing-fixture.js';
import { FreshRssClient } from '../../src/server/adapters/freshrss/client.js';
import { startImportWorkers } from '../../src/server/adapters/postgres/import-runner.js';

it('atomically persists opt-in processing intent with an imported article, but not for an ordinary import', async () => {
  const f = await createUsageDatabase();
  const boss = new PgBoss({ connectionString: f.pool.options.connectionString! }); boss.on('error', () => {});
  try {
    await migrateDatabase(f.pool); await boss.start(); await provisionImportQueues(boss); await provisionArticleQueues(boss); await provisionScoreQueue(boss);
    const store = new ImportStore(f.db);
    const context = await store.ensureContext('synthetic-auto-import', 'fixture');
    const fresh = { async listUnreadPage() { return { items: [{ id: 'article-a', title: 'Synthetic', url: 'https://example.com/a', author: null, publishedAt: null, feedId: null, feedTitle: null }], continuation: null }; }, async getReadState() { return new Map([['article-a', true]]); }, async markRead() {} };
    const first = await new ImportJobs(f.db, boss).startImport(context.id);
    await runImport(f.pool, first.run.id, fresh, { lastAttempt: true, automaticProcessing: true });
    const tasks = await f.pool.query("select t.action, t.state, t.result from processing_tasks t join articles a on a.id=t.article_id where a.freshrss_id='article-a'");
    expect(tasks.rows).toEqual([{ action: 'prepare', state: 'queued', result: { automaticImport: { version: 1 } } }]);
    const second = await new ImportJobs(f.db, boss).startImport(context.id);
    await runImport(f.pool, second.run.id, fresh, { lastAttempt: true, automaticProcessing: true });
    expect((await f.pool.query("select count(*)::int as n from processing_tasks where action='prepare'")).rows[0].n).toBe(1);
    const other = await store.ensureContext('synthetic-disabled', 'fixture');
    const third = await new ImportJobs(f.db, boss).startImport(other.id);
    await runImport(f.pool, third.run.id, fresh, { lastAttempt: true });
    expect((await f.pool.query('select count(*)::int as n from processing_tasks t join articles a on a.id=t.article_id where a.context_id=$1', [other.id])).rows[0].n).toBe(0);

    const body = Buffer.from(`<html><body><article><h1>Report</h1><p>${'A synthetic report with useful factual details. '.repeat(50)}</p></article></body></html>`);
    const deps = { db: f.db, pool: f.pool, boss, web: { async get() { return { status: 200, finalUrl: 'https://example.com/a', headers: { 'content-type': 'text/html' }, body }; } }, classifier: { async classify() { return { usable: true, probability: 1 }; } } };
    expect(await automatic.processAutomaticImportsOnce(deps)).toBe(true);
    const chain = (await f.pool.query("select action,state from processing_tasks order by action")).rows;
    expect(chain.filter(task => task.action === 'prepare')).toEqual([{ action: 'prepare', state: 'succeeded' }]);
    expect(chain.filter(task => task.action === 'category')).toEqual([{ action: 'category', state: 'queued' }]);
    expect(chain.filter(task => task.action === 'tags')).toEqual([{ action: 'tags', state: 'waiting_dependency' }]);
    expect(chain.filter(task => task.action === 'scores').every(task => task.state === 'waiting_dependency')).toBe(true);
    expect(await automatic.processAutomaticImportsOnce(deps)).toBe(false);
    const missingUrlRun = await new ImportJobs(f.db, boss).startImport(context.id);
    const missingUrlFresh = { ...fresh, async listUnreadPage() { return { items: [{ id: 'missing-url', title: 'Synthetic', url: 'https://example.com/a', author: null, publishedAt: null, feedId: null, feedTitle: null }], continuation: null }; } };
    await runImport(f.pool, missingUrlRun.run.id, missingUrlFresh, { lastAttempt: true, automaticProcessing: true });
    const missingUrlId = (await f.pool.query("select id from articles where freshrss_id='missing-url'")).rows[0].id;
    await f.pool.query('update articles set url=null where id=$1', [missingUrlId]);
    expect(await automatic.processAutomaticImportsOnce(deps)).toBe(true);
    expect((await f.pool.query('select state,error_code from processing_tasks where article_id=$1', [missingUrlId])).rows).toEqual([{ state: 'failed', error_code: 'processing_ineligible' }]);
    const failRun = await new ImportJobs(f.db, boss).startImport(context.id);
    const failedFresh = { ...fresh, async listUnreadPage() { return { items: [{ id: 'failed', title: 'Synthetic', url: 'https://example.com/fail', author: null, publishedAt: null, feedId: null, feedTitle: null }], continuation: null }; } };
    await runImport(f.pool, failRun.run.id, failedFresh, { lastAttempt: true, automaticProcessing: true });
    expect(await automatic.processAutomaticImportsOnce({ ...deps, classifier: { async classify() { return { usable: false, probability: 0 }; } } })).toBe(true);
    expect((await f.pool.query("select t.state,t.error_code from processing_tasks t join articles a on a.id=t.article_id where a.freshrss_id='failed'")).rows).toEqual([{ state: 'failed', error_code: 'content_unusable' }]);
    expect(await automatic.processAutomaticImportsOnce(deps)).toBe(false);
    const competingRun = await new ImportJobs(f.db, boss).startImport(context.id);
    const competingFresh = { ...fresh, async listUnreadPage() { return { items: [{ id: 'competing', title: 'Synthetic', url: 'https://example.com/race', author: null, publishedAt: null, feedId: null, feedTitle: null }], continuation: null }; } };
    await runImport(f.pool, competingRun.run.id, competingFresh, { lastAttempt: true, automaticProcessing: true });
    const competingId = (await f.pool.query("select id from articles where freshrss_id='competing'")).rows[0].id;
    await f.pool.query("insert into processing_tasks(article_id,action,generation,state,created_at,updated_at) values ($1,'scores',1,'failed',now(),now())", [competingId]);
    let fetches = 0;
    await automatic.processAutomaticImportsOnce({ ...deps, web: { async get() { fetches++; return deps.web.get(); } } });
    expect(fetches).toBe(0);
    expect((await f.pool.query("select state,error_code from processing_tasks where article_id=$1 and action='prepare'", [competingId])).rows).toEqual([{ state: 'failed', error_code: 'processing_conflict' }]);
    const interruptedRun = await new ImportJobs(f.db, boss).startImport(context.id);
    const interruptedFresh = { ...fresh, async listUnreadPage() { return { items: [{ id: 'interrupted', title: 'Synthetic', url: 'https://example.com/interrupted', author: null, publishedAt: null, feedId: null, feedTitle: null }], continuation: null }; } };
    await runImport(f.pool, interruptedRun.run.id, interruptedFresh, { lastAttempt: true, automaticProcessing: true });
    const interruptedId = (await f.pool.query("select id from articles where freshrss_id='interrupted'")).rows[0].id;
    await f.pool.query("update processing_tasks set state='running', execution_token=gen_random_uuid(), started_at=now() where article_id=$1", [interruptedId]);
    expect(await automatic.recoverInterruptedAutomaticImports(f.db)).toBe(1);
    expect((await f.pool.query("select state,error_code from processing_tasks where article_id=$1", [interruptedId])).rows).toEqual([{ state: 'failed', error_code: 'interrupted' }]);
    expect(await automatic.processAutomaticImportsOnce(deps)).toBe(false);
    const raceRun = await new ImportJobs(f.db, boss).startImport(context.id);
    const raceFresh = { ...fresh, async listUnreadPage() { return { items: [{ id: 'race', title: 'Synthetic', url: 'https://example.com/race', author: null, publishedAt: null, feedId: null, feedTitle: null }], continuation: null }; } };
    await runImport(f.pool, raceRun.run.id, raceFresh, { lastAttempt: true, automaticProcessing: true });
    let entered!: () => void; let release!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    let raceFetches = 0;
    const firstWorker = automatic.processAutomaticImportsOnce({ ...deps, web: { async get() { raceFetches++; entered(); await releaseGate; return deps.web.get(); } } });
    await enteredGate;
    expect(await automatic.processAutomaticImportsOnce(deps)).toBe(false);
    release(); await firstWorker;
    expect(raceFetches).toBe(1);
    const admissionRun = await new ImportJobs(f.db, boss).startImport(context.id);
    const admissionFresh = { ...fresh, async listUnreadPage() { return { items: [{ id: 'admission-error', title: 'Synthetic', url: 'https://example.com/a', author: null, publishedAt: null, feedId: null, feedTitle: null }], continuation: null }; } };
    await runImport(f.pool, admissionRun.run.id, admissionFresh, { lastAttempt: true, automaticProcessing: true });
    await expect(automatic.processAutomaticImportsOnce({ ...deps, boss: { send: async () => null } as unknown as PgBoss })).rejects.toThrow();
    expect((await f.pool.query("select t.state,t.error_code from processing_tasks t join articles a on a.id=t.article_id where a.freshrss_id='admission-error'")).rows).toEqual([{ state: 'succeeded', error_code: 'admission_unknown' }]);
    const missingRun = await new ImportJobs(f.db, boss).startImport(context.id);
    const missingFresh = { ...fresh, async listUnreadPage() { return { items: [{ id: 'handoff-interrupted', title: 'Synthetic', url: 'https://example.com/a', author: null, publishedAt: null, feedId: null, feedTitle: null }], continuation: null }; } };
    await runImport(f.pool, missingRun.run.id, missingFresh, { lastAttempt: true, automaticProcessing: true });
    const missingId = (await f.pool.query("select id from articles where freshrss_id='handoff-interrupted'")).rows[0].id;
    await f.pool.query("update processing_tasks set state='succeeded', result=result || '{\"preparationReceipt\":{}}'::jsonb where article_id=$1", [missingId]);
    expect(await automatic.recoverInterruptedAutomaticImports(f.db)).toBe(1);
    expect((await f.pool.query('select state,error_code from processing_tasks where article_id=$1', [missingId])).rows).toEqual([{ state: 'succeeded', error_code: 'admission_interrupted' }]);
  } finally { await boss.stop().catch(() => {}); await f.dispose(); }
}, 60000);

it('drives opted-in FreshRSS imports through a background processor', async () => {
  const f = await articleProcessingFixture();
  try {
    await provisionImportQueues(f.boss);
    const store = new ImportStore(f.database.db);
    await store.saveSettings({ importEnabled: false, importIntervalSeconds: 14400, nextImportAt: null });
    const context = await store.ensureContext('synthetic-background', 'fixture');
    const fresh = new FreshRssClient({ baseUrl: 'http://127.0.0.1:1/api/greader.php', email: 'fixture', password: 'fixture', transport: async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/accounts/ClientLogin')) return new Response('Auth=fixture-token\n');
      if (path.endsWith('/stream/contents/user/-/state/com.google/reading-list')) return Response.json({ items: [{ id: 'background', title: 'Synthetic', alternate: [{ href: 'https://example.com/article' }] }] });
      if (path.endsWith('/stream/items/contents')) return Response.json({ items: [{ id: 'background', categories: ['user/-/state/com.google/read'] }] });
      throw new Error('Unexpected fixture request');
    } });
    const body = Buffer.from(`<html><body><article><h1>Report</h1><p>${'A synthetic report with useful factual details. '.repeat(50)}</p></article></body></html>`);
    const processor = await automatic.startAutomaticImportProcessing({ db: f.database.db, pool: f.database.pool, boss: f.boss, web: { async get() { return { status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': 'text/html' }, body }; } }, classifier: { async classify() { return { usable: true, probability: 1 }; } } });
    try {
      const jobs = await startImportWorkers(f.database.pool, f.database.db, f.boss, async () => fresh, [context.id], true);
      await jobs.startImport(context.id);
      await eventually(async () => (await f.database.pool.query("select count(*)::int as n from processing_tasks t join articles a on a.id=t.article_id where a.freshrss_id='background' and t.action='category'", [])).rows[0].n === 1);
    } finally { await processor.close(); }
  } finally { await f.close(); }
}, 60000);
