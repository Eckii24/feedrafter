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
