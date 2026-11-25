import { expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { provisionImportQueues } from '../../src/server/adapters/postgres/import-runner.js';
import { provisionArticleQueues } from '../../src/server/adapters/postgres/article-worker.js';
import { provisionScoreQueue } from '../../src/server/adapters/postgres/score-admission.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { buildApplication } from '../../src/server/composition-root.js';
import type { UsageService } from '../../src/server/application/usage.js';
import { eventually } from '../helpers/article-processing-fixture.js';
import { createUsageDatabase } from '../helpers/usage-database.js';

it('wires automatic import into the opted-in application without processing pre-existing backlog', async () => {
  const f = await createUsageDatabase();
  const url = f.pool.options.connectionString!;
  const boss = new PgBoss({ connectionString: url }); boss.on('error', () => {});
  let app: Awaited<ReturnType<typeof buildApplication>> | undefined;
  try {
    await migrateDatabase(f.pool); await boss.start(); await provisionImportQueues(boss); await provisionArticleQueues(boss); await provisionScoreQueue(boss); await boss.stop();
    await f.pool.query("update model_roles set provider='openai-codex',model='gpt-6-luna' where role in ('tags','context_reduction')");
    const store = new ImportStore(f.db);
    await store.saveSettings({ importEnabled: false, importIntervalSeconds: 14400, nextImportAt: null });
    const context = await store.ensureContext('http://127.0.0.1:1/api/greader.php', 'fixture');
    const [backlog] = await store.importPageWithIdentities(context.id, [{ id: 'backlog', title: 'Old', url: 'https://example.com/old', author: null, publishedAt: null, feedId: null, feedTitle: null }], new Date());
    const transport: typeof fetch = async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/accounts/ClientLogin')) return new Response('Auth=fixture-token\n');
      if (path.endsWith('/stream/contents/user/-/state/com.google/reading-list')) return Response.json({ items: [{ id: 'new-import', title: 'Synthetic', alternate: [{ href: 'https://example.com/article' }] }] });
      if (path.endsWith('/stream/items/contents')) return Response.json({ items: [{ id: 'new-import', categories: ['user/-/state/com.google/read'] }] });
      throw new Error('Unexpected fixture request');
    };
    const calls: string[] = [];
    const fresh = { baseUrl: 'http://127.0.0.1:1/api/greader.php', email: 'fixture', password: 'fixture', transport };
    app = await buildApplication({ databaseUrl: url, origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, trustedProxies: [], fresh, localProcessing: { classifierDaily: 250, classifierConcurrency: 1, automaticDaily: 50, automaticConcurrency: 1, typesafeKey: 'not-used' } }, {
      web: { async get() { return { status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': 'text/html' }, body: Buffer.from(`<html><body><article><h1>Report</h1><p>${'Synthetic article facts. '.repeat(100)}</p></article></body></html>`) }; } },
      async createAi(usage: UsageService) { return { async classify(request, scope) { return usage.executeAttempt({ ...request.model, role: request.role, bucket: scope.bucket, ...(scope.taskId ? { taskId: scope.taskId } : {}) }, scope, async (_signal, permit) => { permit.consume(); calls.push(request.role); const question = Object.values(request.questions)[0]!; if (question.type !== 'bool') throw new Error('stop after quality'); return { kind: 'success', value: { answers: { [Object.keys(request.questions)[0]!]: { type: 'bool', probability: 1 } }, usage: null }, terminal: { status: 'succeeded', inputTokens: null, outputTokens: null, costUsd: null, tokensSource: 'unknown', costSource: 'unknown', outcomeCode: null } }; }); }, async generate() { throw new Error('Unexpected generate'); }, async createRestrictedSession() { throw new Error('Unexpected session'); } }; },
    });
    const response = await app.app.inject({ method: 'POST', url: '/api/v1/pipeline/runs', headers: { host: 'localhost:3000', 'content-type': 'application/json' }, payload: '{}' });
    expect(response.statusCode).toBe(202);
    await eventually(async () => (await f.pool.query("select count(*)::int as n from processing_tasks t join articles a on a.id=t.article_id where a.freshrss_id='new-import' and t.action='prepare' and t.state='succeeded'")).rows[0].n === 1, 15000);
    expect(calls).toContain('quality');
    expect((await f.pool.query('select count(*)::int as n from processing_tasks where article_id=$1', [backlog!.id])).rows[0].n).toBe(0);
    await app.close(); app = undefined;
    const pendingBoss = new PgBoss({ connectionString: url }); pendingBoss.on('error', () => {}); await pendingBoss.start();
    try { await pendingBoss.send('category', { taskId: '00000000-0000-4000-8000-000000000001' }, { startAfter: 3600 }); } finally { await pendingBoss.stop(); }
    await expect(buildApplication({ databaseUrl: url, origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, trustedProxies: [], fresh, localProcessing: { classifierDaily: 250, classifierConcurrency: 1, automaticDaily: 50, automaticConcurrency: 1, typesafeKey: 'not-used' } }, {
      web: { async get() { throw new Error('No fetch on refused startup'); } }, async createAi() { throw new Error('No AI on refused startup'); },
    })).rejects.toThrow('Local inference queues are missing or contain pending jobs');
  } finally { await app?.close(); await boss.stop().catch(() => {}); await f.dispose(); }
}, 60000);
