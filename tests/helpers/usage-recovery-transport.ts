import assert from 'node:assert/strict';
import type { Duplex } from 'node:stream';
import pg from 'pg';
import { PostgresUsageAdmissionStore } from '../../src/server/adapters/postgres/usage-admission-store.js';

const [connectionString, phase] = process.argv.slice(2);
const pool = new pg.Pool({ connectionString, max: 1 });
await pool.query(`insert into usage_ledger(bucket,role,provider,model,occurred_at,status,owner_token,owner_pid,owner_backend_start)
  values ('automatic','summary','p','m','2018-01-01','reserved',gen_random_uuid(),2147483647,'2018-01-01')`);
let releases = 0;
let destroyed = false;
let originalPid = 0;
const statements: string[] = [];
const recoveryPool = new Proxy(pool, { get(target, key) {
  if (key === 'connect') return async () => {
    const client = await target.connect();
    originalPid = client.processID;
    const reset = () => (client as unknown as { connection: { stream: Duplex } }).connection.stream.destroy(Object.assign(new Error('transport reset'), { code: 'ECONNRESET' }));
    return new Proxy(client, { get(inner, property) {
      if (property === 'release') return (destroy: boolean) => { releases++; destroyed = destroy; inner.release(destroy); };
      if (property === 'query') return async (...args: unknown[]) => {
        const sql = String(args[0]);
        statements.push(sql);
        if (phase === 'active' && sql.includes('pg_stat_clear_snapshot')) {
          const pending = inner.query('select pg_sleep(0.05)');
          setImmediate(reset);
          await pending;
        }
        const result = await (Reflect.apply(inner.query, inner, args) as Promise<unknown>);
        if (phase === 'between' && sql.includes('from usage_ledger l left join')) {
          reset();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (phase === 'commit' && sql === 'commit') {
          inner.emit('error', Object.assign(new Error('transport reset'), { code: 'ECONNRESET' }));
        }
        return result;
      };
      const value = Reflect.get(inner, property, inner) as unknown;
      return typeof value === 'function' ? value.bind(inner) : value;
    } });
  };
  const value = Reflect.get(target, key, target) as unknown;
  return typeof value === 'function' ? value.bind(target) : value;
} });
try {
  await assert.rejects(new PostgresUsageAdmissionStore(recoveryPool, { now: () => new Date() }).recover(), /transport reset/);
  assert.equal(releases, 1);
  assert.equal(destroyed, true);
  assert.equal(statements.some((sql) => /^\s*update usage_ledger/i.test(sql)), phase === 'commit');
  const replacement = await pool.connect();
  assert.notEqual(replacement.processID, originalPid);
  replacement.release();
  const rows = await pool.query('select status from usage_ledger');
  assert.deepEqual(rows.rows, [{ status: phase === 'commit' ? 'uncertain' : 'reserved' }]);
  console.log('transport contained');
} finally { await pool.end(); }
