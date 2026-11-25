import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createPublicWeb } from '../../src/server/adapters/web/request.js';
import { fetchYouTubeTranscript } from '../../src/server/adapters/web/youtube-transcript.js';

const player = { videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '10' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en', languageCode: 'en', kind: 'asr' }] } } };
function fixture(captionUrl = 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en') {
  const p = structuredClone(player); p.captions.playerCaptionsTracklistRenderer.captionTracks[0]!.baseUrl = captionUrl;
  const requests: string[] = [];
  const web = createPublicWeb({ resolver: async () => ['8.8.8.8'], transport: async url => {
    requests.push(url.href);
    const body = url.pathname === '/watch' ? `<script>var ytInitialPlayerResponse = ${JSON.stringify(p)};</script>` : JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hello world' }] }] });
    return { status: 200, headers: {}, body: Readable.from([body]) };
  } });
  return { web, requests };
}
describe('YouTube transcript retrieval', () => {
  it('retrieves and parses public captions through pinned public web', async () => {
    const { web, requests } = fixture();
    const result = await fetchYouTubeTranscript(web, 'https://youtu.be/abcdefghijk');
    expect(result).toMatchObject({ videoId: 'abcdefghijk', text: 'Hello world', language: 'en', method: 'automatic' });
    expect(requests).toHaveLength(2);
    expect(new URL(requests[1]!).searchParams.get('fmt')).toBe('json3');
  });
  it.each(['https://evil.example/api/timedtext?v=abcdefghijk', 'https://www.youtube.com/api/timedtext?v=zzzzzzzzzzz'])('rejects untrusted caption endpoint %s', async url => {
    const { web, requests } = fixture(url);
    await expect(fetchYouTubeTranscript(web, 'https://youtu.be/abcdefghijk')).rejects.toThrow('youtube_target_rejected');
    expect(requests).toHaveLength(1);
  });
  it('rejects a redirect to a different video before its transport is called', async () => {
    const requests: string[] = [];
    const web = createPublicWeb({ resolver: async () => ['8.8.8.8'], transport: async url => {
      requests.push(url.href);
      if (url.pathname === '/watch') return { status: 200, headers: {}, body: Readable.from([`var ytInitialPlayerResponse = ${JSON.stringify(player)};`]) };
      return { status: 302, headers: { location: 'https://www.youtube.com/api/timedtext?v=zzzzzzzzzzz' }, body: Readable.from([]) };
    } });
    await expect(fetchYouTubeTranscript(web, 'https://youtu.be/abcdefghijk')).rejects.toThrow('youtube_target_rejected');
    expect(requests).toHaveLength(2);
  });
  it('rejects private DNS results without opening a transport', async () => {
    let calls = 0;
    const web = createPublicWeb({ resolver: async () => ['127.0.0.1'], transport: async () => { calls++; throw new Error('must not connect'); } });
    await expect(fetchYouTubeTranscript(web, 'https://youtu.be/abcdefghijk')).rejects.toThrow('Unsafe DNS result');
    expect(calls).toBe(0);
  });
  it('reports a successful HTTP response with an empty body as unavailable captions', async () => {
    const web = createPublicWeb({ resolver: async () => ['8.8.8.8'], transport: async url => ({
      status: 200, headers: {}, body: Readable.from([url.pathname === '/watch' ? `var ytInitialPlayerResponse = ${JSON.stringify(player)};` : '']),
    }) });
    await expect(fetchYouTubeTranscript(web, 'https://youtu.be/abcdefghijk')).rejects.toThrow('youtube_captions_missing');
  });
  it('rejects empty captions instead of returning successful content', async () => {
    const web = createPublicWeb({ resolver: async () => ['8.8.8.8'], transport: async url => ({
      status: 200, headers: {}, body: Readable.from([url.pathname === '/watch' ? `var ytInitialPlayerResponse = ${JSON.stringify(player)};` : '{"events":[]}']),
    }) });
    await expect(fetchYouTubeTranscript(web, 'https://youtu.be/abcdefghijk')).rejects.toThrow('youtube_captions_invalid');
  });
  it('rejects invalid source URLs before any request', async () => {
    const { web, requests } = fixture();
    await expect(fetchYouTubeTranscript(web, 'https://youtube.com.evil.example/watch?v=abcdefghijk')).rejects.toThrow('unsupported_youtube_url');
    expect(requests).toHaveLength(0);
  });
});
