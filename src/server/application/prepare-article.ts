import { fetchYouTubeTranscript } from '../adapters/web/youtube-transcript.js';
import { fetchPodcastTranscript } from '../adapters/web/podcast-transcript.js';
import { QualityClassifierPause } from './classify-article-quality.js';
import type { ContentExecutionContext, ContentStore } from '../adapters/postgres/content-store.js';
import { extractHtml } from '../adapters/web/extract.js';
import { publicUrl } from '../adapters/web/public-url.js';
import { normalizePermissionHost } from '../domain/source-permission.js';
import type { PublicWeb, PublicWebResponse } from '../ports/public-web.js';
import type { SourceFallbackPermission } from '../ports/source-fallback-permission.js';

/** Ports are deliberately inert: no model, agent or production fallback is wired here. */
export interface ArticleQualityClassifier {
  classify(input: { text: string; sourceUrl: string }, signal: AbortSignal, taskId: string): Promise<unknown>;
}
export interface ArticleExtractionFallback {
  /** Trusted adapter must use only this fetch capability; no model/tool runtime is supplied here. */
  extract(input: { originalUrl: string; webFetch: (url: string) => Promise<PublicWebResponse> }, signal: AbortSignal): Promise<unknown>;
}
type Dependencies = {
  web: PublicWeb;
  content: Pick<ContentStore, 'publishTask'>;
  classifier: ArticleQualityClassifier;
  fallback?: ArticleExtractionFallback;
  permission?: SourceFallbackPermission;
  now?: () => Date;
};
type Input = {
  context: ContentExecutionContext;
  originalUrl: string;
  signal?: AbortSignal;
  allowPreDispatchPause?: boolean;
};
const MAX_TEXT = 1_000_000;
const ACCESS = /\b(?:subscribe to (?:continue|read|access)|subscription required|subscribers only|sign in to (?:continue|read|access)|log in to (?:continue|read|access)|access denied|you do not have permission|payment required|article is behind a paywall)\b/i;

function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function assessment(value: unknown): { quality: 'usable' | 'uncertain' | 'unusable'; sampled: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_classifier');
  const record = value as Record<string, unknown>;
  if (!['probability,usable', 'probability,provenance,usable'].includes(Object.keys(record).sort().join(',')) || typeof record.usable !== 'boolean' ||
      typeof record.probability !== 'number' || !Number.isFinite(record.probability) || record.probability < 0 || record.probability > 1) throw new Error('invalid_classifier');
  const provenance = record.provenance;
  if (provenance !== undefined && (!provenance || typeof provenance !== 'object' || Array.isArray(provenance) || Object.keys(provenance).sort().join(',') !== 'coverage,method' || (provenance as Record<string, unknown>).coverage !== 'sampled' || (provenance as Record<string, unknown>).method !== 'beginning_middle_end')) throw new Error('invalid_classifier');
  const quality = record.usable && record.probability >= 0.7 ? 'usable' : !record.usable && record.probability < 0.3 ? 'unusable' : 'uncertain';
  return { quality, sampled: provenance !== undefined };
}
function candidate(value: unknown): { text: string; sourceUrl: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_fallback');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'sourceUrl,text' || typeof record.text !== 'string' ||
      !record.text.trim() || record.text.length > MAX_TEXT || typeof record.sourceUrl !== 'string' || record.sourceUrl.length > 2048) throw new Error('invalid_fallback');
  try { return { text: record.text.trim(), sourceUrl: publicUrl(record.sourceUrl).href }; } catch { throw new Error('invalid_fallback'); }
}

/** Pilot threshold is a heuristic, not evidence of completeness. */
export async function prepareArticle(deps: Dependencies, input: Input): Promise<{ status: 'succeeded' | 'failed' | 'stale'; revision: number | null }> {
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  const now = deps.now ?? (() => new Date());
  const context = { ...input.context };
  let outcome: Parameters<ContentStore['publishTask']>[1];
  let classificationCompleted = false;
  const classify = async (value: { text: string; sourceUrl: string }) => {
    try { return await bounded(deps.classifier.classify(value, signal, context.taskId), signal); }
    catch (error) {
      if (error instanceof QualityClassifierPause || signal.aborted) throw error;
      throw new Error('quality_provider_failed', { cause: error });
    }
  };
  try {
    const validatedOriginal = publicUrl(input.originalUrl);
    const originalUrl = validatedOriginal.href;
    const host = validatedOriginal.hostname.toLowerCase();
    const youtube = ['youtu.be', 'youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host);
    const podcast = ['podcasters.spotify.com', 'creators.spotify.com'].includes(host) && validatedOriginal.pathname.includes('/episodes/');
    if (youtube || podcast) {
      const media = youtube ? await fetchYouTubeTranscript(deps.web, originalUrl, signal) : await fetchPodcastTranscript(deps.web, originalUrl, signal);
      const assessed = assessment(await classify({ text: media.text, sourceUrl: media.sourceUrl }));
      classificationCompleted = true;
      if (assessed.quality !== 'usable') throw new Error('content_' + assessed.quality);
      signal.throwIfAborted();
      const at = now();
      outcome = { kind: 'success', at, content: { text: media.text, sourceUrl: media.sourceUrl, quality: 'usable', limitation: `transcript (${media.method}); quality is heuristic${assessed.sampled ? '; quality sampled beginning, middle and end; omitted text not assessed' : ''}`, capturedAt: at } };
    } else {
    const response = await bounded(deps.web.get(originalUrl, signal), signal);
    if (response.status === 401 || response.status === 403 || response.status === 402) throw new Error('access_denied');
    if (response.status < 200 || response.status >= 300) throw new Error('fetch_failed');
    const finalUrl = publicUrl(response.finalUrl).href;
    const type = response.headers['content-type'];
    if (typeof type !== 'string' || !/^\s*(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(type)) throw new Error('not_html');
    const extracted = await extractHtml(response.body, signal, { contentType: type });
    if (ACCESS.test(extracted.pageText) || ACCESS.test(extracted.text)) throw new Error('access_denied');
    let result = { text: extracted.text.trim(), sourceUrl: finalUrl };
    let assessed = result.text ? assessment(await classify(result)) : { quality: 'unusable' as const, sampled: false };
    classificationCompleted = !!result.text;
    let fromFallback = false;
    if (assessed.quality !== 'usable' && deps.fallback) {
      const permission = deps.permission;
      if (!permission || await bounded(permission.resolveForArticle(context.articleId, validatedOriginal.hostname), signal) !== true) throw new Error('fallback_permission_denied');
      const originalHost = normalizePermissionHost(validatedOriginal.hostname);
      const authorizeTarget = async (url: string, targetSignal: AbortSignal) => {
        let host: string;
        try { host = normalizePermissionHost(publicUrl(url).hostname); } catch { throw new Error('fallback_permission_denied'); }
        const decision = host === originalHost
          ? permission.resolveForArticle(context.articleId, originalHost)
          : permission.resolveHost(host);
        if (await bounded(decision, targetSignal) !== true) throw new Error('fallback_permission_denied');
        targetSignal.throwIfAborted();
      };
      const fetched = new Set([originalUrl, finalUrl]);
      let calls = 0;
      let closed = false;
      const inspections: Array<Promise<PublicWebResponse>> = [];
      const webFetch = (url: string): Promise<PublicWebResponse> => {
        const inspection = (async () => {
          if (closed || ++calls > 20) throw new Error('fallback_fetch_limit');
          const safe = publicUrl(url).href;
          await authorizeTarget(safe, signal);
          const page = await bounded(deps.web.get(safe, signal, { authorizeTarget }), signal);
          if ([401, 402, 403].includes(page.status)) throw new Error('access_denied');
          if (page.status < 200 || page.status >= 300 || !Buffer.isBuffer(page.body) || page.body.length > 10 * 1024 * 1024) throw new Error('fallback_fetch_failed');
          const final = publicUrl(page.finalUrl).href;
          await authorizeTarget(final, signal);
          const type = page.headers['content-type'];
          if (typeof type !== 'string') throw new Error('not_html');
          const extracted = await extractHtml(page.body, signal, { contentType: type });
          if (ACCESS.test(extracted.pageText) || ACCESS.test(extracted.text)) throw new Error('access_denied');
          fetched.add(safe);
          fetched.add(final);
          return page;
        })();
        if (!closed) inspections.push(inspection);
        void inspection.catch(() => {});
        return inspection;
      };
      let fallbackResult: unknown;
      try { fallbackResult = await bounded(deps.fallback.extract({ originalUrl, webFetch }, signal), signal); }
      finally { closed = true; }
      const inspected = await bounded(Promise.allSettled(inspections), signal);
      const rejected = inspected.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
      if (rejected.length) throw rejected.find(item => item.reason instanceof Error && item.reason.message === 'access_denied')?.reason ?? rejected[0]!.reason;
      result = candidate(fallbackResult);
      if (!fetched.has(result.sourceUrl)) throw new Error('invalid_fallback');
      await authorizeTarget(result.sourceUrl, signal);
      if (ACCESS.test(result.text)) throw new Error('access_denied');
      assessed = assessment(await classify(result));
      fromFallback = true;
    }
    if (assessed.quality !== 'usable') throw new Error('content_' + assessed.quality);
    if (signal.aborted) throw signal.reason;
    const at = now();
    outcome = { kind: 'success', at, content: { text: result.text, sourceUrl: result.sourceUrl, quality: 'usable', limitation: (fromFallback ? 'fallback; quality is heuristic' : 'quality is heuristic') + (assessed.sampled ? '; quality sampled beginning, middle and end; omitted text not assessed' : ''), capturedAt: at } };
    }
  } catch (error) {
    if (error instanceof QualityClassifierPause && input.allowPreDispatchPause && !classificationCompleted && !signal.aborted) throw error;
    const allowed = new Set(['quality_provider_failed', 'invalid_classifier', 'invalid_fallback', 'access_denied', 'fetch_failed', 'not_html', 'unsupported_encoding', 'content_uncertain', 'content_unusable', 'fallback_permission_denied', 'youtube_captions_missing', 'youtube_captions_invalid', 'youtube_fetch_failed', 'podcast_feed_missing', 'podcast_episode_missing', 'podcast_transcript_missing', 'podcast_transcript_invalid', 'podcast_fetch_failed']);
    const message = error instanceof Error ? error.message : '';
    outcome = { kind: 'failure', errorCode: signal.aborted ? 'cancelled_or_timeout' : allowed.has(message) ? message : 'preparation_failed', at: now() };
  }
  // Do not catch publication errors or attempt an unfenced second write.
  const revision = await deps.content.publishTask(context, outcome);
  return { status: revision === null ? 'stale' : outcome.kind === 'success' ? 'succeeded' : 'failed', revision };
}
