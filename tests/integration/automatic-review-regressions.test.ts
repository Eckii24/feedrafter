import { expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { ImportJobs, processAutomaticImportsOnce, recoverInterruptedAutomaticImports, runImport } from '../../src/server/adapters/postgres/import-jobs.js';
import { createArticleQualityClassifier } from '../../src/server/application/classify-article-quality.js';
import { provisionArticleQueues } from '../../src/server/adapters/postgres/article-worker.js';
import { provisionScoreQueue } from '../../src/server/adapters/postgres/score-admission.js';
import { provisionImportQueues } from '../../src/server/adapters/postgres/import-runner.js';

it.each(['revision', 'ownership'] as const)('settles stale preparation only under its own fence (%s)', async change => {
  const f = await createUsageDatabase();
  const boss = new PgBoss({ connectionString: f.pool.options.connectionString! }); boss.on('error', () => {});
  try {
    await migrateDatabase(f.pool); await boss.start(); await provisionImportQueues(boss);
    const context = await new ImportStore(f.db).ensureContext('stale-review', 'fixture');
    const fresh = { async listUnreadPage() { return { items: [{ id: 'stale', title: 'stale', url: 'https://example.com/a', author: null, publishedAt: null, feedId: null, feedTitle: null }], continuation: null }; }, async getReadState() { return new Map([['stale', true]]); }, async markRead() {} };
    const run = await new ImportJobs(f.db, boss).startImport(context.id);
    await runImport(f.pool, run.run.id, fresh, { lastAttempt: true, automaticProcessing: true });
    let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
    const body = Buffer.from(`<html><body><article><p>${'Synthetic factual report. '.repeat(100)}</p></article></body></html>`);
    const deps = { db: f.db, pool: f.pool, boss, classifier: { async classify() { return { usable: true, probability: 1 }; } }, web: { async get() { entered(); await gate; return { status: 200, finalUrl: 'https://example.com/a', headers: { 'content-type': 'text/html' }, body }; } } };
    const pending = processAutomaticImportsOnce(deps); await ready;
    if (change === 'revision') await f.pool.query('update articles set content_revision=1');
    else await f.pool.query('update processing_tasks set execution_token=gen_random_uuid()');
    release(); await pending;
    const task = (await f.pool.query('select state,error_code from processing_tasks')).rows[0];
    expect(task).toEqual(change === 'revision' ? { state: 'superseded', error_code: 'stale_basis' } : { state: 'running', error_code: null });
  } finally { await boss.stop().catch(() => {}); await f.dispose(); }
}, 60000);


it('creates and runs automatic preparation for video-kind imports', async () => {
  const f = await createUsageDatabase();
  const boss = new PgBoss({ connectionString: f.pool.options.connectionString! }); boss.on('error', () => {});
  try {
    await migrateDatabase(f.pool); await boss.start(); await provisionImportQueues(boss);
    await f.pool.query(`create function test_video_kind() returns trigger language plpgsql as $$ begin new.kind := 'video'; return new; end $$; create trigger test_video before insert on articles for each row execute function test_video_kind()`);
    const context = await new ImportStore(f.db).ensureContext('video-review', 'fixture');
    const fresh = { async listUnreadPage() { return { items: [{ id: 'v', title: 'v', url: 'https://example.com/a', author: null, publishedAt: null, feedId: null, feedTitle: null }], continuation: null }; }, async getReadState() { return new Map([['v', true]]); }, async markRead() {} };
    const run = await new ImportJobs(f.db, boss).startImport(context.id);
    await runImport(f.pool, run.run.id, fresh, { lastAttempt: true, automaticProcessing: true });
    expect((await f.pool.query("select t.state from processing_tasks t join articles a on a.id=t.article_id where a.kind='video'")).rows).toEqual([{ state: 'queued' }]);
    let calls = 0;
    expect(await processAutomaticImportsOnce({ db: f.db, pool: f.pool, boss, classifier: { async classify() { return { usable: false, probability: 0 }; } }, web: { async get() { calls++; return { status: 403, finalUrl: 'https://example.com/a', headers: {}, body: Buffer.from('') }; } } })).toBe(true);
    expect(calls).toBe(1);
    expect((await f.pool.query('select state,error_code from processing_tasks')).rows).toEqual([{ state: 'failed', error_code: 'access_denied' }]);
  } finally { await boss.stop().catch(() => {}); await f.dispose(); }
}, 60000);


it('recovers interrupted explicit preparation and missing handoff without retry', async () => {
  const f = await createUsageDatabase();
  try {
    await migrateDatabase(f.pool);
    const context = await new ImportStore(f.db).ensureContext('manual-recovery', 'fixture');
    const articles = await f.pool.query("insert into articles(context_id,freshrss_id,title,imported_at) values ($1,'manual-running','a',now()),($1,'manual-success','b',now()) returning id,freshrss_id", [context.id]);
    const running = articles.rows.find(row => row.freshrss_id === 'manual-running')!.id;
    const success = articles.rows.find(row => row.freshrss_id === 'manual-success')!.id;
    await f.pool.query("insert into processing_tasks(article_id,action,generation,state,execution_token,result,created_at,updated_at) values ($1,'prepare',1,'running',gen_random_uuid(),NULL,now(),now()),($2,'prepare',1,'succeeded',gen_random_uuid(),'{\"preparationReceipt\":{}}',now(),now())", [running, success]);
    const original = (await f.pool.query('select id,execution_token from processing_tasks where article_id=$1', [running])).rows[0];
    expect(await recoverInterruptedAutomaticImports(f.db)).toBe(2);
    expect((await f.pool.query('select state,error_code from processing_tasks order by state')).rows).toEqual([{ state: 'failed', error_code: 'interrupted' }, { state: 'succeeded', error_code: 'admission_interrupted' }]);
    expect((await f.pool.query('select ended_at is not null as ended, result from processing_tasks where id=$1', [original.id])).rows[0]).toEqual({ ended: true, result: null });
    expect(await new ContentStore(f.db).publishTask({ taskId: original.id, articleId: running, action: 'prepare', generation: 1, executionToken: original.execution_token, expectedContentRevision: 0 }, { kind: 'success', content: { text: 'late content', quality: 'usable', capturedAt: new Date() }, at: new Date() })).toBeNull();
    expect((await f.pool.query('select count(*)::int as count from article_contents where article_id=$1', [running])).rows[0].count).toBe(0);
    expect(await recoverInterruptedAutomaticImports(f.db)).toBe(0);
  } finally { await f.dispose(); }
}, 60000);


it('persists sampled quality limitation with full captured text in PostgreSQL', async () => {
  const f = await createUsageDatabase();
  const boss = new PgBoss({ connectionString: f.pool.options.connectionString! }); boss.on('error', () => {});
  try {
    await migrateDatabase(f.pool); await boss.start(); await provisionImportQueues(boss); await provisionArticleQueues(boss); await provisionScoreQueue(boss);
    const context = await new ImportStore(f.db).ensureContext('sampling-review', 'fixture');
    const fresh = { async listUnreadPage() { return { items: [{ id: 'sample', title: 'sample', url: 'https://example.com/a', author: null, publishedAt: null, feedId: null, feedTitle: null }], continuation: null }; }, async getReadState() { return new Map([['sample', true]]); }, async markRead() {} };
    const run = await new ImportJobs(f.db, boss).startImport(context.id);
    await runImport(f.pool, run.run.id, fresh, { lastAttempt: true, automaticProcessing: true });
    const classifier = createArticleQualityClassifier({ async classify() { return { kind: 'completed', value: { answers: { usable: { type: 'bool', probability: 0.9 } }, usage: null } }; } }, { kind: 'unverified', model: { provider: 'fixture', model: 'fixture' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 100, maxRequestBytes: 9000 } });
    const body = Buffer.from(`<html><body><article><p>BEGIN ${'Synthetic long factual report. '.repeat(2000)} END</p></article></body></html>`);
    await processAutomaticImportsOnce({ db: f.db, pool: f.pool, boss, classifier, web: { async get() { return { status: 200, finalUrl: 'https://example.com/a', headers: { 'content-type': 'text/html' }, body }; } } });
    const row = (await f.pool.query('select text,limitation from article_contents')).rows[0];
    expect(row.text).toContain('BEGIN'); expect(row.text).toContain('END');
    expect(row.text.length).toBeGreaterThan(50000);
    expect(row.limitation).toMatch(/sampled.*omitted/i);
  } finally { await boss.stop().catch(() => {}); await f.dispose(); }
}, 60000);
