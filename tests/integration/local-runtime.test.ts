import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { expect, it } from 'vitest';
import { provisionArticleQueues } from '../../src/server/adapters/postgres/article-worker.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { provisionScoreQueue } from '../../src/server/adapters/postgres/score-admission.js';
import type { UsageService } from '../../src/server/application/usage.js';
import { buildApplication } from '../../src/server/composition-root.js';
import type { AppConfig } from '../../src/server/config.js';
import type { AiPort } from '../../src/server/ports/ai.js';
import { fallbackCategoryId } from '../../src/shared/taxonomy.js';
import { eventually } from '../helpers/article-processing-fixture.js';
import { createUsageDatabase } from '../helpers/usage-database.js';

it('wires only explicit local processing, enforces admission caps, and refuses pending queues', async () => {
  const db = await createUsageDatabase();
  const url = db.pool.options.connectionString!;
  const boss = new PgBoss({ connectionString: url }); boss.on('error', () => {});
  let app: Awaited<ReturnType<typeof buildApplication>> | undefined;
  try {
    await migrateDatabase(db.pool);
    await boss.start(); await provisionArticleQueues(boss); await provisionScoreQueue(boss); await boss.stop();
    await db.pool.query("update model_roles set provider='openai-codex', model='gpt-6-luna' where role in ('tags','context_reduction')");
    await db.pool.query('update score_definitions set active=(id=(select id from score_definitions order by id limit 1))');
    const imports = new ImportStore(db.db);
    const context = await imports.ensureContext('synthetic-local', 'fixture');
    const rows = await imports.importPageWithIdentities(context.id, [0, 1, 2].map(() => ({ id: randomUUID(), title: 'Synthetic report', url: `https://example.com/${randomUUID()}`, author: null, publishedAt: null, feedId: null, feedTitle: null })), new Date());
    const selected = rows[0]!.id; const capped = rows[1]!.id; const unselected = rows[2]!.id;
    const base: AppConfig = { databaseUrl: url, origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, trustedProxies: [] };
    let usage: UsageService | undefined;
    const calls: string[] = [];
    const overrides = {
      web: { async get() { return { status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': 'text/html' }, body: Buffer.from(`<html><body><article><h1>Report</h1><p>${'A synthetic report with independent details and meaningful factual information. '.repeat(30)}</p></article></body></html>`) }; } },
      async createAi(service: UsageService): Promise<AiPort> {
        usage = service;
        return {
          async classify(request, scope) {
            return service.executeAttempt({ ...request.model, role: request.role, bucket: scope.bucket, ...(scope.taskId ? { taskId: scope.taskId } : {}) }, scope, async (_signal, permit) => {
              permit.consume(); calls.push(request.role);
              const q = Object.values(request.questions)[0]!;
              const answer = q.type === 'bool' ? { type: 'bool' as const, probability: 1 }
                : q.type === 'choice' ? (() => { const choice = Object.keys(q.criteria).find(id => id !== fallbackCategoryId)!; return { type: 'choice' as const, choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(id => [id, id === choice ? 1 : 0])) }; })()
                  : { type: 'score' as const, score: 1, confidence: 1, criteria: q.criteria };
              return { kind: 'success', value: { answers: { [Object.keys(request.questions)[0]!]: answer }, usage: null }, terminal: { status: 'succeeded', inputTokens: null, outputTokens: null, costUsd: null, tokensSource: 'unknown', costSource: 'unknown', outcomeCode: null } };
            });
          },
          async generate(request, scope) {
            return service.executeAttempt({ ...request.model, role: request.role, bucket: scope.bucket, ...(scope.taskId ? { taskId: scope.taskId } : {}) }, scope, async (_signal, permit) => {
              permit.consume(); calls.push(request.role);
              return { kind: 'success', value: { text: '{"tags":["synthetic topic"]}', usage: null }, terminal: { status: 'succeeded', inputTokens: null, outputTokens: null, costUsd: null, tokensSource: 'unknown', costSource: 'unknown', outcomeCode: null } };
            });
          },
          async createRestrictedSession() { throw new Error('Unexpected session'); },
        };
      },
    };
    app = await buildApplication(base, overrides);
    const request = { method: 'POST' as const, url: `/api/v1/articles/${selected}/processing`, headers: { host: 'localhost:3000', 'content-type': 'application/json' }, payload: '{}' };
    expect((await app.app.inject(request)).statusCode).toBe(503);
    expect(usage).toBeUndefined();
    await app.close(); app = undefined;
    app = await buildApplication({ ...base, localProcessing: { classifierDaily: 5, classifierConcurrency: 1, automaticDaily: 1, automaticConcurrency: 1, typesafeKey: 'not-used' } }, overrides);
    expect(calls).toEqual([]);
    expect((await app.app.inject({ ...request, url: `/api/v1/articles/${unselected}/reevaluations` })).statusCode).toBe(503);
    const response = await app.app.inject(request);
    expect(response.statusCode).toBe(200); expect(response.json().kind).toBe('admitted');
    await eventually(async () => (await db.pool.query("select count(*)::int as n from processing_tasks where article_id=$1 and action='scores' and state='succeeded'", [selected])).rows[0].n === 1);
    expect(calls).toEqual(['quality', 'category', 'tags', 'scores']);
    expect((await db.pool.query('select count(*)::int as n from processing_tasks where article_id=$1', [unselected])).rows[0].n).toBe(0);
    const scope = { bucket: 'classifier' as const, signal: new AbortController().signal };
    const intent = { provider: 'typesafe', model: 'jev-latest', role: 'quality' as const, bucket: 'classifier' as const };
    let release!: () => void; let started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const success = { kind: 'success' as const, value: 'ok', terminal: { status: 'succeeded' as const, inputTokens: null, outputTokens: null, costUsd: null, tokensSource: 'unknown' as const, costSource: 'unknown' as const, outcomeCode: null } };
    const first = usage!.executeAttempt(intent, scope, async (_signal, permit) => { permit.consume(); started(); await waiting; return success; });
    await entered;
    expect(await usage!.executeAttempt(intent, scope, async () => success)).toMatchObject({ kind: 'paused_budget', reason: 'concurrency_limit' });
    release(); expect(await first).toMatchObject({ kind: 'completed' });
    expect(await usage!.executeAttempt(intent, scope, async (_signal, permit) => { permit.consume(); return success; })).toMatchObject({ kind: 'completed' });
    expect(await usage!.executeAttempt(intent, scope, async () => success)).toMatchObject({ kind: 'paused_budget', reason: 'daily_limit' });
    expect(await usage!.executeAttempt({ provider: 'openai-codex', model: 'gpt-6-luna', role: 'tags', bucket: 'automatic' }, { bucket: 'automatic', signal: scope.signal }, async () => success)).toMatchObject({ kind: 'paused_budget', reason: 'daily_limit' });
    const denied = await app.app.inject({ ...request, url: `/api/v1/articles/${capped}/processing` });
    expect(denied.json().kind).toBe('failed');
    expect(calls).toEqual(['quality', 'category', 'tags', 'scores']);
    expect((await db.pool.query('select count(*)::int as n from processing_tasks where article_id=$1', [unselected])).rows[0].n).toBe(0);
    await app.close(); app = undefined;
    const queue = new PgBoss({ connectionString: url }); queue.on('error', () => {}); await queue.start();
    try { await queue.send('category', { taskId: randomUUID() }, { startAfter: 3600 }); } finally { await queue.stop(); }
    app = await buildApplication(base, overrides);
    expect((await db.pool.query("select count(*)::int as n from pgboss.job where name='category' and state='created'")).rows[0].n).toBe(1);
    await app.close(); app = undefined;
    await expect(buildApplication({ ...base, localProcessing: { classifierDaily: 5, classifierConcurrency: 1, automaticDaily: 1, automaticConcurrency: 1, typesafeKey: 'not-used' } }, overrides)).rejects.toThrow();
  } finally { await app?.close(); await boss.stop().catch(() => {}); await db.dispose(); }
}, 90000);
