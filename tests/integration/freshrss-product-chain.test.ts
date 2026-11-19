import { expect, it } from 'vitest';
import { FreshRssClient } from '../../src/server/adapters/freshrss/client.js';
import { provisionImportQueues, startImportWorkers } from '../../src/server/adapters/postgres/import-runner.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { articleProcessingFixture, eventually } from '../helpers/article-processing-fixture.js';

it('connects a FreshRSS fixture to the real import queue and manually prepared article chain', async () => {
  const paths: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('http://127.0.0.1:1');
    paths.push(url.pathname);
    if (url.pathname.endsWith('/accounts/ClientLogin')) {
      expect(init?.method).toBe('POST');
      return new Response('Auth=fixture-token\n');
    }
    expect(new Headers(init?.headers).get('authorization')).toBe('GoogleLogin auth=fixture-token');
    if (url.pathname.endsWith('/stream/contents/user/-/state/com.google/reading-list')) return Response.json({ items: [{ id: 'fixture-item', title: 'Synthetic product article', alternate: [{ href: 'https://example.com/article' }] }] });
    if (url.pathname.endsWith('/stream/items/contents')) return Response.json({ items: [{ id: 'fixture-item', categories: [] }] });
    throw new Error('Unexpected fixture request');
  };
  const fresh = new FreshRssClient({ baseUrl: 'http://127.0.0.1:1/api/greader.php', email: 'fixture', password: 'fixture', transport });
  const f = await articleProcessingFixture(async (db, boss) => {
    await provisionImportQueues(boss);
    const store = new ImportStore(db.db);
    await store.saveSettings({ importEnabled: false, importIntervalSeconds: 14400, nextImportAt: null });
    const context = await store.ensureContext('http://127.0.0.1:1/api/greader.php', 'fixture');
    const jobs = await startImportWorkers(db.pool, db.db, boss, async () => fresh, [context.id]);
    const { run } = await jobs.startImport(context.id);
    await eventually(async () => (await db.pool.query('select status from processing_runs where id=$1', [run.id])).rows[0]?.status === 'succeeded');
    const row = (await db.pool.query('select id, url from articles where context_id=$1 and freshrss_id=$2', [context.id, 'fixture-item'])).rows[0];
    expect(row?.url).toBe('https://example.com/article');
    expect((await db.pool.query('select pending_count from processing_runs where id=$1', [run.id])).rows[0].pending_count).toBe(1);
    return row.id as string;
  });
  try {
    expect(paths).toEqual(expect.arrayContaining(['/api/greader.php/accounts/ClientLogin', '/api/greader.php/reader/api/0/stream/items/contents']));
    expect(paths.some(path => path.includes('edit-tag'))).toBe(false);
    await f.startWorkers();
    await eventually(async () => {
      const rows = await f.database.pool.query('select state from processing_tasks where id=any($1::uuid[])', [[f.admitted.categoryTaskId, f.admitted.tagsTaskId, ...f.admitted.scoreTaskIds]]);
      return rows.rows.length === 3 && rows.rows.every(row => row.state === 'succeeded');
    });
    expect(f.calls).toEqual(['category', 'tags', 'scores']);
    expect(f.preparationFetches).toBe(1);
    expect((await f.database.pool.query('select revision from article_contents where article_id=$1', [f.article])).rows[0].revision).toBe(1);
  } finally { await f.close(); }
}, 60000);
