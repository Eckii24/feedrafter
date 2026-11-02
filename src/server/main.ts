import { PgBoss } from 'pg-boss';
import { loadConfig } from './config.js';
import { buildApplication } from './composition-root.js';
import { createDatabase } from './adapters/postgres/client.js';
import { migrateDatabase } from './adapters/postgres/migrate.js';
import { provisionImportQueues } from './adapters/postgres/import-runner.js';

async function main() {
  const command = process.argv[2] ?? 'serve';
  if (process.argv.length > 3 || !['serve', 'migrate'].includes(command)) throw new Error('Invalid command');
  const config = loadConfig(process.env);
  if (command === 'migrate') {
    const database = createDatabase(config.databaseUrl);
    const boss = new PgBoss({ connectionString: config.databaseUrl });
    boss.on('error', () => { console.error('Import queue error'); });
    try {
      const lock = await database.pool.connect();
      try { await lock.query('select pg_advisory_lock($1, $2)', [18420, 2]); await migrateDatabase(database.pool); await boss.start(); await provisionImportQueues(boss); }
      finally { try { await lock.query('select pg_advisory_unlock($1, $2)', [18420, 2]); } finally { lock.release(); } }
    } finally { await boss.stop().catch(() => {}); await database.close(); }
    return;
  }
  const application = await buildApplication(config);
  try { await application.app.listen({ host: config.host, port: config.port }); }
  catch (error) { await application.close(); throw error; }
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; const timer = setTimeout(() => process.exit(1), 35000); timer.unref(); void application.close().then(() => clearTimeout(timer)).catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
main().catch(() => { console.error('Application failed'); process.exitCode = 1; });
