import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { buildHttpApp } from '../../src/server/http/app.js';

let database: Awaited<ReturnType<typeof createUsageDatabase>>;
let app: Awaited<ReturnType<typeof buildHttpApp>>;
const headers = { host: 'localhost:3000' };
const ready = async () => (await app.inject({ url: '/api/v1/health/ready', headers })).statusCode;

beforeAll(async () => {
  database = await createUsageDatabase();
  app = await buildHttpApp({ db: database.db, pool: database.pool, origin: 'http://localhost:3000', trustedProxies: [] });
}, 30000);
afterAll(async () => { try { if (app) await app.close(); } finally { if (database) await database.dispose(); } });

describe('usage migration', () => {
  it('upgrades 0004 conservatively, updates readiness, and reruns without changes', async () => {
    expect(await ready()).toBe(503);
    expect((await database.pool.query("select to_regclass('drizzle.__drizzle_migrations') as migrations")).rows[0].migrations).toBeNull();
    const folder = await mkdtemp(join(tmpdir(), 'usage-old-'));
    try {
      await mkdir(join(folder, 'meta'));
      const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')) as { entries: { tag: string }[] };
      journal.entries = journal.entries.slice(0, 5);
      await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
      for (const entry of journal.entries) await copyFile(`drizzle/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`));
      await migrateDatabase(database.pool, folder);
      expect(await ready()).toBe(503);
      await database.pool.query("update budget_settings set daily_requests=7 where bucket='automatic'; update model_roles set provider='edited', model='edited' where role='summary'; update categories set label='edited' where id='00000000-0000-4000-8000-000000000001'; insert into request_counters(day_utc,bucket,requests) values ('2026-01-01','automatic',42)");
      await database.pool.query("insert into usage_ledger(bucket,role,provider,model,occurred_at,status,input_tokens,output_tokens,audio_seconds) values ('automatic','summary','p','m','2026-01-01','reserved',null,null,null), ('automatic','summary','p','m','2026-01-02','succeeded',0,3,1), ('classifier','quality','p','m','2026-01-03','failed',2,null,null), ('interactive','chat','p','m','2026-01-04','reserved',5,0,null)");
      const before = (await database.pool.query('select * from usage_ledger order by occurred_at')).rows;
      const budgets = (await database.pool.query('select * from budget_settings order by bucket')).rows;
      const roles = (await database.pool.query('select * from model_roles order by role')).rows;
      const categories = (await database.pool.query('select * from categories order by id')).rows;
      const scores = (await database.pool.query('select * from score_definitions order by id')).rows;
      const tasks = (await database.pool.query('select * from processing_tasks order by id')).rows;
      const runs = (await database.pool.query('select * from processing_runs order by id')).rows;
      const counters = (await database.pool.query('select * from request_counters order by day_utc, bucket')).rows;
      const started = new Date();
      await migrateDatabase(database.pool);
      expect(await ready()).toBe(200);
      const after = (await database.pool.query('select * from usage_ledger order by occurred_at')).rows;
      for (let i = 0; i < before.length; i++) {
        const { owner_token, owner_pid, owner_backend_start, settled_at, outcome_code, task_id, turn_id, cost_usd, tokens_source, cost_source, ...oldColumns } = after[i];
        expect([owner_token, owner_pid, owner_backend_start, task_id, turn_id, cost_usd]).toEqual([null, null, null, null, null, null]);
        expect([tokens_source, cost_source]).toEqual(['unknown', 'unknown']);
        const legacyReservation = before[i].status === 'reserved';
        expect(oldColumns).toEqual({ ...before[i], ...(legacyReservation ? { status: 'uncertain' } : {}) });
        expect(outcome_code).toBe(legacyReservation ? 'legacy_ownerless_reservation' : null);
        if (legacyReservation) { expect(settled_at).toBeInstanceOf(Date); expect(settled_at.getTime()).toBeGreaterThanOrEqual(started.getTime() - 1000); expect(settled_at.getTime()).toBeLessThanOrEqual(Date.now()); } else expect(settled_at).toBeNull();
      }
      expect((await database.pool.query('select * from budget_settings order by bucket')).rows).toEqual(budgets);
      expect((await database.pool.query('select * from model_roles order by role')).rows).toEqual(roles);
      expect((await database.pool.query('select * from categories order by id')).rows).toEqual(categories);
      expect((await database.pool.query('select * from score_definitions order by id')).rows).toEqual(scores);
      expect((await database.pool.query('select * from processing_tasks order by id')).rows).toEqual(tasks);
      expect((await database.pool.query('select * from processing_runs order by id')).rows).toEqual(runs);
      expect((await database.pool.query('select * from request_counters order by day_utc, bucket')).rows).toEqual(counters);
      expect((await database.pool.query('select requests from request_counters')).rows).toEqual([{ requests: 42 }]);
      expect((await database.pool.query("select daily_requests from budget_settings where bucket='automatic'")).rows[0].daily_requests).toBe(7);
      expect((await database.pool.query("select provider,model from model_roles where role='summary'")).rows[0]).toEqual({ provider: 'edited', model: 'edited' });
      expect((await database.pool.query("select label from categories where id='00000000-0000-4000-8000-000000000001'")).rows[0].label).toBe('edited');
      const versions = (await database.pool.query('select * from drizzle.__drizzle_migrations order by id')).rows;
      await migrateDatabase(database.pool);
      expect((await database.pool.query('select * from drizzle.__drizzle_migrations order by id')).rows).toEqual(versions);
      expect((await database.pool.query('select * from usage_ledger order by occurred_at')).rows).toEqual(after);
      await database.pool.query('insert into drizzle.__drizzle_migrations(hash,created_at) values ($1,$2)', ['mismatch', '9999999999999']);
      expect(await ready()).toBe(503);
      await database.pool.query("delete from drizzle.__drizzle_migrations where hash='mismatch'");
    } finally { await rm(folder, { recursive: true, force: true }); }
  });

  it('enforces ownership, state, provenance and amount constraints', async () => {
    const base = "insert into usage_ledger(bucket,role,provider,model,occurred_at,status,owner_token,owner_pid,owner_backend_start,settled_at,cost_usd,tokens_source,cost_source) values ('automatic','summary','p','m',now(),$1,$2,$3,$4,$5,$6,$7,$8)";
    const token = randomUUID();
    const row = ['reserved', token, 123, '2026-01-01T00:00:00.123456Z', null, null, 'unknown', 'unknown'];
    await database.pool.query(base, row);
    for (const patch of [
      { 1: null }, { 2: null }, { 3: null }, { 1: null, 2: null, 3: null }, { 2: 0 }, { 2: -1 }, { 4: new Date() }, { 0: 'other' },
      { 0: 'failed', 1: null }, { 0: 'failed', 6: 'invalid' }, { 0: 'failed', 7: 'invalid' },
      { 0: 'failed', 5: -1 }, { 0: 'failed', 5: 'NaN' }, { 0: 'failed', 5: 'Infinity' }, { 0: 'failed', 5: '-Infinity' },
    ]) {
      const values = [...row]; Object.assign(values, patch); if (values[1] === token) values[1] = randomUUID();
      await expect(database.pool.query(base, values)).rejects.toThrow();
    }
    await expect(database.pool.query(base, row)).rejects.toThrow();
    await database.pool.query(base, ['succeeded', null, null, null, null, 0, 'provider', 'provider']);
    for (const column of ['input_tokens', 'output_tokens', 'audio_seconds']) {
      for (const value of column === 'audio_seconds' ? ['-1', 'NaN', 'Infinity', '-Infinity'] : ['-1']) {
        await expect(database.pool.query(`insert into usage_ledger(bucket,role,provider,model,occurred_at,status,${column}) values ('automatic','summary','p','m',now(),'failed',$1)`, [value])).rejects.toThrow();
      }
    }
  });

  it('migrates an empty database from scratch', async () => {
    const other = await createUsageDatabase();
    try {
      await migrateDatabase(other.pool);
      expect((await other.pool.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n).toBe(6);
      expect((await other.pool.query("select column_name from information_schema.columns where table_name='usage_ledger' and column_name='owner_token'")).rowCount).toBe(1);
      await migrateDatabase(other.pool);
      expect((await other.pool.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n).toBe(6);
    } finally { await other.dispose(); }
  }, 30000);
});
