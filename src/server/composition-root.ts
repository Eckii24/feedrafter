import { PgBoss } from 'pg-boss';
import { FreshRssClient } from './adapters/freshrss/client.js';
import { KarakeepClient } from './adapters/karakeep/client.js';
import { recoverKarakeep, startKarakeepWorker } from './adapters/postgres/karakeep-jobs.js';
import { createDatabase } from './adapters/postgres/client.js';
import { ImportStore } from './adapters/postgres/import-store.js';
import { startImportWorkers } from './adapters/postgres/import-runner.js';
import { startLocalProcessing } from './local-processing.js';
import { buildHttpApp } from './http/app.js';
import type { AppConfig } from './config.js';

export async function buildApplication(config: AppConfig, overrides?: Parameters<typeof startLocalProcessing>[0]['overrides']) {
  const database = createDatabase(config.databaseUrl);
  let boss: PgBoss | undefined;
  let recovery: NodeJS.Timeout | undefined;
  let local: Awaited<ReturnType<typeof startLocalProcessing>> | undefined;
  try {
    let imports;
    let karakeep;
    boss = new PgBoss({ connectionString: config.databaseUrl, migrate: false, createSchema: false });
    boss.on('error', () => { console.error('Job queue error'); });
    await boss.start();
    if (config.localProcessing) local = await startLocalProcessing({ ...database, boss, config: config.localProcessing, ...(overrides ? { overrides } : {}) });
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
    const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: config.origin, trustedProxies: config.trustedProxies, ...(local ? { processArticles: local.processArticles } : {}), ...(imports ? { imports } : {}), ...(karakeep ? { karakeep } : {}) });
    return { app, async close() { if (recovery) clearInterval(recovery); try { await app.close(); } finally { try { await local?.close(); } finally { try { if (boss) await boss.stop({ timeout: 30000 }); } finally { await database.close(); } } } } };
  } catch (error) { if (recovery) clearInterval(recovery); await local?.close().catch(() => {}); if (boss) await boss.stop().catch(() => {}); await database.close(); throw error; }
}
