import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { MailStore } from '../../src/server/adapters/postgres/mail-store.js';

describe('mail acknowledgement retries', () => {
  it.each([
    { code: '40P01', attempts: 3 },
    { code: '23505', attempts: 1 },
  ])('rolls back and stops after $attempts attempts for $code', async ({ code, attempts }) => {
    const failure = Object.assign(new Error('database error'), { code });
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith('select id, mail_state')) throw failure;
      return { rows: [] };
    });
    const release = vi.fn(() => { calls.push('release'); });
    const connect = vi.fn(async () => ({ query, release }));
    const store = new MailStore({ connect } as unknown as pg.Pool);
    await expect(store.acknowledge([])).rejects.toBe(failure);
    expect(connect).toHaveBeenCalledTimes(attempts);
    expect(calls).toEqual(Array.from({ length: attempts }, () => ['begin', expect.stringContaining('select id, mail_state'), 'rollback', 'release']).flat());
  });

  it('does not retry if rollback fails', async () => {
    const failure = Object.assign(new Error('deadlock'), { code: '40P01' });
    const rollbackFailure = new Error('rollback failed');
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('select id, mail_state')) throw failure;
      if (sql === 'rollback') throw rollbackFailure;
      return { rows: [] };
    });
    const release = vi.fn();
    const connect = vi.fn(async () => ({ query, release }));
    const store = new MailStore({ connect } as unknown as pg.Pool);
    await expect(store.acknowledge([])).rejects.toBe(rollbackFailure);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('mail queue cursors', () => {
  it('rejects malformed and impossible cursors before querying storage', async () => {
    const query = vi.fn();
    const store = new MailStore({ query } as unknown as pg.Pool);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const cursor of ['!', encode(null), encode({ v: 2 }), encode({ v: 1, id: 'bad', selectedAt: '2026-01-01T00:00:00.123456Z' }), encode({ v: 1, id: '00000000-0000-4000-8000-000000000001', selectedAt: '2026-02-30T00:00:00.123456Z' })]) {
      await expect(store.list(1, cursor)).rejects.toThrow('Invalid cursor');
    }
    expect(query).not.toHaveBeenCalled();
  });
});
