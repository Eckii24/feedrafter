import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicWeb, type TransportSeam } from '../../src/server/adapters/web/request.js';
import { publicUrl } from '../../src/server/adapters/web/public-url.js';

const resolvePublic = async () => ['8.8.8.8', '2606:4700:4700::1111'];
const response = (body: Buffer | string, headers = {}, status = 200) => ({ status, headers, body: Readable.from([body]) });
afterEach(() => vi.useRealTimers());

describe('public URL policy', () => {
  it.each(['file:///etc/passwd', 'ftp://public.example/', 'http://user:password@public.example/',
    'http://@public.example/', 'http://127.0.0.1/', 'http://2130706433/', 'http://[::1]/',
    'http://localhost/', 'http://router/', 'http://foo.local/', 'http://foo.internal/',
    'http://foo.home.arpa/', 'https://public.example:8443/'])('rejects %s', url => {
    expect(() => publicUrl(url)).toThrow();
  });
  it('accepts @ outside authority and rejects empty credentials in relative authorities', () => {
    for (const value of ['https://medium.com/@author/report', 'https://example.com/?email=a@b.com', 'https://example.com/#@name']) expect(() => publicUrl(value)).not.toThrow();
    expect(publicUrl('https:foo@bar', new URL('https://example.com/base')).pathname).toBe('/foo@bar');
    expect(() => publicUrl('//@example.com/path', new URL('https://example.com'))).toThrow();
    expect(() => publicUrl('https:\\\\@example.com/path')).toThrow();
  });
  it('accepts only allowed schemes and ports', () => {
    for (const url of ['http://public.example:443/a', 'https://public.example:80/a', 'https://public.example/']) expect(publicUrl(url)).toBeInstanceOf(URL);
  });
});

describe('public retrieval', () => {
  it('rejects mixed, empty and rebinding DNS before dispatch', async () => {
    const transport = vi.fn<TransportSeam>(async () => response('bad'));
    for (const answers of [[], ['8.8.8.8', '127.0.0.1'], ['8.8.8.8', '::ffff:8.8.8.8'], ['2002:808:808::1']]) {
      await expect(createPublicWeb({ resolver: async () => answers, transport }).get('https://public.example')).rejects.toThrow();
    }
    expect(transport).not.toHaveBeenCalled();
    const resolver = vi.fn().mockResolvedValueOnce(['8.8.8.8']).mockResolvedValueOnce(['127.0.0.1']);
    const redirect = vi.fn<TransportSeam>(async () => response('', { location: '/again' }, 302));
    await expect(createPublicWeb({ resolver, transport: redirect }).get('https://public.example')).rejects.toThrow('DNS');
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledTimes(2);
  });
  it('resolves every redirected host, pins a validated answer and strips fragments', async () => {
    const resolver = vi.fn(async (host: string) => host === 'first.example' ? ['1.1.1.1'] : ['8.8.8.8']);
    const transport = vi.fn<TransportSeam>(async url => url.hostname === 'first.example'
      ? response('', { location: 'https://second.example/path#fragment', 'set-cookie': ['x=y'] }, 302)
      : response('hello'));
    const result = await createPublicWeb({ resolver, transport }).get('https://first.example/');
    expect(result.body.toString()).toBe('hello');
    expect(result.finalUrl).toBe('https://second.example/path');
    expect(transport.mock.calls.map(([url, ip]) => [url.hostname, ip])).toEqual([['first.example', '1.1.1.1'], ['second.example', '8.8.8.8']]);
  });
  it.each([false, true])('authorizes every redirect target before DNS and transport (allowed=%s)', async allowed => {
    const resolver = vi.fn(resolvePublic);
    const transport = vi.fn<TransportSeam>(async url => url.hostname === 'first.example'
      ? response('', { location: 'https://second.example/' }, 302) : response('ok'));
    const authorizeTarget = vi.fn(async (url: string) => {
      if (new URL(url).hostname === 'second.example' && !allowed) throw new Error('denied');
    });
    const pending = createPublicWeb({ resolver, transport }).get('https://first.example/', undefined, { authorizeTarget });
    if (allowed) expect((await pending).body.toString()).toBe('ok');
    else await expect(pending).rejects.toThrow('denied');
    expect(authorizeTarget.mock.calls.map(([url]) => new URL(url).hostname)).toEqual(['first.example', 'second.example']);
    expect(resolver).toHaveBeenCalledTimes(allowed ? 2 : 1);
    expect(transport).toHaveBeenCalledTimes(allowed ? 2 : 1);
  });
  it('does not bypass a denied middle redirect', async () => {
    const resolver = vi.fn(resolvePublic);
    const transport = vi.fn<TransportSeam>(async url => response('', { location: url.hostname === 'first.example' ? 'https://denied.example/' : 'https://last.example/' }, 302));
    await expect(createPublicWeb({ resolver, transport }).get('https://first.example/', undefined, {
      authorizeTarget: async url => { if (new URL(url).hostname === 'denied.example') throw new Error('denied'); },
    })).rejects.toThrow('denied');
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['cancel', 'deadline'])('stops before DNS when authorization outlives %s', async mode => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const resolver = vi.fn(resolvePublic);
    const transport = vi.fn<TransportSeam>(async () => response('ok'));
    const controller = new AbortController();
    const pending = createPublicWeb({ resolver, transport }).get('https://first.example/', controller.signal, {
      timeoutMs: 40, authorizeTarget: async () => { entered(); await gate; },
    });
    await started;
    if (mode === 'cancel') controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow(mode === 'cancel' ? 'cancelled' : 'deadline');
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(resolver).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['http://other.example/', 'https://user:pass@other.example/', 'https://127.0.0.1/', 'https://router/'])('rejects redirect to %s', async location => {
    const transport = vi.fn<TransportSeam>(async () => response('', { location }, 302));
    await expect(createPublicWeb({ resolver: resolvePublic, transport }).get('https://public.example')).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('limits redirects to five', async () => {
    const transport = vi.fn<TransportSeam>(async () => response('', { location: '/loop' }, 302));
    await expect(createPublicWeb({ resolver: resolvePublic, transport }).get('https://public.example')).rejects.toThrow('redirect');
    expect(transport).toHaveBeenCalledTimes(6);
  });
  it('enforces compressed and decompressed limits and rejects incomplete streams', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 65);
    const compressed = gzipSync(big);
    for (const [data, headers] of [[big, {}], [compressed, { 'content-encoding': 'gzip' }], [gzipSync(randomBytes(10 * 1024 * 1024 + 1)), { 'content-encoding': 'gzip' }]] as const) {
      await expect(createPublicWeb({ resolver: resolvePublic, transport: async () => response(data, headers) }).get('https://public.example')).rejects.toThrow();
    }
    const broken = Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('socket closed'); })());
    await expect(createPublicWeb({ resolver: resolvePublic, transport: async () => ({ status: 200, headers: {}, body: broken }) }).get('https://public.example')).rejects.toThrow('socket closed');
  });
  it('supports stricter per-call limits without changing defaults', async () => {
    const body = Buffer.alloc(101, 65);
    for (const [data, headers] of [[body, {}], [gzipSync(body), { 'content-encoding': 'gzip' }]] as const) {
      const web = createPublicWeb({ resolver: resolvePublic, transport: async () => response(data, headers) });
      await expect(web.get('https://public.example', undefined, { maxBytes: 100 })).rejects.toThrow('limit');
      expect((await web.get('https://public.example')).body).toEqual(body);
    }
    const web = createPublicWeb({ resolver: resolvePublic, transport: async () => response('') });
    for (const limits of [{ maxBytes: 0 }, { maxBytes: 10 * 1024 * 1024 + 1 }, { timeoutMs: 30_001 }, { maxRedirects: -1 }]) {
      await expect(web.get('https://public.example', undefined, limits)).rejects.toThrow('Invalid public web limits');
    }
    vi.useFakeTimers();
    const stuck = createPublicWeb({ resolver: () => new Promise(() => {}), transport: async () => response('') });
    const pending = stuck.get('https://public.example', undefined, { timeoutMs: 50 });
    const assertion = expect(pending).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(50); await assertion;
  });
  it('propagates caller cancellation to an in-flight resolver', async () => {
    let observed: AbortSignal | undefined;
    const web = createPublicWeb({ resolver: async (_host, signal) => { observed = signal; return new Promise(() => {}); }, transport: async () => response('never') });
    const controller = new AbortController();
    const pending = web.get('https://public.example', controller.signal);
    await vi.waitFor(() => expect(observed).toBeDefined());
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    expect(observed?.aborted).toBe(true);
  });
  it('times out DNS and queued requests within the total deadline', async () => {
    vi.useFakeTimers();
    const web = createPublicWeb({ resolver: () => new Promise(() => {}), transport: async () => response('never') });
    const results = Promise.allSettled([web.get('https://public.example'), web.get('https://public.example'), web.get('https://public.example')]);
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await results).every(result => result.status === 'rejected')).toBe(true);
  });
  it('allows at most two simultaneous retrievals across instances', async () => {
    let running = 0; let max = 0;
    const releases: Array<() => void> = [];
    const transport: TransportSeam = async () => {
      running++; max = Math.max(max, running);
      await new Promise<void>(resolve => releases.push(resolve));
      running--; return response('ok');
    };
    const web = createPublicWeb({ resolver: resolvePublic, transport });
    const tasks = [web.get('https://public.example'), web.get('https://public.example'), createPublicWeb({ resolver: resolvePublic, transport }).get('https://public.example')];
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.forEach(release => release());
    await Promise.all(tasks);
    expect(max).toBe(2);
  });
});
