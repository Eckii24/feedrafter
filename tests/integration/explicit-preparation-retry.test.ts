import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import * as processing from '../../src/server/adapters/postgres/explicit-article-processing.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { PostgresUsageAdmissionStore } from '../../src/server/adapters/postgres/usage-admission-store.js';
import { createArticleQualityClassifier } from '../../src/server/application/classify-article-quality.js';
import { UsageService } from '../../src/server/application/usage.js';
import { articleProcessingFixture } from '../helpers/article-processing-fixture.js';

it('explicitly retries a terminal failure once, retaining its history and admitting the new generation', async () => {
  const f = await articleProcessingFixture();
  try {
    const store = new ImportStore(f.database.db);
    const context = await store.ensureContext('retry-test', 'synthetic');
    const [article] = await store.importPageWithIdentities(context.id, [{ id: randomUUID(), title: 'Retry', url: 'https://example.com/article', author: null, publishedAt: null, feedId: null, feedTitle: null }], new Date());
    if (!article) throw new Error('Import failed');
    const body = Buffer.from(`<html><body><article><p>${'Synthetic useful report. '.repeat(100)}</p></article></body></html>`);
    let calls = 0;
    const deps = { db: f.database.db, boss: f.boss, web: { async get() { return { status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': 'text/html' }, body }; } }, classifier: { async classify() { calls++; return { usable: true, probability: 1 }; } } };
    const failed = { ...deps, classifier: { async classify() { return { usable: false, probability: 0 }; } } };
    expect((await processing.processExplicitArticles(failed, [article.id]))[0]?.kind).toBe('failed');
    const before = (await f.database.pool.query('select * from processing_tasks where article_id=$1', [article.id])).rows[0];
    const retry = processing.retryFailedPreparation;
    const attempts = [{ articleId: article.id, failedTaskId: before.id as string }];
    const results = await Promise.all([retry(deps, attempts), retry(deps, attempts)]);
    expect(results.flat().map(row => row.kind).sort()).toEqual(['admission', 'already_started']);
    expect(results.flat().find(row => row.kind === 'admission')).toMatchObject({ admission: { kind: 'admitted' } });
    expect(calls).toBe(1);
    const history = (await f.database.pool.query("select * from processing_tasks where article_id=$1 and action='prepare' order by generation", [article.id])).rows;
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(before);
    expect(history[1]).toMatchObject({ generation: 2, state: 'succeeded' });
  } finally { await f.close(); }
}, 60000);

it('refuses stale authorizations, active work, content revisions and downstream tasks', async () => {
  const f = await articleProcessingFixture();
  try {
    const store = new ImportStore(f.database.db);
    const context = await store.ensureContext('retry-blocks', 'synthetic');
    const body = Buffer.from(`<html><body><article><p>${'Synthetic report details. '.repeat(100)}</p></article></body></html>`);
    let calls = 0;
    const deps = { db: f.database.db, boss: f.boss, web: { async get() { calls++; return { status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': 'text/html' }, body }; } }, classifier: { async classify() { return { usable: false, probability: 0 }; } } };
    const createFailed = async () => {
      const [article] = await store.importPageWithIdentities(context.id, [{ id: randomUUID(), title: 'Retry', url: 'https://example.com/article', author: null, publishedAt: null, feedId: null, feedTitle: null }], new Date());
      if (!article) throw new Error('Import failed');
      const [result] = await processing.processExplicitArticles(deps, [article.id]);
      if (!result || result.kind !== 'failed') throw new Error('Expected failure');
      return { articleId: article.id, failedTaskId: result.prepareTaskId };
    };
    const stale = await createFailed();
    expect((await processing.retryFailedPreparation(deps, [stale]))[0]?.kind).toBe('failed');
    const before = calls;
    expect((await processing.retryFailedPreparation(deps, [stale]))[0]?.kind).toBe('already_started');
    expect(calls).toBe(before);

    const active = await createFailed();
    await f.database.pool.query("insert into processing_tasks (article_id, action, generation, state, created_at, updated_at) values ($1, 'prepare', 2, 'running', now(), now())", [active.articleId]);
    const downstream = await createFailed();
    await f.database.pool.query("insert into processing_tasks (article_id, action, generation, state, created_at, updated_at) values ($1, 'category', 1, 'failed', now(), now())", [downstream.articleId]);
    const revised = await createFailed();
    await f.database.pool.query('update articles set content_revision=1 where id=$1', [revised.articleId]);
    const rejected = await processing.retryFailedPreparation(deps, [active, downstream, revised]);
    expect(rejected.map(row => row.kind)).toEqual(['already_started', 'already_started', 'already_started']);
  } finally { await f.close(); }
}, 60000);

it('keeps previous usage and enforces the same daily classifier cap on retry', async () => {
  const f = await articleProcessingFixture();
  try {
    const store = new ImportStore(f.database.db);
    const context = await store.ensureContext('retry-cap', 'synthetic');
    const [article] = await store.importPageWithIdentities(context.id, [{ id: randomUUID(), title: 'Cap', url: 'https://example.com/article', author: null, publishedAt: null, feedId: null, feedTitle: null }], new Date());
    if (!article) throw new Error('Import failed');
    const body = Buffer.from(`<html><body><article><p>${'Synthetic report details. '.repeat(100)}</p></article></body></html>`);
    const usage = new UsageService(new PostgresUsageAdmissionStore(f.database.pool, { now: () => new Date() }, f.database.pool, { classifier: { daily: 1, concurrency: 1 } }));
    let sent = 0;
    const classifier = createArticleQualityClassifier({ async classify(request, scope) {
      return usage.executeAttempt({ ...request.model, role: request.role, bucket: scope.bucket, ...(scope.taskId ? { taskId: scope.taskId } : {}) }, scope, async (_signal, permit) => {
        permit.consume(); sent++;
        return { kind: 'success', value: { answers: { usable: { type: 'bool', probability: 0 } }, usage: null }, terminal: { status: 'succeeded', inputTokens: null, outputTokens: null, costUsd: null, tokensSource: 'unknown', costSource: 'unknown', outcomeCode: null } };
      });
    } }, { kind: 'unverified', model: { provider: 'fake', model: 'fake' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 100, maxRequestBytes: 9000 } });
    const deps = { db: f.database.db, boss: f.boss, web: { async get() { return { status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': 'text/html' }, body }; } }, classifier };
    const [initial] = await processing.processExplicitArticles(deps, [article.id]);
    if (!initial || initial.kind !== 'failed') throw new Error('Expected failure');
    const ledger = (await f.database.pool.query('select * from usage_ledger where task_id=$1', [initial.prepareTaskId])).rows;
    expect(ledger).toHaveLength(1);
    expect((await processing.retryFailedPreparation(deps, [{ articleId: article.id, failedTaskId: initial.prepareTaskId }]))[0]?.kind).toBe('failed');
    expect(sent).toBe(1);
    expect((await f.database.pool.query('select * from usage_ledger where task_id=$1', [initial.prepareTaskId])).rows).toEqual(ledger);
    expect((await f.database.pool.query('select count(*)::int n from usage_ledger')).rows[0].n).toBe(1);
  } finally { await f.close(); }
}, 60000);
