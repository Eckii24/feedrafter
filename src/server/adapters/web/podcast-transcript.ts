import { DOMParser } from 'linkedom';
import { parseWebVtt } from '../../domain/webvtt.js';
import type { PublicWeb } from '../../ports/public-web.js';
import { publicUrl } from './public-url.js';

const LIMIT = 2 * 1024 * 1024;
function decoded(body: Buffer): string { return new TextDecoder('utf-8', { fatal: true }).decode(body); }

/** Discover an episode's public RSS and Podcasting 2.0 SRT, without cookies or audio downloads. */
export async function fetchPodcastTranscript(web: PublicWeb, input: string, callerSignal?: AbortSignal): Promise<{ text: string; sourceUrl: string; method: string }> {
  const source = publicUrl(input).href;
  const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const get = async (url: string) => {
    const response = await web.get(url, signal, { maxBytes: LIMIT, timeoutMs: 20_000, maxRedirects: 3 });
    if (response.status !== 200 || response.body.length > LIMIT) throw new Error('podcast_fetch_failed');
    return response;
  };
  const page = await get(source);
  const document = new DOMParser().parseFromString(decoded(page.body), 'text/html') as unknown as Document;
  const feeds = new Set<string>();
  const anchors = Array.from(document.querySelectorAll('a[href]')).filter(link => /\/podcast\/rss(?:[?#]|$)/i.test(link.getAttribute('href') ?? ''));
  const links = Array.from(document.querySelectorAll('link[type="application/rss+xml"][href]'));
  const candidates = anchors.length ? anchors : links;
  for (const link of candidates) {
    const href = link.getAttribute('href');
    if (!href) continue;
    if (link.getAttribute('type') === 'application/rss+xml' || /\/podcast\/rss(?:[?#]|$)/i.test(href)) {
      try { feeds.add(publicUrl(href, publicUrl(page.finalUrl)).href); } catch { /* ignore invalid links */ }
    }
  }
  if (feeds.size !== 1) throw new Error('podcast_feed_missing');
  const feed = await get([...feeds][0]!);
  const xml = decoded(feed.body);
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) throw new Error('podcast_feed_invalid');
  const rss = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  if (rss.documentElement?.getAttribute('xmlns:podcast') !== 'https://podcastindex.org/namespace/1.0') throw new Error('podcast_feed_invalid');
  const matches = Array.from(rss.querySelectorAll('item')).filter(item => {
    const link = Array.from(item.children).find(child => child.localName === 'link')?.textContent?.trim();
    try { return !!link && publicUrl(link).href === source; } catch { return false; }
  });
  if (matches.length !== 1) throw new Error('podcast_episode_missing');
  const tracks = Array.from(matches[0]!.children).filter(child => child.localName === 'podcast:transcript' && child.getAttribute('type') === 'application/x-subrip');
  if (tracks.length !== 1) throw new Error('podcast_transcript_missing');
  const url = tracks[0]!.getAttribute('url');
  if (!url) throw new Error('podcast_transcript_missing');
  const response = await get(publicUrl(url, publicUrl(feed.finalUrl)).href);
  const srt = decoded(response.body).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  // Escape SRT plain text for the stricter WebVTT parser, but leave tags and
  // supported entities for its existing markup validation and decoding.
  const blocks = srt.split('\n\n').map(block => {
    const lines = block.split('\n');
    const timingIndex = lines[0]?.includes('-->') ? 0 : 1;
    if (lines[timingIndex]?.includes('-->')) {
      lines[timingIndex] = lines[timingIndex]!.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      for (let i = timingIndex + 1; i < lines.length; i++) {
        if (lines[i]!.includes('-->')) throw new SyntaxError('Invalid SRT cue text');
        lines[i] = lines[i]!.replace(/<[^<>\n]*>|&(?:amp|lt|gt|nbsp|lrm|rlm);|[&>]/g, token =>
          token === '&' ? '&amp;' : token === '>' ? '&gt;' : token);
      }
    }
    return lines.join('\n');
  });
  const vtt = `WEBVTT\n\n${blocks.join('\n\n')}`;
  const transcript = parseWebVtt(vtt, { language: 'und', method: 'publisher', duration: 86400, maxInputBytes: LIMIT * 5 + 16 });
  const text = transcript.cues.map(cue => cue.text).join('\n');
  if (!text || text.length > 1_000_000) throw new Error('podcast_transcript_invalid');
  return { text, sourceUrl: source, method: 'publisher' };
}
