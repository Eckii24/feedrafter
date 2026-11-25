import { expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createPublicWeb } from '../../src/server/adapters/web/request.js';
import { prepareArticle } from '../../src/server/application/prepare-article.js';

it('records unavailable YouTube captions without publishing page HTML as article content', async () => {
  const web = createPublicWeb({ resolver: async () => ['8.8.8.8'], transport: async () => ({ status: 200, headers: {}, body: Readable.from(['var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abcdefghijk","lengthSeconds":"10"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[]}}};']) }) });
  const publishTask = vi.fn(async () => 0);
  const classifier = { classify: vi.fn(async () => ({ usable: true, probability: 0.9 })) };
  const context = { articleId: 'a', taskId: 't', action: 'prepare' as const, generation: 1, executionToken: 'fence', expectedContentRevision: 0 };
  expect((await prepareArticle({ web, content: { publishTask }, classifier }, { context, originalUrl: 'https://youtu.be/abcdefghijk' })).status).toBe('failed');
  expect(publishTask).toHaveBeenCalledWith(context, expect.objectContaining({ kind: 'failure', errorCode: 'youtube_captions_missing' }));
  expect(classifier.classify).not.toHaveBeenCalled();
});

it('prepares a YouTube transcript and publishes it using the existing execution fence', async () => {
  const player = { videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '10' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en', languageCode: 'en' }] } } };
  const web = createPublicWeb({ resolver: async () => ['8.8.8.8'], transport: async url => ({ status: 200, headers: {}, body: Readable.from([url.pathname === '/watch' ? `var ytInitialPlayerResponse = ${JSON.stringify(player)};` : JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Actual spoken words' }] }] })]) }) });
  const publishTask = vi.fn(async () => 1);
  const classifier = { classify: vi.fn(async () => ({ usable: true, probability: 0.9 })) };
  const context = { articleId: 'a', taskId: 't', action: 'prepare' as const, generation: 1, executionToken: 'fence', expectedContentRevision: 0 };
  expect(await prepareArticle({ web, content: { publishTask }, classifier }, { context, originalUrl: 'https://youtu.be/abcdefghijk' })).toEqual({ status: 'succeeded', revision: 1 });
  expect(classifier.classify).toHaveBeenCalledWith(expect.objectContaining({ text: 'Actual spoken words' }), expect.any(AbortSignal), 't');
  expect(publishTask).toHaveBeenCalledWith(context, expect.objectContaining({ kind: 'success', content: expect.objectContaining({ text: 'Actual spoken words' }) }));
});
