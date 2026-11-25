import { expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createPublicWeb } from '../../src/server/adapters/web/request.js';
import { fetchYouTubeTranscript } from '../../src/server/adapters/web/youtube-transcript.js';

it('rejects POST redirects without sending the request body to another target', async () => {
  let calls = 0;
  const web = createPublicWeb({ resolver: async () => ['8.8.8.8'], transport: async () => {
    calls++;
    return { status: 307, headers: { location: 'https://example.com/other' }, body: Readable.from([]) };
  } });
  await expect(web.postJson!('https://example.com/player', { videoId: 'abcdefghijk' })).rejects.toThrow('Invalid or excessive redirects');
  expect(calls).toBe(1);
});

it('uses the Android player response rather than stale web player captions', async () => {
  const calls: string[] = [];
  const web = createPublicWeb({ resolver: async () => ['8.8.8.8'], transport: async (url, _address, _signal, request) => {
    calls.push(`${request?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/watch') return { status: 200, headers: {}, body: Readable.from(['"INNERTUBE_API_KEY":"abc123"']) };
    if (url.pathname === '/youtubei/v1/player') return { status: 200, headers: {}, body: Readable.from([JSON.stringify({ videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '10' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en', languageCode: 'en', kind: 'asr' }] } } })]) };
    return { status: 200, headers: {}, body: Readable.from([JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hello' }] }] })]) };
  } });
  expect((await fetchYouTubeTranscript(web, 'https://youtu.be/abcdefghijk')).text).toBe('Hello');
  expect(calls).toEqual(['GET /watch', 'POST /youtubei/v1/player', 'GET /api/timedtext']);
});
