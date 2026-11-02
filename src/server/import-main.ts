import { PgBoss } from 'pg-boss';
import { FreshRssClient } from './adapters/freshrss/client.js';
import { createDatabase } from './adapters/postgres/client.js';
import { ImportStore } from './adapters/postgres/import-store.js';
import { provisionImportQueues, startImportWorkers } from './adapters/postgres/import-runner.js';
import { migrateDatabase } from './adapters/postgres/migrate.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const connectionString = required('DATABASE_URL');
  const database = createDatabase(connectionString);
  const provision = process.argv[2] === '--provision';
  if (process.argv.length > (provision ? 3 : 2)) throw new Error('Unexpected argument');
  const boss = new PgBoss({ connectionString, migrate: provision, createSchema: provision });
  boss.on('error', () => { console.error('Import queue error'); });
  try {
    if (provision) {
      const lock = await database.pool.connect();
      try {
        await lock.query('select pg_advisory_lock($1, $2)', [18420, 2]);
        await migrateDatabase(database.pool);
        await boss.start();
        await provisionImportQueues(boss);
      } finally {
        try { await lock.query('select pg_advisory_unlock($1, $2)', [18420, 2]); }
        finally { lock.release(); }
      }
      await boss.stop();
      await database.close();
      return;
    }
    const baseUrl = required('FRESHRSS_BASE_URL');
    const email = required('FRESHRSS_EMAIL');
    const fresh = new FreshRssClient({ baseUrl, email, password: required('FRESHRSS_API_PASSWORD') });
    const context = await new ImportStore(database.db).ensureContext(baseUrl, email);
    await boss.start();
    await startImportWorkers(database.pool, database.db, boss, async (contextId) => {
      if (contextId !== context.id) throw new Error('FreshRSS context is not configured');
      return fresh;
    }, [context.id]);
    const stop = async () => { await boss.stop(); await database.close(); };
    process.once('SIGTERM', () => { void stop(); });
    process.once('SIGINT', () => { void stop(); });
  } catch (error) {
    await boss.stop().catch(() => {});
    await database.close();
    throw error;
  }
}

main().catch(() => { console.error('Import worker failed to start'); process.exitCode = 1; });
