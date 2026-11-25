import { expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { ImportStore } from '../../src/server/adapters/postgres/import-store.js';
import { processExplicitArticles } from '../../src/server/adapters/postgres/explicit-article-processing.js';
import { createPublicWeb } from '../../src/server/adapters/web/request.js';
import { articleProcessingFixture } from '../helpers/article-processing-fixture.js';

it('prepares synthetic video transcripts and hands them off to the fenced job chain', async () => {
  const f = await articleProcessingFixture();
  try {
    const store = new ImportStore(f.database.db);
    const context = await store.ensureContext('media-synthetic', 'test');
    const [article] = await store.importPageWithIdentities(context.id, [{ id: randomUUID(), title: 'Video', url: 'https://youtu.be/abcdefghijk', author: null, publishedAt: null, feedId: null, feedTitle: null }], new Date());
    await f.database.pool.query("update articles set kind='video' where id=$1", [article!.id]);
    const player = { videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '10' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en', languageCode: 'en' }] } } };
    const web = createPublicWeb({ resolver: async () => ['8.8.8.8'], transport: async url => ({ status: 200, headers: {}, body: Readable.from([url.pathname === '/watch' ? `var ytInitialPlayerResponse = ${JSON.stringify(player)};` : JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Synthetic spoken content' }] }] })]) }) });
    const result = await processExplicitArticles({ db: f.database.db, boss: f.boss, web, classifier: { async classify() { return { usable: true, probability: 1 }; } } }, [article!.id]);
    expect(result[0]).toMatchObject({ kind: 'admission', admission: { kind: 'admitted' } });
    const rows = await f.database.pool.query('select action,state from processing_tasks where article_id=$1', [article!.id]);
    expect(rows.rows).toEqual(expect.arrayContaining([{ action: 'prepare', state: 'succeeded' }, { action: 'category', state: 'queued' }]));
  } finally { await f.close(); }
}, 60000);
