import { expect, it, vi } from 'vitest';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { PgBoss } from 'pg-boss';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { ImportJobs, processAutomaticImportsOnce, runImport } from '../../src/server/adapters/postgres/import-jobs.js';
import { provisionImportQueues } from '../../src/server/adapters/postgres/import-runner.js';
import { provisionArticleQueues } from '../../src/server/adapters/postgres/article-worker.js';
import { provisionScoreQueue } from '../../src/server/adapters/postgres/score-admission.js';
import { createArticleQualityClassifier } from '../../src/server/application/classify-article-quality.js';

it('parks a budget-denied import without draining the backlog and resumes it after the cooldown', async () => {
  const f = await createUsageDatabase();
  const boss = new PgBoss({ connectionString: f.pool.options.connectionString! }); boss.on('error', () => {});
  try {
    await migrateDatabase(f.pool); await boss.start(); await provisionImportQueues(boss);
    const context = await new ImportStore(f.db).ensureContext('safety-test', 'fixture');
    const fresh = { async listUnreadPage() { return { items: ['a','b'].map(id => ({ id, title: id, url: 'https://example.com/' + id, author: null, publishedAt: null, feedId: null, feedTitle: null })), continuation: null }; }, async getReadState() { return new Map([['a', true], ['b', true]]); }, async markRead() {} };
    const run = await new ImportJobs(f.db, boss).startImport(context.id);
    await runImport(f.pool, run.run.id, fresh, { lastAttempt: true, automaticProcessing: true });
    let calls = 0;
    const classifier = createArticleQualityClassifier({ async classify() { calls++; return { kind: 'paused_budget', reason: 'daily_limit' }; } }, { kind: 'unverified', model: { provider: 'fixture', model: 'fixture' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 100, maxRequestBytes: 9000 } });
    const body = Buffer.from(`<html><body><article><h1>Report</h1><p>${'Synthetic factual article text. '.repeat(50)}</p></article></body></html>`);
    const deps = { db: f.db, pool: f.pool, boss, classifier, web: { async get() { return { status: 200, finalUrl: 'https://example.com/a', headers: { 'content-type': 'text/html' }, body }; } } };
    expect(await processAutomaticImportsOnce(deps)).toBe(false);
    expect((await f.pool.query("select state,error_code from processing_tasks order by state")).rows).toEqual([{ state: 'paused_budget', error_code: 'daily_limit' }, { state: 'queued', error_code: null }]);
    expect(await processAutomaticImportsOnce(deps)).toBe(false);
    expect(calls).toBe(1);
    await f.pool.query("update processing_tasks set updated_at=now()-interval '10 minutes' where state='paused_budget'");
    let entered!: () => void; let release!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    const blocked = { ...deps, classifier: { async classify() { entered(); await releaseGate; return classifier.classify({ text: 'fixture', sourceUrl: 'https://example.com/a' }, new AbortController().signal, 'fixture'); } } };
    const retry = processAutomaticImportsOnce(blocked);
    await enteredGate;
    expect(await processAutomaticImportsOnce(deps)).toBe(false);
    release();
    expect(await retry).toBe(false);
    expect(calls).toBe(2);
    expect((await f.pool.query("select count(*)::int as n from processing_tasks where state='queued'")).rows[0].n).toBe(1);
    await provisionArticleQueues(boss); await provisionScoreQueue(boss);
    await f.pool.query("update processing_tasks set updated_at=now()-interval '10 minutes' where state='paused_budget'");
    expect(await processAutomaticImportsOnce({ ...deps, classifier: { async classify() { return { usable: true, probability: 1 }; } } })).toBe(true);
    expect((await f.pool.query("select state from processing_tasks where action='prepare' order by state")).rows).toEqual([{ state: 'queued' }, { state: 'succeeded' }]);
  } finally { await boss.stop().catch(() => {}); await f.dispose(); }
}, 60000);

it.each([false, true])('records an ambiguous publication failure (commit=%s) without repeating classification', async committed => {
  const f = await createUsageDatabase();
  const boss = new PgBoss({ connectionString: f.pool.options.connectionString! }); boss.on('error', () => {});
  try {
    await migrateDatabase(f.pool); await boss.start(); await provisionImportQueues(boss);
    const context = await new ImportStore(f.db).ensureContext('publication-test', 'fixture');
    const fresh = { async listUnreadPage() { return { items: [{ id: 'a', title: 'a', url: 'https://example.com/a', author: null, publishedAt: null, feedId: null, feedTitle: null }], continuation: null }; }, async getReadState() { return new Map([['a', true]]); }, async markRead() {} };
    const run = await new ImportJobs(f.db, boss).startImport(context.id);
    await runImport(f.pool, run.run.id, fresh, { lastAttempt: true, automaticProcessing: true });
    const original = ContentStore.prototype.publishTask;
    const spy = vi.spyOn(ContentStore.prototype, 'publishTask').mockImplementation(async function (this: ContentStore, context, outcome) {
      if (committed) await original.call(this, context, outcome);
      throw new Error('lost publication response');
    });
    const classifier = { classify: vi.fn(async () => ({ usable: true, probability: 1 })) };
    const body = Buffer.from(`<html><body><article><h1>Report</h1><p>${'Synthetic factual article text. '.repeat(50)}</p></article></body></html>`);
    const deps = { db: f.db, pool: f.pool, boss, classifier, web: { async get() { return { status: 200, finalUrl: 'https://example.com/a', headers: { 'content-type': 'text/html' }, body }; } } };
    await expect(processAutomaticImportsOnce(deps)).rejects.toThrow('lost publication response');
    spy.mockRestore();
    expect((await f.pool.query("select state,error_code from processing_tasks")).rows).toEqual([{ state: committed ? 'succeeded' : 'failed', error_code: 'publication_unknown' }]);
    expect(await processAutomaticImportsOnce(deps)).toBe(false);
    expect(classifier.classify).toHaveBeenCalledOnce();
  } finally { vi.restoreAllMocks(); await boss.stop().catch(() => {}); await f.dispose(); }
}, 60000);


it('bounds ambiguous provider failures without retrying dispatched tasks or draining queued imports', async () => {
  const f = await createUsageDatabase();
  const boss = new PgBoss({ connectionString: f.pool.options.connectionString! }); boss.on('error', () => {});
  try {
    await migrateDatabase(f.pool); await boss.start(); await provisionImportQueues(boss);
    const context = await new ImportStore(f.db).ensureContext('circuit-test', 'fixture');
    const fresh = { async listUnreadPage() { return { items: ['a', 'b'].map(id => ({ id, title: id, url: 'https://example.com/' + id, author: null, publishedAt: null, feedId: null, feedTitle: null })), continuation: null }; }, async getReadState() { return new Map([['a', true], ['b', true]]); }, async markRead() {} };
    const run = await new ImportJobs(f.db, boss).startImport(context.id);
    await runImport(f.pool, run.run.id, fresh, { lastAttempt: true, automaticProcessing: true });
    let calls = 0;
    const classifier = createArticleQualityClassifier({ async classify() { calls++; throw new Error('provider offline'); } }, { kind: 'unverified', model: { provider: 'fixture', model: 'fixture' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 100, maxRequestBytes: 9000 } });
    const body = Buffer.from(`<html><body><article><p>${'Synthetic factual article text. '.repeat(50)}</p></article></body></html>`);
    const deps = { db: f.db, pool: f.pool, boss, classifier, web: { async get() { return { status: 200, finalUrl: 'https://example.com/a', headers: { 'content-type': 'text/html' }, body }; } } };
    await processAutomaticImportsOnce(deps);
    expect(await processAutomaticImportsOnce(deps)).toBe(false);
    expect(calls).toBe(1);
    expect((await f.pool.query("select state,error_code from processing_tasks order by state")).rows).toEqual([{ state: 'failed', error_code: 'quality_provider_failed' }, { state: 'queued', error_code: null }]);
    await f.pool.query("update processing_tasks set updated_at=now()-interval '10 minutes' where state='failed'");
    await processAutomaticImportsOnce(deps);
    expect(calls).toBe(2);
    expect((await f.pool.query("select count(*)::int as n from processing_tasks where state='failed'")).rows[0].n).toBe(2);
  } finally { await boss.stop().catch(() => {}); await f.dispose(); }
}, 60000);
