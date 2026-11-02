import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FreshRssClient } from '../../src/server/adapters/freshrss/client.js';
import { sendExactReadAcknowledgement } from '../../src/server/adapters/freshrss/acknowledgement-protocol.js';

const baseUrl = 'https://reader.example/api/greader.php';

describe('FreshRSS read adapter', () => {
  it('reads the sanitized multi-page fixture without coercing IDs or cursors', async () => {
    const pages: unknown[] = JSON.parse(readFileSync(new URL('../fixtures/freshrss-pages.json', import.meta.url), 'utf8'));
    let index = 0;
    const transport: typeof fetch = async input => String(input).endsWith('/ClientLogin')
      ? new Response('Auth=fixture-token\n') : Response.json(pages[index++]);
    const client = new FreshRssClient({ baseUrl, email: 'fixture-user', password: 'fixture-password', transport });
    const first = await client.listUnreadPage();
    const second = await client.listUnreadPage(first.continuation!);
    expect(first.items[0]?.id).toBe('9007199254740993123');
    expect(first.continuation).toBe('fixture-next+/=');
    expect(second.items[0]?.id).toBe('002');
    expect(second.continuation).toBeNull();
  });

  it('authenticates and passes an opaque continuation without coercing IDs', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport: typeof fetch = async (input, init = {}) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) return new Response('SID=x\nAuth=secret-token\n');
      return Response.json({ items: [{ id: '9007199254740993123', title: 'News', author: 'Writer', published: 1700000000, alternate: [{ href: 'https://example.com/article' }], origin: { streamId: 'feed/1', title: 'Feed' } }], continuation: 'opaque+/=' });
    };
    const client = new FreshRssClient({ baseUrl, email: 'user', password: 'password', transport });
    const page = await client.listUnreadPage('next+/=');
    expect(page.items[0]).toEqual({
      id: '9007199254740993123', title: 'News', author: 'Writer',
      publishedAt: new Date('2023-11-14T22:13:20.000Z'),
      url: 'https://example.com/article', feedId: 'feed/1', feedTitle: 'Feed',
    });
    expect(page.continuation).toBe('opaque+/=');
    expect(requests[0]?.url).toBe(`${baseUrl}/accounts/ClientLogin`);
    const query = new URL(requests[1]!.url).searchParams;
    expect(query.get('c')).toBe('next+/=');
    expect(query.get('xt')).toBe('user/-/state/com.google/read');
    expect(new Headers(requests[1]?.init.headers).get('Authorization')).toBe('GoogleLogin auth=secret-token');
    expect(requests[1]?.init.redirect).toBe('error');
  });

  it.each([
    { items: [{ id: 9007199254740992 }] },
    { items: [{ id: '' }] },
    { items: [], continuation: '' },
    { items: [], continuation: 'bad\nvalue' },
    { items: [], continuation: 123 },
    { items: [], continuation: 'same' },
    { items: 'bad' },
  ])('rejects malformed IDs or continuation: %j', async (payload) => {
    const transport: typeof fetch = async (input) => String(input).endsWith('/ClientLogin')
      ? new Response('Auth=token\n') : Response.json(payload);
    const client = new FreshRssClient({ baseUrl, email: 'u', password: 'p', transport });
    await expect(client.listUnreadPage('same')).rejects.toThrow();
  });

  it.each(['ftp://reader.example/api/greader.php', 'https://user:pass@reader.example/api/greader.php', 'https://reader.example/api/greader.php?token=x'])('rejects unsafe configured URL %s', (url) => {
    expect(() => new FreshRssClient({ baseUrl: url, email: 'u', password: 'p' })).toThrow('Invalid FreshRSS configuration');
  });

  it('never sends a mutation while acknowledgement is disabled', async () => {
    let calls = 0;
    const transport: typeof fetch = async () => { calls++; return new Response(''); };
    const client = new FreshRssClient({ baseUrl, email: 'u', password: 'p', transport });
    await expect(client.markRead(['item'], new AbortController().signal)).rejects.toThrow('disabled');
    expect(calls).toBe(0);
  });

  it('reconciles only exact requested string IDs with validated categories', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport: typeof fetch = async (input, init = {}) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) return new Response('Auth=token\n');
      return Response.json({ items: [
        { id: '9007199254740993123', categories: ['user/-/state/com.google/read'] },
        { id: '002', categories: [] },
      ] });
    };
    const client = new FreshRssClient({ baseUrl, email: 'u', password: 'p', transport });
    expect(await client.getReadState(['9007199254740993123', '002'], new AbortController().signal))
      .toEqual(new Map([['9007199254740993123', true], ['002', false]]));
    expect(requests[1]?.url).toBe(`${baseUrl}/reader/api/0/stream/items/contents`);
    expect(requests[1]?.init.method).toBe('POST');
    expect((requests[1]?.init.body as URLSearchParams).getAll('i')).toEqual(['9007199254740993123', '002']);
  });

  it.each([
    { items: [] },
    { items: [{ id: 'a' }] },
    { items: [{ id: 'a', categories: [1] }] },
    { items: [{ id: 'b', categories: [] }] },
    { items: [{ id: 'a', categories: [] }, { id: 'a', categories: [] }] },
    { items: [{ id: 9007199254740992, categories: [] }] },
  ])('rejects ambiguous reconciliation: %j', async (payload) => {
    const transport: typeof fetch = async (input) => String(input).endsWith('/ClientLogin')
      ? new Response('Auth=token\n') : Response.json(payload);
    const client = new FreshRssClient({ baseUrl, email: 'u', password: 'p', transport });
    await expect(client.getReadState(['a'], new AbortController().signal)).rejects.toThrow('Invalid FreshRSS response');
  });

  it('models exact-ID mutation protocol without enabling the client gate', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const request = async (path: string, init: RequestInit) => {
      calls.push({ path, init });
      return calls.length === 1 ? 'mutation-token' : 'OK';
    };
    await sendExactReadAcknowledgement(request, 'GoogleLogin auth=secret', ['12345678901234567890', '002'], new AbortController().signal);
    expect(calls.map((call) => call.path)).toEqual(['/reader/api/0/token', '/reader/api/0/edit-tag']);
    const form = calls[1]?.init.body as URLSearchParams;
    expect(form.getAll('i')).toEqual(['12345678901234567890', '002']);
    expect(form.get('T')).toBe('mutation-token');
    expect(form.get('a')).toBe('user/-/state/com.google/read');
    expect(new Headers(calls[1]?.init.headers).get('Authorization')).toBe('GoogleLogin auth=secret');
  });

  it('rejects invalid ID batches and ambiguous mutation responses', async () => {
    const signal = new AbortController().signal;
    let calls = 0;
    const request = async () => { calls++; return calls === 1 ? 'token' : 'not OK'; };
    await expect(sendExactReadAcknowledgement(request, 'auth', ['a', 'a'], signal)).rejects.toThrow('Invalid FreshRSS IDs');
    expect(calls).toBe(0);
    await expect(sendExactReadAcknowledgement(request, 'auth', ['a'], signal)).rejects.toThrow('Invalid FreshRSS response');
  });

  it('does not expose provider response bodies or credentials in errors', async () => {
    const transport: typeof fetch = async () => new Response('secret response body', { status: 403 });
    const client = new FreshRssClient({ baseUrl, email: 'u', password: 'private-password', transport });
    await expect(client.listUnreadPage()).rejects.toThrow('FreshRSS request failed');
    await expect(client.listUnreadPage()).rejects.not.toThrow('secret response body');
  });
});
