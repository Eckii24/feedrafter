import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { PgBoss } from 'pg-boss';
import { provisionArticleQueues, startArticleWorkers } from '../../src/server/adapters/postgres/article-worker.js';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';
import { processExplicitArticles } from '../../src/server/adapters/postgres/explicit-article-processing.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { provisionScoreQueue, ScoreAdmission } from '../../src/server/adapters/postgres/score-admission.js';
import { startScoreWorker } from '../../src/server/adapters/postgres/score-worker.js';
import { UsageAttemptError } from '../../src/server/application/usage.js';
import { buildHttpApp } from '../../src/server/http/app.js';
import type { AiPort } from '../../src/server/ports/ai.js';
import { fallbackCategoryId } from '../../src/shared/taxonomy.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();
const model = (name: string) => ({ model: { provider: 'fake', model: name }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: () => 1 });

export async function eventually(check: () => Promise<boolean>, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error('Timed out waiting for fixture state');
}

/** Owns only a new, randomly named local container. Never accepts a database URL. */
export async function articleProcessingFixture(importArticle?: (database: ReturnType<typeof createDatabase>, boss: PgBoss) => Promise<string>) {
  let container = '';
  let database: ReturnType<typeof createDatabase> | undefined;
  let boss: PgBoss | undefined;
  let app: Awaited<ReturnType<typeof buildHttpApp>> | undefined;
  let articleWorker: Awaited<ReturnType<typeof startArticleWorkers>> | undefined;
  let scoreWorker: Awaited<ReturnType<typeof startScoreWorker>> | undefined;
  const close = async () => {
    try { await articleWorker?.close(); }
    finally {
      try { await scoreWorker?.close(); }
      finally {
        try { await app?.close(); }
        finally {
          try { await boss?.stop(); }
          finally { try { await database?.close(); } finally { if (container) { docker('rm', '--force', container); container = ''; } } }
        }
      }
    }
  };
  try {
    container = docker('run', '--detach', '--rm', '--pull=never', '--name', `feedrafter-product-${randomUUID()}`, '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
    const port = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'));
    if (!port) throw new Error('Unexpected PostgreSQL port');
    const url = `postgresql://postgres:disposable-test-only@127.0.0.1:${port[1]}/feedrafter_test`;
    database = createDatabase(url);
    const db = database;
    await eventually(async () => { try { await db.pool.query('select 1'); return true; } catch { return false; } });
    const version = Number((await db.pool.query('show server_version_num')).rows[0].server_version_num);
    if (version < 180000 || version >= 190000) throw new Error('Expected PostgreSQL 18');
    await migrateDatabase(db.pool);
    boss = new PgBoss({ connectionString: url }); boss.on('error', () => {}); await boss.start();
    await provisionArticleQueues(boss); await provisionScoreQueue(boss);
    await db.pool.query("update model_roles set provider='fake',model=case role when 'tags' then 'tags' when 'context_reduction' then 'generator' else 'classifier' end where role in ('category','tags','scores','context_reduction')");
    const target = (await db.pool.query('select id from score_definitions order by id limit 1')).rows[0].id as string;
    await db.pool.query('update score_definitions set active=(id=$1), include_title=true, include_content=true, include_category=true, include_tag_weights=true, include_source_weight=false', [target]);
    let article: string;
    if (importArticle) article = await importArticle(db, boss);
    else {
      const context = await new ImportStore(db.db).ensureContext('product-fixture', 'synthetic');
      const [imported] = await new ImportStore(db.db).importPageWithIdentities(context.id, [{ id: randomUUID(), title: 'Synthetic product article', url: 'https://example.com/article', author: null, publishedAt: null, feedId: null, feedTitle: null }], new Date());
      if (!imported?.inserted) throw new Error('Synthetic import failed');
      article = imported.id;
    }
    const body = Buffer.from(`<html><head><title>Report</title></head><body><article><h1>Report</h1><p>${'A synthetic report with independent details and meaningful factual information. '.repeat(30)}</p></article></body></html>`);
    let preparationFetches = 0;
    const [processed] = await processExplicitArticles({ db: db.db, boss, web: { async get() { preparationFetches++; return { status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': 'text/html' }, body }; } }, classifier: { async classify() { return { usable: true, probability: 1 }; } } }, [article]);
    if (!processed || processed.kind !== 'admission' || processed.admission.kind !== 'admitted') throw new Error(`Processing ${processed?.kind}`);
    const preparation = { id: processed.prepareTaskId };
    const admitted = processed.admission;
    const calls: string[] = [];
    let scoreMode: 'initial' | 'changed' | 'failed' = 'initial';
    const ai: AiPort = {
      async classify(request) {
        calls.push(request.role);
        if (request.role === 'category') {
          const question = request.questions.category;
          if (!question || question.type !== 'choice') throw new Error('Missing category choices');
          const id = Object.keys(question.criteria).find(key => key !== fallbackCategoryId);
          if (!id) throw new Error('Missing category');
          return { kind: 'completed', value: { answers: { category: { type: 'choice', choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === id ? 1 : 0])) } }, usage: null } };
        }
        if (scoreMode === 'failed') throw new UsageAttemptError('synthetic failure', 'aborted');
        return { kind: 'completed', value: { answers: { score: { type: 'score', score: scoreMode === 'initial' ? 1 : 3, confidence: 1, criteria: [] } }, usage: null } };
      },
      async generate() { calls.push('tags'); return { kind: 'completed', value: { text: '{"tags":["synthetic topic"]}', usage: null } }; },
      async createRestrictedSession() { throw new Error('Unexpected session'); },
    };
    const socket = createServer();
    await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
    const address = socket.address();
    if (!address || typeof address === 'string') throw new Error('No HTTP port');
    const origin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    app = await buildHttpApp({ ...db, origin, trustedProxies: [], scoreAdmission: new ScoreAdmission(db.db, boss) });
    await app.listen({ host: '127.0.0.1', port: address.port });
    const queue = boss;
    return { database: db, boss: queue, origin, article, preparation, admitted, target, calls, close,
      get preparationFetches() { return preparationFetches; },
      setScoreMode(mode: typeof scoreMode) { scoreMode = mode; },
      async startWorkers() {
        articleWorker = await startArticleWorkers({ ...db, boss: queue, ai, resolveCategoryModel: async () => model('classifier'), resolveTagModel: async () => model('tags') });
        scoreWorker = await startScoreWorker({ ...db, boss: queue, ai, resolveModels: async () => ({ classifier: model('classifier'), generator: model('generator') }) });
      },
    };
  } catch (error) { await close(); throw error; }
}
