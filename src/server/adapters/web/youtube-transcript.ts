import type { PublicWeb } from '../../ports/public-web.js';
import { publicUrl } from './public-url.js';
import { normalizeTranscriptCues, type TranscriptCue } from '../../domain/transcript-cues.js';

const MAX_PAGE = 10 * 1024 * 1024;
const MAX_CAPTIONS = 2 * 1024 * 1024;
const MAX_TEXT = 1_000_000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function videoId(input: string): string {
  const url = publicUrl(input);
  if (url.protocol !== 'https:') throw new Error('unsupported_youtube_url');
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === 'youtu.be' && /^\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)) id = url.pathname.split('/')[1]!;
  else if ((host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') && url.pathname === '/watch') id = url.searchParams.get('v');
  else if ((host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') && /^\/(?:shorts|embed|live)\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)) id = url.pathname.split('/')[2]!;
  if (!id || !VIDEO_ID.test(id)) throw new Error('unsupported_youtube_url');
  return id;
}

function playerResponse(html: string): unknown {
  const marker = /(?:var\s+)?ytInitialPlayerResponse\s*=\s*/g.exec(html);
  if (!marker) throw new Error('youtube_player_missing');
  const start = marker.index + marker[0].length;
  if (html[start] !== '{') throw new Error('youtube_player_invalid');
  let depth = 0, string = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i]!;
    if (string) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') string = false;
    } else if (c === '"') string = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('youtube_player_invalid');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('youtube_response_invalid');
  return value as Record<string, unknown>;
}
function decode(body: Buffer): string {
  if (!Buffer.isBuffer(body)) throw new Error('youtube_response_invalid');
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}
function target(url: string, path: string, id: string): void {
  const parsed = publicUrl(url);
  const ids = parsed.searchParams.getAll('v');
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.youtube.com' || parsed.pathname !== path || ids.length !== 1 || ids[0] !== id) throw new Error('youtube_target_rejected');
}

/** Retrieves only public YouTube captions. No subprocess, cookies or authenticated requests. */
export async function fetchYouTubeTranscript(web: PublicWeb, input: string, callerSignal?: AbortSignal): Promise<{ videoId: string; sourceUrl: string; text: string; language: string; method: 'human' | 'automatic'; duration: number; cues: readonly TranscriptCue[] }> {
  const id = videoId(input);
  const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const sourceUrl = `https://www.youtube.com/watch?v=${id}`;
  const watch = await web.get(sourceUrl, signal, { maxBytes: MAX_PAGE, timeoutMs: 20_000, maxRedirects: 3, authorizeTarget: async url => target(url, '/watch', id) });
  if (watch.status !== 200 || watch.body.length > MAX_PAGE) throw new Error('youtube_fetch_failed');
  target(watch.finalUrl, '/watch', id);
  const html = decode(watch.body);
  const apiKey = /"INNERTUBE_API_KEY"\s*:\s*"([A-Za-z0-9_-]{1,128})"/.exec(html)?.[1];
  let player: Record<string, unknown>;
  if (apiKey) {
    if (!web.postJson) throw new Error('youtube_player_missing');
    const endpoint = `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`;
    const authorizeTarget = async (url: string) => {
      const parsed = publicUrl(url);
      if (parsed.href !== endpoint) throw new Error('youtube_target_rejected');
    };
    const response = await web.postJson(endpoint, { context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } }, videoId: id }, signal, { maxBytes: MAX_PAGE, timeoutMs: 20_000, maxRedirects: 0, authorizeTarget });
    if (response.status !== 200 || response.body.length > MAX_PAGE) throw new Error('youtube_fetch_failed');
    await authorizeTarget(response.finalUrl);
    player = object(JSON.parse(decode(response.body)));
  } else {
    player = object(playerResponse(html));
  }
  const details = object(player.videoDetails);
  const duration = Number(details.lengthSeconds);
  if (details.videoId !== id || !Number.isFinite(duration) || duration <= 0 || duration > 86400) throw new Error('youtube_response_invalid');
  const captions = object(object(player.captions).playerCaptionsTracklistRenderer).captionTracks;
  if (!Array.isArray(captions) || captions.length > 100) throw new Error('youtube_captions_missing');
  const tracks = captions.map(object).filter(t => typeof t.baseUrl === 'string' && typeof t.languageCode === 'string' && /^(?:de|en)(?:-[a-z0-9]+)*$/i.test(t.languageCode) && (t.kind === undefined || t.kind === 'asr'));
  tracks.sort((a, b) => Number(a.kind === 'asr') - Number(b.kind === 'asr') || String(a.languageCode).localeCompare(String(b.languageCode)));
  const track = tracks[0];
  if (!track) throw new Error('youtube_captions_missing');
  const endpoint = publicUrl(track.baseUrl as string);
  target(endpoint.href, '/api/timedtext', id);
  endpoint.searchParams.set('fmt', 'json3');
  const response = await web.get(endpoint.href, signal, { maxBytes: MAX_CAPTIONS, timeoutMs: 20_000, maxRedirects: 3, authorizeTarget: async url => target(url, '/api/timedtext', id) });
  if (response.status !== 200 || response.body.length > MAX_CAPTIONS) throw new Error('youtube_fetch_failed');
  target(response.finalUrl, '/api/timedtext', id);
  if (response.body.length === 0) throw new Error('youtube_captions_missing');
  const events = object(JSON.parse(decode(response.body))).events;
  if (!Array.isArray(events) || events.length > 50_000) throw new Error('youtube_captions_invalid');
  const cues: TranscriptCue[] = [];
  for (const raw of events) {
    const event = object(raw);
    if (!Array.isArray(event.segs)) continue;
    const text = event.segs.map(seg => object(seg).utf8).filter((s): s is string => typeof s === 'string').join('').trim();
    if (!text) continue;
    const start = Number(event.tStartMs) / 1000;
    const end = start + Number(event.dDurationMs) / 1000;
    cues.push({ start, end: Math.min(end, duration), text });
  }
  const language = track.languageCode as string;
  const method = track.kind === 'asr' ? 'automatic' : 'human';
  const transcript = normalizeTranscriptCues({ language, method, duration, cues });
  const text = transcript.cues.map(cue => cue.text).join('\n');
  if (!text || text.length > MAX_TEXT) throw new Error('youtube_captions_invalid');
  return { videoId: id, sourceUrl, text, language, method, duration, cues: transcript.cues };
}
