import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '../../src/server/adapters/postgres/client.js';

const docker = (...args: string[]) => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();

export async function createUsageDatabase() {
  const container = docker('run', '--detach', '--rm', '--pull=never', '--name', `feedrafter-usage-${randomUUID()}`, '-e', 'POSTGRES_PASSWORD=disposable-test-only', '-e', 'POSTGRES_DB=feedrafter_test', '-p', '127.0.0.1::5432', 'postgres:18');
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const port = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', container, '5432/tcp'));
    if (!port) throw new Error('Unexpected PostgreSQL port');
    database = createDatabase(`postgresql://postgres:disposable-test-only@127.0.0.1:${port[1]}/feedrafter_test`);
    for (let i = 0; i < 100; i++) {
      try { await database.pool.query('select 1'); return { ...database, async dispose() { try { await database!.close(); } finally { docker('rm', '--force', container); } } }; } catch { await delay(200); }
    }
    throw new Error('Disposable PostgreSQL did not become ready');
  } catch (error) {
    try { if (database) await database.close(); } finally { docker('rm', '--force', container); }
    throw error;
  }
}
