import { PgBoss } from 'pg-boss';
import { FreshRssClient } from './adapters/freshrss/client.js';
import { KarakeepClient } from './adapters/karakeep/client.js';
import { recoverKarakeep, startKarakeepWorker } from './adapters/postgres/karakeep-jobs.js';
import { createDatabase } from './adapters/postgres/client.js';
import { ImportStore } from './adapters/postgres/import-store.js';
import { startImportWorkers } from './adapters/postgres/import-runner.js';
import { ScoreAdmission } from './adapters/postgres/score-admission.js';
import { startScoreWorker } from './adapters/postgres/score-worker.js';
import type { AiPort } from './ports/ai.js';
import { buildHttpApp } from './http/app.js';
import type { AppConfig } from './config.js';

const unavailableAi: AiPort = {
  async classify() { throw new Error('AI is unavailable'); },
  async generate() { throw new Error('AI is unavailable'); },
  async createRestrictedSession() { throw new Error('AI is unavailable'); },
};

export async function buildApplication(config: AppConfig) {
  const database = createDatabase(config.databaseUrl);
  let boss: PgBoss | undefined;
  let recovery: NodeJS.Timeout | undefined;
  try {
    let imports;
    let karakeep;
    boss = new PgBoss({ connectionString: config.databaseUrl, migrate: false, createSchema: false });
    boss.on('error', () => { console.error('Job queue error'); });
    await boss.start();
    const scoreAdmission = new ScoreAdmission(database.db, boss);
    await startScoreWorker({ ...database, boss, ai: unavailableAi, resolveModels: async () => null });
    if (config.karakeep) {
      karakeep = await startKarakeepWorker(database.db, boss!, new KarakeepClient(config.karakeep));
      recovery = setInterval(() => { void recoverKarakeep(database.db, boss!).catch(() => { console.error('Karakeep recovery failed'); }); }, 60_000);
      recovery.unref();
    }
    if (config.fresh) {
      const fresh = new FreshRssClient(config.fresh);
      const context = await new ImportStore(database.db).ensureContext(config.fresh.baseUrl, config.fresh.email);
      const jobs = await startImportWorkers(database.pool, database.db, boss!, async id => {
        if (id !== context.id) throw new Error('Unknown import context');
        return fresh;
      }, [context.id]);
      imports = { jobs, contextId: context.id };
    }
    const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: config.origin, trustedProxies: config.trustedProxies, scoreAdmission, ...(imports ? { imports } : {}), ...(karakeep ? { karakeep } : {}) });
    return { app, async close() { if (recovery) clearInterval(recovery); await app.close(); if (boss) await boss.stop({ timeout: 30000 }); await database.close(); } };
  } catch (error) { if (recovery) clearInterval(recovery); if (boss) await boss.stop().catch(() => {}); await database.close(); throw error; }
}
