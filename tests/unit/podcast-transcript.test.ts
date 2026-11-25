import { expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createPublicWeb } from '../../src/server/adapters/web/request.js';
import { fetchPodcastTranscript } from '../../src/server/adapters/web/podcast-transcript.js';

it('does not follow a feed transcript link into a private network', async () => {
  let calls = 0;
  const web = createPublicWeb({ resolver: async host => host === 'internal.example' ? ['127.0.0.1'] : ['8.8.8.8'], transport: async url => {
    calls++;
    const body = url.pathname === '/episode' ? '<link type="application/rss+xml" href="https://example.com/feed.xml">' : '<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><item><link>https://example.com/episode</link><podcast:transcript type="application/x-subrip" url="https://internal.example/private"/></item></channel></rss>';
    return { status: 200, headers: {}, body: Readable.from([body]) };
  } });
  await expect(fetchPodcastTranscript(web, 'https://example.com/episode')).rejects.toThrow('Unsafe DNS result');
  expect(calls).toBe(2);
});

it('refuses a feed with no exact episode match', async () => {
  const web = createPublicWeb({ resolver: async () => ['8.8.8.8'], transport: async url => ({ status: 200, headers: {}, body: Readable.from([url.pathname === '/episode' ? '<link type="application/rss+xml" href="https://example.com/feed.xml">' : '<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><item><link>https://example.com/other</link></item></channel></rss>']) }) });
  await expect(fetchPodcastTranscript(web, 'https://example.com/episode')).rejects.toThrow('podcast_episode_missing');
});

async function retrieveSrt(srt: string): Promise<string> {
  const episode = 'https://example.com/episode';
  const web = createPublicWeb({ resolver: async () => ['8.8.8.8'], transport: async url => {
    const body = url.pathname === '/episode' ? '<link type="application/rss+xml" href="https://example.com/feed.xml">' : url.pathname === '/feed.xml' ? `<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><item><link>${episode}</link><podcast:transcript type="application/x-subrip" url="https://example.com/transcript.srt"/></item></channel></rss>` : srt;
    return { status: 200, headers: {}, body: Readable.from([body]) };
  } });
  return (await fetchPodcastTranscript(web, episode)).text;
}

it('preserves literal ampersands and greater-than signs in multilingual SRT text', async () => {
  await expect(retrieveSrt('1\n00:00:01,000 --> 00:00:03,000\nÄpfel & Birnen: 3 > 2 — 你好\n')).resolves.toBe('Äpfel & Birnen: 3 > 2 — 你好');
});

it('accepts supported formatting and entities without altering timestamps in cue text', async () => {
  await expect(retrieveSrt('1\n00:00:01,000 --> 00:00:03,000\n<i>Grüße &amp; 你好</i> 00:00:02,500\n')).resolves.toBe('Grüße & 你好 00:00:02,500');
});

it.each([
  '1\n00:00:01,000 --> 00:00:03,000\n<script>alert(1)</script>',
  '1\n00:00:01,000 --> 00:00:03,000\n<i>unclosed',
  '1\n00:00:01,000 --> 00:00:03,000\ntext --> forged',
  '1\n00:00:61,000 --> 00:01:03,000\ninvalid time',
  '1\n00:00:03,000 --> 00:00:01,000\nreversed time',
  '1\n00:00:01,000 --> 00:00:03,000\ninvalid\u0000text',
])('rejects unsafe or invalid SRT input %#', async srt => {
  await expect(retrieveSrt(srt)).rejects.toThrow();
});

it('rejects oversized SRT input before parsing', async () => {
  await expect(retrieveSrt(`1\n00:00:01,000 --> 00:00:03,000\n${'a'.repeat(2 * 1024 * 1024)}`)).rejects.toThrow();
});

it('discovers a feed and retrieves the transcript only for the exact episode URL', async () => {
  const episode = 'https://example.com/episodes/192';
  const web = createPublicWeb({ resolver: async () => ['8.8.8.8'], transport: async url => {
    const body = url.pathname === '/episodes/192' ? '<link type="application/rss+xml" href="https://example.com/feed.xml">' : url.pathname === '/feed.xml' ? `<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><item><link>${episode}</link><podcast:transcript type="application/x-subrip" url="https://example.com/192.srt"/></item></channel></rss>` : '1\n00:00:01,000 --> 00:00:03,000\nHello podcast\n';
    return { status: 200, headers: {}, body: Readable.from([body]) };
  } });
  expect((await fetchPodcastTranscript(web, episode)).text).toBe('Hello podcast');
});
