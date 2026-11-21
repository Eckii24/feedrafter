import { accessSync, constants, lstatSync } from 'node:fs';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import type { ModelRoleSettings } from '../shared/settings.js';
import { createPiClassifier, createPiCodexGenerator } from './adapters/pi/runtime.js';
import { startArticleWorkers } from './adapters/postgres/article-worker.js';
import type { Database } from './adapters/postgres/client.js';
import { processExplicitArticles } from './adapters/postgres/explicit-article-processing.js';
import { assertLocalInferenceQueuesEmpty } from './adapters/postgres/local-queue-preflight.js';
import { startScoreWorker } from './adapters/postgres/score-worker.js';
import { PostgresUsageAdmissionStore } from './adapters/postgres/usage-admission-store.js';
import { createPublicWeb } from './adapters/web/request.js';
import { createArticleQualityClassifier } from './application/classify-article-quality.js';
import type { UnverifiedLocalModel } from './application/score-context-request.js';
import { UsageService } from './application/usage.js';
import type { AppConfig } from './config.js';
import { systemClock } from './domain/clock.js';
import type { AiPort } from './ports/ai.js';
import type { PublicWeb } from './ports/public-web.js';

const classifier = { provider: 'typesafe', model: 'jev-latest' };
const generator = { provider: 'openai-codex', model: 'gpt-6-luna' };
const roles: ModelRoleSettings[] = [
  ...(['quality', 'category', 'scores'] as const).map(role => ({ role, primary: classifier, fallback: null })),
  ...(['tags', 'context_reduction'] as const).map(role => ({ role, primary: generator, fallback: null })),
];
// Local operator accepts that one byte per token, framing and output reserves are unverified.
const policy = (model: typeof classifier): UnverifiedLocalModel => ({ kind: 'unverified', model, limits: { contextTokens: 32000, outputTokens: 4096, framingTokens: 1024, maxRequestBytes: 20000 } });

function assertPrivateAuth(): void {
  for (const [path, directory] of [['/data/pi-auth', true], ['/data/pi-auth/auth.json', false]] as const) {
    const stat = lstatSync(path);
    if ((directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Pi auth directory and file must be private and owned by the app user');
    accessSync(path, constants.R_OK | constants.W_OK | (directory ? constants.X_OK : 0));
  }
}

type Overrides = { createAi: (usage: UsageService, mappings: readonly ModelRoleSettings[]) => Promise<AiPort>; web: PublicWeb };
/** Explicit local-only composition. Overrides exist for disposable-database tests. */
export async function startLocalProcessing(deps: { db: Database; pool: pg.Pool; boss: PgBoss; config: NonNullable<AppConfig['localProcessing']>; overrides?: Overrides }) {
  const { db, pool, boss, config, overrides } = deps;
  try { await assertLocalInferenceQueuesEmpty(pool); }
  catch (error) { console.error('Local processing refused: inference queues missing or contain work. See README prerequisites.'); throw error; }
  const stored = await pool.query<{ role: string; provider: string | null; model: string | null }>("select role, provider, model from model_roles where role = any($1::text[])", [roles.map(r => r.role)]);
  if (stored.rows.length !== roles.length || roles.some(r => !stored.rows.some(s => s.role === r.role && s.provider === r.primary?.provider && s.model === r.primary.model))) {
    console.error('Local processing refused: configure model roles as described in README.');
    throw new Error('Local model roles must be configured for jev-latest and gpt-6-luna');
  }
  const usage = new UsageService(new PostgresUsageAdmissionStore(pool, systemClock, pool, {
    classifier: { daily: config.classifierDaily, concurrency: config.classifierConcurrency },
    automatic: { daily: config.automaticDaily, concurrency: config.automaticConcurrency },
  }));
  let ai: AiPort;
  if (overrides) ai = await overrides.createAi(usage, roles);
  else {
    try { assertPrivateAuth(); }
    catch (error) { console.error('Local processing refused: Pi auth directory/file must be private and writable. See README.'); throw error; }
    process.env.TYPESAFE_API_KEY = config.typesafeKey;
    const [c, g] = await Promise.all([createPiClassifier(usage, roles), createPiCodexGenerator(usage, roles)]);
    ai = { ...c, ...g, async createRestrictedSession() { throw new Error('Sessions unavailable'); } };
  }
  const c = policy(classifier); const g = policy(generator);
  const quality = createArticleQualityClassifier(ai, c);
  const articles = await startArticleWorkers({ db, pool, boss, ai, resolveCategoryModel: async () => c, resolveTagModel: async () => g });
  try {
    const scores = await startScoreWorker({ db, pool, boss, ai, resolveModels: async () => ({ classifier: c, generator: g }) });
    return {
      processArticles: (ids: readonly string[]) => processExplicitArticles({ db, boss, web: overrides?.web ?? createPublicWeb(), classifier: quality }, ids),
      async close() { try { await articles.close(); } finally { await scores.close(); } },
    };
  } catch (error) { await articles.close(); throw error; }
}
