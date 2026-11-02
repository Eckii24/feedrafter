import type { FreshRssEntry, FreshRssPage, FreshRssPort } from '../../ports/freshrss.js';
import { sendExactReadAcknowledgement } from './acknowledgement-protocol.js';
import { idForm, isValidContinuation, parseReadStates } from './schemas.js';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid FreshRSS response');
  return value as ObjectValue;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('Invalid FreshRSS response');
  return value;
}

function parseItem(value: unknown): FreshRssEntry {
  const item = object(value);
  if (typeof item.id !== 'string' || item.id.length === 0) throw new Error('Invalid FreshRSS response');
  let publishedAt: Date | null = null;
  if (item.published !== undefined && item.published !== null) {
    if (typeof item.published !== 'number' || !Number.isSafeInteger(item.published)) throw new Error('Invalid FreshRSS response');
    publishedAt = new Date(item.published * 1000);
    if (Number.isNaN(publishedAt.getTime())) throw new Error('Invalid FreshRSS response');
  }
  const origin = item.origin == null ? null : object(item.origin);
  let url: string | null = null;
  if (item.alternate != null) {
    if (!Array.isArray(item.alternate)) throw new Error('Invalid FreshRSS response');
    const first = item.alternate[0];
    if (first !== undefined) url = optionalString(object(first).href);
  }
  return {
    id: item.id,
    title: optionalString(item.title),
    url,
    author: optionalString(item.author),
    publishedAt,
    feedId: origin ? optionalString(origin.streamId) : null,
    feedTitle: origin ? optionalString(origin.title) : null,
  };
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Invalid FreshRSS response');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export interface FreshRssClientOptions {
  baseUrl: string;
  email: string;
  password: string;
  transport?: typeof fetch;
}

/** Read-only until the isolated FreshRSS and digest compatibility gates are met. */
export class FreshRssClient implements FreshRssPort {
  private readonly baseUrl: string;
  private readonly transport: typeof fetch;
  private token: string | undefined;

  constructor(private readonly options: FreshRssClientOptions) {
    const url = new URL(options.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/$/, '').endsWith('/api/greader.php') || !options.email || !options.password) {
      throw new Error('Invalid FreshRSS configuration');
    }
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.transport = options.transport ?? fetch;
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(30_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.transport(`${this.baseUrl}${path}`, { ...init, redirect: 'error', signal: combined });
    } catch {
      throw new Error('FreshRSS request failed');
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.token = undefined;
      await response.body?.cancel();
      throw new Error('FreshRSS request failed');
    }
    try { return await readBounded(response); } catch { throw new Error('Invalid FreshRSS response'); }
  }

  private async authenticate(signal?: AbortSignal): Promise<string> {
    if (this.token) return this.token;
    const body = new URLSearchParams({ Email: this.options.email, Passwd: this.options.password });
    const text = await this.request('/accounts/ClientLogin', { method: 'POST', body }, signal);
    const matches = [...text.matchAll(/^Auth=([^\r\n]+)\r?$/gm)];
    if (matches.length !== 1 || !matches[0]?.[1]) throw new Error('Invalid FreshRSS response');
    this.token = matches[0][1];
    return this.token;
  }

  async listUnreadPage(continuation?: string, signal?: AbortSignal): Promise<FreshRssPage> {
    if (continuation !== undefined && !isValidContinuation(continuation)) throw new Error('Invalid FreshRSS continuation');
    const token = await this.authenticate(signal);
    const query = new URLSearchParams({ xt: 'user/-/state/com.google/read', n: '100' });
    if (continuation !== undefined) query.set('c', continuation);
    const text = await this.request(`/reader/api/0/stream/contents/user/-/state/com.google/reading-list?${query}`, {
      method: 'GET', headers: { Authorization: `GoogleLogin auth=${token}` },
    }, signal);
    let data: ObjectValue;
    try { data = object(JSON.parse(text) as unknown); } catch { throw new Error('Invalid FreshRSS response'); }
    if (!Array.isArray(data.items)) throw new Error('Invalid FreshRSS response');
    const next = data.continuation;
    if (next !== undefined && (!isValidContinuation(next) || next === continuation)) throw new Error('Invalid FreshRSS continuation');
    return { items: data.items.map(parseItem), continuation: next === undefined ? null : next as string };
  }

  async getReadState(ids: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, boolean>> {
    const body = idForm(ids);
    const token = await this.authenticate(signal);
    const text = await this.request('/reader/api/0/stream/items/contents', {
      method: 'POST', headers: { Authorization: `GoogleLogin auth=${token}` }, body,
    }, signal);
    return parseReadStates(text, ids);
  }

  async markRead(ids: readonly string[], signal: AbortSignal): Promise<void> {
    // Hard gate: no configuration can enable production mutations before V5 and digest evidence.
    if (!acknowledgementEnabled()) throw new Error('FreshRSS acknowledgement is disabled');
    const token = await this.authenticate(signal);
    await sendExactReadAcknowledgement(this.request.bind(this), `GoogleLogin auth=${token}`, ids, signal);
  }
}

function acknowledgementEnabled(): boolean {
  return false;
}
