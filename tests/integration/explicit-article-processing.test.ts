import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { expect, it } from 'vitest';
import { processExplicitArticles } from '../../src/server/adapters/postgres/explicit-article-processing.js';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { ScoreAdmission } from '../../src/server/adapters/postgres/score-admission.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { articleProcessingFixture } from '../helpers/article-processing-fixture.js';

it('bounds explicit processing, fences concurrent first attempts, and never recovers or retries implicitly', async () => {
  const f = await articleProcessingFixture();
  try {
    const store = new ImportStore(f.database.db);
    const context = await store.ensureContext('explicit-test', 'synthetic');
    const create = async () => {
      const [row] = await store.importPageWithIdentities(context.id, [{ id: randomUUID(), title: 'Test', url: 'https://example.com/article', author: null, publishedAt: null, feedId: null, feedTitle: null }], new Date());
      if (!row) throw new Error('Import failed');
      return row.id;
    };
    const body = Buffer.from(`<html><body><article><h1>Report</h1><p>${'A synthetic report with useful factual details. '.repeat(50)}</p></article></body></html>`);
    let fetches = 0;
    const deps = { db: f.database.db, boss: f.boss, web: { async get() { fetches++; return { status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': 'text/html' }, body }; } }, classifier: { async classify() { return { usable: true, probability: 1 }; } } };
    const article = await create();
    await expect(processExplicitArticles(deps, [article, article.toUpperCase()])).rejects.toThrow();
    await expect(processExplicitArticles(deps, Array.from({ length: 21 }, randomUUID))).rejects.toThrow();
    await expect(processExplicitArticles(deps, [article, 'invalid'])).rejects.toThrow();
    expect(fetches).toBe(0);
    const results = await Promise.all([processExplicitArticles(deps, [article]), processExplicitArticles(deps, [article])]);
    expect(results.flat().map(result => result.kind).sort()).toEqual(['admission', 'already_started']);
    expect(fetches).toBe(1);
    const rows = await f.database.pool.query('select action, state from processing_tasks where article_id=$1', [article]);
    expect(rows.rows.filter(row => row.action === 'prepare')).toEqual([{ action: 'prepare', state: 'succeeded' }]);
    expect(rows.rows.filter(row => row.action === 'category')).toHaveLength(1);

    const failed = await create();
    const failedDeps = { ...deps, classifier: { async classify() { return { usable: false, probability: 0 }; } } };
    expect((await processExplicitArticles(failedDeps, [failed]))[0]?.kind).toBe('failed');
    expect((await processExplicitArticles(deps, [failed]))[0]?.kind).toBe('already_started');
    expect((await f.database.pool.query('select action,state from processing_tasks where article_id=$1', [failed])).rows).toEqual([{ action: 'prepare', state: 'failed' }]);

    const ambiguous = await create();
    const brokenBoss = { send: async () => null } as unknown as PgBoss;
    await expect(processExplicitArticles({ ...deps, boss: brokenBoss }, [ambiguous])).rejects.toThrow('Category job was not enqueued');
    expect((await f.database.pool.query('select action,state from processing_tasks where article_id=$1', [ambiguous])).rows).toEqual([{ action: 'prepare', state: 'succeeded' }]);
    expect((await processExplicitArticles(deps, [ambiguous]))[0]?.kind).toBe('already_started');

    const stale = await create();
    let release!: () => void;
    let fetched!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { fetched = resolve; });
    const pending = processExplicitArticles({ ...deps, web: { async get() { fetched(); await gate; return { status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': 'text/html' }, body }; } } }, [stale]);
    await entered;
    const at = new Date();
    await new TaskStore(f.database.db).createTask({ articleId: stale, action: 'prepare', generation: 2, createdAt: at, updatedAt: at });
    release();
    expect((await pending)[0]?.kind).toBe('stale');
    expect((await f.database.pool.query("select count(*)::int as count from processing_tasks where article_id=$1 and action='category'", [stale])).rows[0].count).toBe(0);
    expect((await processExplicitArticles(deps, [stale]))[0]?.kind).toBe('already_started');

    // Mutating the caller's array while preparation is suspended must not change the batch.
    const first = await create();
    const second = await create();
    const injected = await create();
    const ids = [first.toUpperCase(), second.toUpperCase()];
    let releaseBatch!: () => void;
    let batchFetched!: () => void;
    const batchGate = new Promise<void>(resolve => { releaseBatch = resolve; });
    const batchEntered = new Promise<void>(resolve => { batchFetched = resolve; });
    const batch = processExplicitArticles({ ...deps, web: { async get() {
      batchFetched(); await batchGate;
      return { status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': 'text/html' }, body };
    } } }, ids);
    await batchEntered;
    ids.splice(0, ids.length, injected, ...Array.from({ length: 21 }, randomUUID));
    releaseBatch();
    expect((await batch).map(result => [result.articleId, result.kind])).toEqual([[first, 'admission'], [second, 'admission']]);
    expect((await f.database.pool.query('select id from processing_tasks where article_id=$1', [injected])).rows).toHaveLength(0);

    // A score reevaluation admitted during preparation must not be superseded by first-time processing.
    const raced = await create();
    let releaseRace!: () => void;
    let raceFetched!: () => void;
    const raceGate = new Promise<void>(resolve => { releaseRace = resolve; });
    const raceEntered = new Promise<void>(resolve => { raceFetched = resolve; });
    const processing = processExplicitArticles({ ...deps, web: { async get() {
      raceFetched(); await raceGate;
      return { status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': 'text/html' }, body };
    } } }, [raced]);
    await raceEntered;
    const reevaluation = await new ScoreAdmission(f.database.db, f.boss).admit(raced);
    expect(reevaluation.result).toBe('ok');
    if (reevaluation.result !== 'ok') throw new Error('Reevaluation admission failed');
    expect(reevaluation.tasks).toHaveLength(1);
    releaseRace();
    const raceResult = (await processing)[0];
    expect(raceResult).toMatchObject({ kind: 'admission', admission: { kind: 'already_started' } });
    const raceTasks = await f.database.pool.query('select id, action, state from processing_tasks where article_id=$1 order by action', [raced]);
    expect(raceTasks.rows).toEqual([
      { id: raceResult && 'prepareTaskId' in raceResult ? raceResult.prepareTaskId : null, action: 'prepare', state: 'succeeded' },
      { id: reevaluation.tasks[0]!.id, action: 'scores', state: 'queued' },
    ]);

    expect((await processExplicitArticles(deps, [randomUUID()]))[0]?.kind).toBe('not_found');
    const controller = new AbortController(); controller.abort();
    await expect(processExplicitArticles(deps, [await create()], controller.signal)).rejects.toThrow();
  } finally { await f.close(); }
}, 60000);
