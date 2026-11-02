import { PgBoss } from 'pg-boss';
import { FreshRssClient } from './adapters/freshrss/client.js';
import { createDatabase } from './adapters/postgres/client.js';
import { ImportStore } from './adapters/postgres/import-store.js';
import { startImportWorkers } from './adapters/postgres/import-runner.js';
import { buildHttpApp } from './http/app.js';
import type { AppConfig } from './config.js';

export async function buildApplication(config: AppConfig) {
  const database = createDatabase(config.databaseUrl);
  let boss: PgBoss | undefined;
  try {
    let imports;
    if (config.fresh) {
      const fresh = new FreshRssClient(config.fresh);
      const context = await new ImportStore(database.db).ensureContext(config.fresh.baseUrl, config.fresh.email);
      boss = new PgBoss({ connectionString: config.databaseUrl, migrate: false, createSchema: false });
      boss.on('error', () => { console.error('Import queue error'); });
      await boss.start();
      const jobs = await startImportWorkers(database.pool, database.db, boss, async id => {
        if (id !== context.id) throw new Error('Unknown import context');
        return fresh;
      }, [context.id]);
      imports = { jobs, contextId: context.id };
    }
    const app = await buildHttpApp({ db: database.db, pool: database.pool, origin: config.origin, trustedProxies: config.trustedProxies, ...(imports ? { imports } : {}) });
    return { app, async close() { await app.close(); if (boss) await boss.stop({ timeout: 30000 }); await database.close(); } };
  } catch (error) { if (boss) await boss.stop().catch(() => {}); await database.close(); throw error; }
}
