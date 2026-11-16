import type { KarakeepCreateResult, KarakeepLookupResult, KarakeepPort } from '../../ports/karakeep.js';
import { parseCreate, parseLookup, validOriginalUrl } from './schemas.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const uncertain = { kind: 'uncertain' } as const;

export interface KarakeepClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  transport?: typeof fetch;
}

/** Isolated preparatory adapter. Do not wire to live actions before the deployed gate. */
export class KarakeepClient implements KarakeepPort {
  private readonly origin: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;

  constructor(options: KarakeepClientOptions) {
    let base: URL;
    try {
      if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(options.baseUrl)) throw new Error();
      base = new URL(options.baseUrl);
    } catch { throw new Error('Invalid Karakeep configuration'); }
    if (!['http:', 'https:'].includes(base.protocol) || !base.hostname || base.username || base.password ||
        base.pathname !== '/' || base.search || base.hash ||
        !/^[A-Za-z0-9\-._~+/]+=*$/.test(options.token) ||
        !Number.isSafeInteger(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) < 1 ||
        (options.timeoutMs ?? 30_000) > 2_147_483_647) throw new Error('Invalid Karakeep configuration');
    this.origin = base.origin;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.transport = options.transport ?? fetch;
  }

  private async request(path: '/api/v1/bookmarks' | '/api/v1/bookmarks/check-url', originalUrl: string, signal?: AbortSignal): Promise<{ status: number; value: unknown } | undefined> {
    if (!validOriginalUrl(originalUrl)) throw new Error('Invalid original URL');
    const url = new URL(path, this.origin);
    if (path.endsWith('/check-url')) url.searchParams.set('url', originalUrl);
    if (url.origin !== this.origin) throw new Error('Invalid Karakeep request');
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const headers = new Headers({ Authorization: `Bearer ${this.token}`, Accept: 'application/json' });
    const create = path === '/api/v1/bookmarks';
    if (create) headers.set('Content-Type', 'application/json');
    try {
      combined.throwIfAborted();
      const response = await this.transport(url, {
        method: create ? 'POST' : 'GET', headers, redirect: 'error', signal: combined,
        ...(create ? { body: JSON.stringify({ type: 'link', url: originalUrl }) } : {}),
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel();
        return undefined;
      }
      if (response.status === 401 || response.status === 403) {
        void response.body?.cancel().catch(() => {});
        return { status: response.status, value: undefined };
      }
      if (!response.body) return undefined;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            return undefined;
          }
          chunks.push(item.value);
        }
      } finally { reader.releaseLock(); }
      combined.throwIfAborted();
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { status: response.status, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
    } catch { return undefined; }
  }

  async create(originalUrl: string, signal?: AbortSignal): Promise<KarakeepCreateResult> {
    const response = await this.request('/api/v1/bookmarks', originalUrl, signal);
    if (response?.status === 401 || response?.status === 403) return { kind: 'auth_error' };
    return response ? parseCreate(response.status, response.value, originalUrl) : uncertain;
  }

  async checkUrl(originalUrl: string, signal?: AbortSignal): Promise<KarakeepLookupResult> {
    const response = await this.request('/api/v1/bookmarks/check-url', originalUrl, signal);
    if (response?.status === 401 || response?.status === 403) return { kind: 'auth_error' };
    return response ? parseLookup() : uncertain;
  }
}
