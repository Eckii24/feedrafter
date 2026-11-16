import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { IncomingHttpHeaders } from 'node:http';
import type { PublicWeb } from '../../ports/public-web.js';
import type { SearchResponse, SearchResult, WebSearch } from '../../ports/web-search.js';
import { publicUrl } from './public-url.js';

const MAX_BYTES = 2 * 1024 * 1024;
const DEADLINE = 20_000;
const MAX_RETRY_DELAY = 2_000;
const providerHost = (host: string) => /(?:^|\.)(?:duckduckgo\.com|bing\.com)$/i.test(host.replace(/\.$/, ''));

function destination(raw: string, base?: URL): string | undefined {
  try {
    let url = publicUrl(raw, base);
    if (/(?:^|\.)duckduckgo\.com$/i.test(url.hostname) && url.pathname === '/l/') {
      const target = url.searchParams.get('uddg');
      if (!target) return;
      url = publicUrl(target);
    }
    if (providerHost(url.hostname)) return;
    return url.href;
  } catch { return; }
}
function collect(rows: SearchResult[], maxResults: number): SearchResult[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    if (!row.url || !row.title || seen.has(row.url)) return false;
    seen.add(row.url); return true;
  }).slice(0, maxResults);
}
// Limit live workers and retained response bodies across all search instances.
const MAX_WORKERS = 2;
const MAX_QUEUE = 8;
let active = 0;
const queue: Array<() => void> = [];
function slot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    if (active >= MAX_WORKERS && queue.length >= MAX_QUEUE) { reject(new Error('Search parser busy')); return; }
    let waiting = true;
    const abort = () => {
      if (!waiting) return;
      waiting = false;
      const index = queue.indexOf(start);
      if (index >= 0) queue.splice(index, 1);
      reject(cancelled());
    };
    const start = () => {
      if (!waiting) return;
      waiting = false; signal.removeEventListener('abort', abort); active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true; active--;
        queue.shift()?.();
      });
    };
    signal.addEventListener('abort', abort, { once: true });
    if (active < MAX_WORKERS) start(); else queue.push(start);
  });
}
async function parse(body: Buffer, provider: string, signal: AbortSignal, deadline: number): Promise<SearchResult[]> {
  const release = await slot(signal);
  let worker: Worker | undefined;
  try {
    if (signal.aborted || performance.now() >= deadline) throw cancelled();
    const js = new URL('./search-worker.js', import.meta.url);
    worker = new Worker(existsSync(js) ? js : new URL('./search-worker.ts', import.meta.url), {
      workerData: { body, provider },
      // File workers cannot inherit the eval/stdin-only flag.
      execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type=')),
    });
    const instance = worker;
    return await new Promise<SearchResult[]>((resolve, reject) => {
      let done = false;
      const finish = (error?: Error, rows?: SearchResult[]) => {
        if (done) return;
        done = true; signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(rows!);
      };
      const abort = () => finish(cancelled());
      signal.addEventListener('abort', abort, { once: true });
      instance.once('message', (message: { rows?: SearchResult[]; error?: boolean }) => {
        if (signal.aborted || performance.now() >= deadline) finish(cancelled());
        else if (message.error || !Array.isArray(message.rows)) finish(new Error('Invalid response'));
        else finish(undefined, message.rows);
      });
      instance.once('error', () => finish(new Error('Parser failed')));
      instance.once('exit', () => finish(new Error('Parser exited')));
      if (signal.aborted) abort();
    });
  } finally {
    try { if (worker) await worker.terminate(); } finally { release(); }
  }
}
function retryDelay(headers: IncomingHttpHeaders): number {
  const raw = headers['retry-after'];
  if (typeof raw !== 'string') return 250;
  const seconds = /^\d+$/.test(raw.trim()) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(seconds) ? Math.min(MAX_RETRY_DELAY, Math.max(0, seconds)) : 250;
}
function cancelled(): Error { const error = new Error('Search cancelled'); error.name = 'AbortError'; return error; }
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Unwired discovery adapter. Returned text is untrusted; no logging or provider credentials. */
export function createWebSearch(web: PublicWeb): WebSearch {
  return {
    async search(query, maxResults = 5, callerSignal) {
      if (typeof query !== 'string' || !query.trim() || query.trim().length > 500) throw new Error('Invalid search query');
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) throw new Error('Invalid maxResults');
      const deadline = performance.now() + DEADLINE;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEADLINE);
      const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
      try {
        for (const provider of ['DuckDuckGo', 'Bing RSS'] as const) {
          if (signal.aborted || performance.now() >= deadline) throw cancelled();
          const url = new URL(provider === 'DuckDuckGo' ? 'https://html.duckduckgo.com/html/' : 'https://www.bing.com/search');
          if (provider === 'Bing RSS') url.searchParams.set('format', 'rss');
          url.searchParams.set('q', query.trim());
          try {
            for (let attempt = 0; attempt < 2; attempt++) {
              if (signal.aborted || performance.now() >= deadline) throw cancelled();
              const response = await bounded(web.get(url.href, signal, { maxBytes: MAX_BYTES, timeoutMs: DEADLINE, maxRedirects: 0 }), signal);
              if (signal.aborted || performance.now() >= deadline) throw cancelled();
              if ((response.status === 202 || response.status === 429 || response.status >= 500 && response.status <= 599) && attempt === 0) {
                await delay(retryDelay(response.headers), signal); continue;
              }
              if (response.status !== 200 || response.body.length > MAX_BYTES) break;
              const rows = await parse(response.body, provider, signal, deadline);
              if (signal.aborted || performance.now() >= deadline) throw cancelled();
              const results = collect(rows.map(row => ({ ...row, url: destination(row.url, provider === 'DuckDuckGo' ? new URL('https://html.duckduckgo.com/') : undefined) ?? '' })), maxResults);
              if (signal.aborted || performance.now() >= deadline) throw cancelled();
              if (rows.length && !results.length) break;
              return { provider, results } satisfies SearchResponse;
            }
          } catch { if (signal.aborted || performance.now() >= deadline) throw cancelled(); }
        }
        throw new Error('SEARCH_UNAVAILABLE');
      } finally { clearTimeout(timer); controller.abort(); }
    },
  };
}
