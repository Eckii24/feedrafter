import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { provisionImportQueues } from '../../src/server/adapters/postgres/import-runner.js';
import { provisionArticleQueues } from '../../src/server/adapters/postgres/article-worker.js';
import { provisionScoreQueue } from '../../src/server/adapters/postgres/score-admission.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { buildApplication } from '../../src/server/composition-root.js';
import { fallbackCategoryId } from '../../src/shared/taxonomy.js';
import type { AiPort } from '../../src/server/ports/ai.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();

it.each([{ includeContent: true, automaticDaily: 50 }, { includeContent: false, automaticDaily: 50 }, { includeContent: true, automaticDaily: 2 }])('automatically imports a long synthetic YouTube transcript through scoring %o', async ({ includeContent, automaticDaily }) => {
  // tmpfs covers the image VOLUME, so no existing or anonymous Docker volume is used.
  const container = docker('run', '--detach', '--rm', '--pull=never', '--name', `feedrafter-media-chain-${randomUUID()}`, '--tmpfs', '/var/lib/postgresql:rw', '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
  let db: ReturnType<typeof createDatabase> | undefined;
  let boss: PgBoss | undefined;
  let app: Awaited<ReturnType<typeof buildApplication>> | undefined;
  try {
    const port = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'));
    if (!port) throw new Error('Unexpected disposable port');
    const url = `postgresql://postgres:disposable-test-only@127.0.0.1:${port[1]}/feedrafter_test`;
    db = createDatabase(url);
    let ready = false;
    for (let i = 0; i < 100; i++) { try { await db.pool.query('select 1'); ready = true; break; } catch { await delay(200); } }
    if (!ready) throw new Error('Disposable database not ready');
    await migrateDatabase(db.pool);
    boss = new PgBoss({ connectionString: url }); boss.on('error', () => {});
    await boss.start(); await provisionImportQueues(boss); await provisionArticleQueues(boss); await provisionScoreQueue(boss); await boss.stop(); boss = undefined;
    await db.pool.query("update model_roles set provider='openai-codex',model='gpt-6-luna' where role in ('tags','context_reduction')");
    const targets: string[] = (await db.pool.query('select id from score_definitions order by id')).rows.map(row => row.id);
    expect(targets).toHaveLength(4);
    await db.pool.query('update score_definitions set active=($1 or id=$2), include_title=true, include_content=$1, include_category=true, include_tag_weights=true, include_source_weight=false', [includeContent, targets[0]]);
    await new ImportStore(db.db).saveSettings({ importEnabled: false, importIntervalSeconds: 14400, nextImportAt: null });
    const fresh = { baseUrl: 'http://127.0.0.1:1/api/greader.php', email: 'fixture', password: 'fixture', transport: async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/accounts/ClientLogin')) return new Response('Auth=fixture-token\n');
      if (path.endsWith('/stream/contents/user/-/state/com.google/reading-list')) return Response.json({ items: [{ id: 'synthetic-video', title: 'Synthetic video', alternate: [{ href: 'https://youtu.be/abcdefghijk' }] }] });
      if (path.endsWith('/stream/items/contents')) return Response.json({ items: [{ id: 'synthetic-video', categories: ['user/-/state/com.google/read'] }] });
      throw new Error(`Unexpected FreshRSS request ${path}`);
    } };
    const events = Array.from({ length: 800 }, (_, i) => ({ tStartMs: i * 1000, dDurationMs: 1000, segs: [{ utf8: `Synthetic transcript segment ${i}: independently verifiable evidence for a fictional topic.` }] }));
    const player = { videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '801' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en', languageCode: 'en' }] } } };
    const calls: { role: string; serialized: string }[] = [];
    const terminal = { status: 'succeeded' as const, inputTokens: null, outputTokens: null, costUsd: null, tokensSource: 'unknown' as const, costSource: 'unknown' as const, outcomeCode: null };
    app = await buildApplication({ databaseUrl: url, origin: 'http://localhost:3000', host: '127.0.0.1', port: 3000, trustedProxies: [], fresh, localProcessing: { classifierDaily: 250, classifierConcurrency: 1, automaticDaily, automaticConcurrency: 1, typesafeKey: 'not-used' } }, {
      web: { async get(input) {
        const path = new URL(input).pathname;
        if (path !== '/watch' && path !== '/api/timedtext') throw new Error(`Unexpected web request ${path}`);
        return { status: 200, finalUrl: input, headers: {}, body: Buffer.from(path === '/watch' ? `var ytInitialPlayerResponse = ${JSON.stringify(player)};` : JSON.stringify({ events })) };
      } },
      async createAi(usage) {
        const ai: AiPort = {
          async classify(request, scope) {
            return usage.executeAttempt({ ...request.model, role: request.role, bucket: scope.bucket, ...(scope.taskId ? { taskId: scope.taskId } : {}) }, scope, async (_signal, permit) => {
              permit.consume(); calls.push({ role: request.role, serialized: JSON.stringify(request) });
              let answer;
              if (request.role === 'quality') answer = { usable: { type: 'bool' as const, probability: 1 } };
              else if (request.role === 'category') {
                const question = request.questions.category;
                if (!question || question.type !== 'choice') throw new Error('Missing category choices');
                const id = Object.keys(question.criteria).find(key => key !== fallbackCategoryId)!;
                answer = { category: { type: 'choice' as const, choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } };
              } else if (request.role === 'scores') answer = { score: { type: 'score' as const, score: 3, confidence: 1, criteria: [] } };
              else throw new Error(`Unexpected classify role ${request.role}`);
              return { kind: 'success', value: { answers: answer, usage: null }, terminal };
            });
          },
          async generate(request, scope) {
            return usage.executeAttempt({ ...request.model, role: request.role, bucket: scope.bucket, ...(scope.taskId ? { taskId: scope.taskId } : {}) }, scope, async (_signal, permit) => {
              permit.consume(); calls.push({ role: request.role, serialized: JSON.stringify(request) });
              if (request.role !== 'tags' && request.role !== 'context_reduction') throw new Error(`Unexpected generation role ${request.role}`);
              return { kind: 'success', value: { text: request.role === 'tags' ? '{"tags":["synthetic topic"]}' : '{"items":[]}', usage: null }, terminal };
            });
          },
          async createRestrictedSession() { throw new Error('Unexpected session'); },
        };
        return ai;
      },
    });
    const response = await app.app.inject({ method: 'POST', url: '/api/v1/pipeline/runs', headers: { host: 'localhost:3000', 'content-type': 'application/json' }, payload: '{}' });
    expect(response.statusCode).toBe(202);
    let tasks: { action: string; state: string; error_code: string | null }[] = [];
    for (let i = 0; i < 300; i++) {
      tasks = (await db.pool.query("select t.action,t.state,t.error_code from processing_tasks t join articles a on a.id=t.article_id where a.freshrss_id='synthetic-video' order by t.created_at")).rows;
      if (tasks.filter(t => t.action === 'scores' && !['queued', 'running', 'waiting_dependency'].includes(t.state)).length === (includeContent ? 4 : 1)) break;
      await delay(100);
    }
    expect(tasks.map(t => t.action).sort()).toEqual(['prepare', 'category', 'tags', ...Array(includeContent ? 4 : 1).fill('scores')].sort());
    const ledger = (await db.pool.query('select role,bucket,status from usage_ledger')).rows;
    expect(ledger).toHaveLength(calls.length);
    expect(ledger.every(row => row.status === 'succeeded')).toBe(true);
    if (automaticDaily === 2) {
      expect(tasks.filter(t => t.action === 'scores').every(t => t.state === 'paused_budget' && t.error_code === 'daily_limit')).toBe(true);
      expect(calls.filter(call => call.role === 'context_reduction')).toHaveLength(1);
      expect(calls.filter(call => call.role === 'scores')).toHaveLength(0);
      expect(ledger.filter(row => row.bucket === 'automatic')).toHaveLength(2);
      expect((await db.pool.query('select count(*)::int as n from article_scores')).rows[0].n).toBe(0);
      const checkpoints = (await db.pool.query('select state from context_checkpoints')).rows;
      expect(checkpoints.some(({ state }) => state.completedChunks === 1 && !state.coverage.complete && state.coverage.missing.length > 0)).toBe(true);
      return;
    }
    expect(tasks.every(t => t.state === 'succeeded' && t.error_code === null)).toBe(true);
    expect(calls.filter(call => call.role === 'scores')).toHaveLength(includeContent ? 4 : 1);
    for (const call of calls) expect(Buffer.byteLength(call.serialized)).toBeLessThanOrEqual(20000);
    for (const role of ['quality', 'category', 'tags']) {
      const request = calls.find(call => call.role === role)!;
      expect(Buffer.byteLength(request.serialized)).toBeLessThanOrEqual(20000);
      expect(request.serialized).toContain('omitted');
    }
    const article = (await db.pool.query("select id,content_revision,category_id from articles where freshrss_id='synthetic-video'")).rows[0];
    expect(article.content_revision).toBe(1);
    expect(article.category_id).not.toBe(fallbackCategoryId);
    expect((await db.pool.query('select t.label from tags t join article_tags a on a.tag_id=t.id where a.article_id=$1', [article.id])).rows).toEqual([{ label: 'synthetic topic' }]);
    const scores = (await db.pool.query('select value,condensed,limited from article_scores where article_id=$1', [article.id])).rows;
    expect(scores).toEqual(Array.from({ length: includeContent ? 4 : 1 }, () => ({ value: 75, condensed: includeContent, limited: includeContent })));
    const checkpoints = (await db.pool.query("select c.state from context_checkpoints c join context_plans p on p.id=c.plan_id where p.article_id=$1", [article.id])).rows;
    expect(checkpoints).toHaveLength(includeContent ? 4 : 0);
    for (const { state } of checkpoints) expect(state.coverage).toMatchObject({ complete: true, missing: [] });
  } finally {
    try { await app?.close(); } finally { try { await boss?.stop(); } finally { try { await db?.close(); } finally { docker('rm', '--force', container); } } }
  }
}, 90000);
