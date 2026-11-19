import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { extractHtml } from '../../src/server/adapters/web/extract.js';
import { createPublicWeb, type TransportSeam } from '../../src/server/adapters/web/request.js';
import { prepareArticle, type ArticleQualityClassifier, type ArticleExtractionFallback } from '../../src/server/application/prepare-article.js';
import type { ContentExecutionContext, ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import type { PublicWeb } from '../../src/server/ports/public-web.js';
import type { SourceFallbackPermission } from '../../src/server/ports/source-fallback-permission.js';

const context: ContentExecutionContext = { articleId: 'article', taskId: 'task', action: 'prepare', generation: 1, executionToken: 'token', expectedContentRevision: 4 };
const paragraph = 'A thoughtful report with independent details and meaningful factual information. '.repeat(30);
const html = (text: string) => `<html><head><title>Report</title></head><body><article><h1>Report</h1><p>${text}</p></article></body></html>`;
const usable = { probability: 0.7, usable: true };
function fixture(body = html(paragraph)) {
  let content = 'previous';
  let current = true;
  const publications: Array<Parameters<ContentStore['publishTask']>[1]> = [];
  const store: Pick<ContentStore, 'publishTask'> = { async publishTask(received, outcome) {
    expect(received).toEqual(context);
    publications.push(outcome);
    if (!current) return null;
    if (outcome.kind === 'success') content = outcome.content.text;
    return outcome.kind === 'success' ? 5 : 4;
  } };
  const web: PublicWeb = { async get() { return { status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(body) }; } };
  const classifier: ArticleQualityClassifier = { classify: vi.fn(async () => usable) };
  const fallback: ArticleExtractionFallback = { extract: vi.fn(async () => ({ text: paragraph, sourceUrl: 'https://example.com/article' })) };
  const permission = { resolveForArticle: vi.fn<SourceFallbackPermission['resolveForArticle']>(async () => false), resolveHost: vi.fn<SourceFallbackPermission['resolveHost']>(async host => host === 'other.com') };
  const run = ({ permission: decision = false, noResolver = false, noFallback = false, ...options }: { permission?: boolean | null; noResolver?: boolean; noFallback?: boolean; signal?: AbortSignal } = {}) => {
    permission.resolveForArticle.mockResolvedValue(decision);
    return prepareArticle({ web, content: store, classifier, ...(!noFallback && { fallback }), ...(!noResolver && { permission }), now: () => new Date('2026-01-01Z') }, { context, originalUrl: 'https://example.com/article', ...options });
  };
  return { run, web, classifier, fallback, permission, publications, content: () => content, stale: () => { current = false; } };
}

describe('article preparation', () => {
  it('extracts original page and publishes the exact fenced context', async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ status: 'succeeded', revision: 5 });
    expect(f.content()).toContain('thoughtful report');
    expect(f.publications[0]).toMatchObject({ kind: 'success', content: { quality: 'usable', sourceUrl: 'https://example.com/article', limitation: 'quality is heuristic' } });
    expect(f.fallback.extract).not.toHaveBeenCalled();
    expect(f.permission.resolveForArticle).not.toHaveBeenCalled();
  });
  it.each([['short', html('short')], ['navigation', '<html><body><nav><a href="/">Home</a><a href="/news">News</a></nav></body></html>'], ['malformed', '<html><body><p><']])('rejects %s without replacing previous content', async (_label, body) => {
    const f = fixture(body);
    vi.mocked(f.classifier.classify).mockResolvedValue({ probability: 0.1, usable: false });
    expect((await f.run()).status).toBe('failed');
    expect(f.content()).toBe('previous');
    expect(f.fallback.extract).not.toHaveBeenCalled();
  });
  it.each([0.299, 0.3, 0.699])('does not accept probability %s', async score => {
    const f = fixture(); vi.mocked(f.classifier.classify).mockResolvedValue({ probability: score, usable: true });
    expect((await f.run()).status).toBe('failed'); expect(f.content()).toBe('previous');
  });
  it('denies fallback by default; permits it with source permission and reclassifies independently', async () => {
    const f = fixture();
    vi.mocked(f.classifier.classify).mockResolvedValueOnce({ probability: 0.5, usable: false }).mockResolvedValueOnce({ probability: 0.5, usable: false }).mockResolvedValueOnce(usable);
    expect((await f.run()).status).toBe('failed');
    expect(f.fallback.extract).not.toHaveBeenCalled();
    expect((await f.run({ permission: true })).status).toBe('succeeded');
    expect(f.permission.resolveForArticle).toHaveBeenCalledWith(context.articleId, 'example.com');
    expect(f.classifier.classify).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(f.classifier.classify).mock.calls) expect(call[2]).toBe(context.taskId);
    expect(f.publications[1]).toMatchObject({ kind: 'success', content: { limitation: 'fallback; quality is heuristic' } });
  });
  it.each([false, null])('denies fallback for permission %s', async decision => {
    const f = fixture(); vi.mocked(f.classifier.classify).mockResolvedValue({ probability: 0.2, usable: false });
    expect((await f.run({ permission: decision })).status).toBe('failed');
    expect(f.publications[0]).toMatchObject({ kind: 'failure', errorCode: 'fallback_permission_denied' });
    expect(f.fallback.extract).not.toHaveBeenCalled();
  });
  it('fails closed without resolver, including a legacy arbitrary allowFallback flag', async () => {
    const f = fixture(); vi.mocked(f.classifier.classify).mockResolvedValue({ probability: 0.2, usable: false });
    const legacy = { noResolver: true, allowFallback: true };
    expect((await f.run(legacy)).status).toBe('failed');
    expect(f.publications[0]).toMatchObject({ kind: 'failure', errorCode: 'fallback_permission_denied' });
    expect(f.fallback.extract).not.toHaveBeenCalled();
  });
  it('does not resolve permission when fallback is absent', async () => {
    const f = fixture(); vi.mocked(f.classifier.classify).mockResolvedValue({ probability: 0.2, usable: false });
    expect((await f.run({ permission: true, noFallback: true })).status).toBe('failed');
    expect(f.permission.resolveForArticle).not.toHaveBeenCalled();
    expect(f.fallback.extract).not.toHaveBeenCalled();
  });
  it('uses the original hostname, not a redirect, for permission', async () => {
    const f = fixture();
    f.web.get = async () => ({ status: 200, finalUrl: 'https://redirect.example/page', headers: { 'content-type': 'text/html' }, body: Buffer.from(html(paragraph)) });
    vi.mocked(f.classifier.classify).mockResolvedValueOnce({ probability: 0.2, usable: false }).mockResolvedValueOnce(usable);
    expect((await f.run({ permission: true })).status).toBe('succeeded');
    expect(f.permission.resolveForArticle).toHaveBeenCalledWith(context.articleId, 'example.com');
  });
  it('sanitizes resolver errors and never invokes fallback', async () => {
    const f = fixture(); vi.mocked(f.classifier.classify).mockResolvedValue({ probability: 0.2, usable: false });
    f.permission.resolveForArticle.mockRejectedValueOnce(new Error('secret https://example.com/token'));
    expect((await f.run()).status).toBe('failed');
    expect(f.publications[0]).toMatchObject({ kind: 'failure', errorCode: 'preparation_failed' });
    expect(JSON.stringify(f.publications)).not.toContain('secret');
    expect(f.fallback.extract).not.toHaveBeenCalled();
  });
  it('rejects fallback when independent classification fails', async () => {
    const f = fixture(); vi.mocked(f.classifier.classify).mockResolvedValue({ probability: 0.1, usable: false });
    expect((await f.run({ permission: true })).status).toBe('failed'); expect(f.content()).toBe('previous');
  });
  it.each([null, {}, { probability: NaN, usable: true }, { probability: 1.1, usable: true }, { probability: 1, usable: true, extra: true }])('rejects invalid classifier output', async value => {
    const f = fixture(); vi.mocked(f.classifier.classify).mockResolvedValue(value);
    expect((await f.run({ permission: true })).status).toBe('failed'); expect(f.content()).toBe('previous'); expect(f.fallback.extract).not.toHaveBeenCalled();
  });
  it.each([null, { text: '', sourceUrl: 'https://example.com' }, { text: 'text', sourceUrl: 'http://127.0.0.1/' }, { text: paragraph, sourceUrl: 'https://example.com', complete: true }])('rejects invalid fallback output', async value => {
    const f = fixture(); vi.mocked(f.classifier.classify).mockResolvedValue({ probability: 0.1, usable: false }); vi.mocked(f.fallback.extract).mockResolvedValue(value);
    expect((await f.run({ permission: true })).status).toBe('failed'); expect(f.content()).toBe('previous');
  });
  it('requires fallback provenance to be fetched through the capability', async () => {
    const f = fixture(); vi.mocked(f.classifier.classify).mockResolvedValueOnce({ probability: 0.2, usable: false });
    vi.mocked(f.fallback.extract).mockResolvedValue({ text: paragraph, sourceUrl: 'https://other.com/article' });
    expect((await f.run({ permission: true })).status).toBe('failed'); expect(f.content()).toBe('previous');
  });
  it('allows fetched fallback provenance', async () => {
    const f = fixture(); vi.mocked(f.classifier.classify).mockResolvedValueOnce({ probability: 0.2, usable: false }).mockResolvedValueOnce(usable);
    vi.mocked(f.fallback.extract).mockImplementation(async ({ webFetch }) => {
      await webFetch('https://other.com/article');
      return { text: paragraph, sourceUrl: 'https://other.com/article' };
    });
    expect((await f.run({ permission: true })).status).toBe('succeeded');
  });
  it.each([
    ['denied.example', false, false], ['absent.example', false, false], ['sub.example.com', false, false],
    ['allowed.example', true, true], ['BÜCHER.Example.', true, true], ['EXAMPLE.COM.', false, true],
  ])('applies target-specific permission to %s', async (host, hostRule, succeeds) => {
    const f = fixture();
    f.permission.resolveHost.mockImplementation(async target => target === 'allowed.example' || (target === 'xn--bcher-kva.example' && hostRule));
    vi.mocked(f.classifier.classify).mockResolvedValueOnce({ probability: 0.2, usable: false }).mockResolvedValue(usable);
    const transport = vi.fn<TransportSeam>(async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Readable.from([html(paragraph)]) }));
    f.web.get = createPublicWeb({ resolver: async () => ['8.8.8.8'], transport }).get;
    vi.mocked(f.fallback.extract).mockImplementation(async ({ webFetch }) => {
      await webFetch(`https://${host}/linked`).catch(() => {});
      return { text: paragraph, sourceUrl: 'https://example.com/article' };
    });
    expect((await f.run({ permission: true })).status).toBe(succeeds ? 'succeeded' : 'failed');
    expect(transport).toHaveBeenCalledTimes(succeeds ? 2 : 1);
    if (!succeeds) expect(f.publications[0]).toMatchObject({ errorCode: 'fallback_permission_denied' });
  });
  it('does not grant fallback provenance to a different-host primary redirect', async () => {
    const f = fixture();
    f.web.get = async () => ({ status: 200, finalUrl: 'https://denied.example/page', headers: { 'content-type': 'text/html' }, body: Buffer.from(html(paragraph)) });
    vi.mocked(f.classifier.classify).mockResolvedValueOnce({ probability: 0.2, usable: false }).mockResolvedValue(usable);
    vi.mocked(f.fallback.extract).mockResolvedValue({ text: paragraph, sourceUrl: 'https://denied.example/page' });
    expect((await f.run({ permission: true })).status).toBe('failed');
    expect(f.publications[0]).toMatchObject({ errorCode: 'fallback_permission_denied' });
  });
  it('rejects a swallowed denied redirect during fallback before dispatch', async () => {
    const f = fixture();
    vi.mocked(f.classifier.classify).mockResolvedValueOnce({ probability: 0.2, usable: false }).mockResolvedValue(usable);
    const resolver = vi.fn(async () => ['8.8.8.8']);
    const transport = vi.fn<TransportSeam>(async url => url.pathname === '/linked'
      ? { status: 302, headers: { location: 'https://denied.example/next' }, body: Readable.from([]) }
      : { status: 200, headers: { 'content-type': 'text/html' }, body: Readable.from([html(paragraph)]) });
    f.web.get = createPublicWeb({ resolver, transport }).get;
    vi.mocked(f.fallback.extract).mockImplementation(async ({ webFetch }) => {
      await webFetch('https://other.com/linked').catch(() => {});
      return { text: paragraph, sourceUrl: 'https://example.com/article' };
    });
    expect((await f.run({ permission: true })).status).toBe('failed');
    expect(f.publications[0]).toMatchObject({ errorCode: 'fallback_permission_denied' });
    expect(transport.mock.calls.map(([url]) => url.hostname)).toEqual(['example.com', 'other.com']);
    expect(resolver).toHaveBeenCalledTimes(2);
  });
  it.each(['paywall', '401', '402', '403', 'failed', 'limit', 'pending', 'non-html', 'encoding'])('denies fallback after %s even if adapter hides it', async scenario => {
    const f = fixture();
    vi.mocked(f.classifier.classify).mockResolvedValueOnce({ probability: 0.2, usable: false }).mockResolvedValue(usable);
    f.web.get = async url => {
      if (url.includes('/article')) return { status: 200, finalUrl: url, headers: { 'content-type': 'text/html' }, body: Buffer.from(html(paragraph)) };
      if (scenario === 'failed') throw new Error('network');
      if (scenario === 'pending') { await new Promise(resolve => setTimeout(resolve, 20)); }
      return { status: ['401', '402', '403'].includes(scenario) ? Number(scenario) : 200, finalUrl: url, headers: { 'content-type': scenario === 'non-html' ? 'application/pdf' : scenario === 'encoding' ? 'text/html; charset=iso-8859-1' : 'text/html' }, body: Buffer.from(html(scenario === 'paywall' || scenario === 'pending' ? 'Subscription required' : paragraph)) };
    };
    vi.mocked(f.fallback.extract).mockImplementation(async ({ webFetch }) => {
      if (scenario === 'limit') for (let i = 0; i < 20; i++) await webFetch('https://other.com/page');
      if (scenario === 'pending') void webFetch('https://other.com/page').catch(() => {});
      else if (scenario === 'limit') await expect(webFetch('https://other.com/page')).rejects.toThrow('fallback_fetch_limit');
      else await webFetch('https://other.com/page').catch(() => {});
      return { text: paragraph, sourceUrl: 'https://example.com/article' };
    });
    expect(await f.run({ permission: true })).toEqual({ status: 'failed', revision: 4 });
    expect(f.publications[0]).toMatchObject({ kind: 'failure' });
    if (['paywall', '401', '402', '403', 'pending'].includes(scenario)) expect(f.publications[0]).toMatchObject({ errorCode: 'access_denied' });
    expect(f.content()).toBe('previous');
  }, 20_000);
  it('waits for a clean pending fallback inspection before publishing', async () => {
    const f = fixture();
    vi.mocked(f.classifier.classify).mockResolvedValueOnce({ probability: 0.2, usable: false }).mockResolvedValue(usable);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const get = f.web.get;
    f.web.get = async (url, signal) => { if (url.includes('other.com')) await gate; return get(url, signal); };
    vi.mocked(f.fallback.extract).mockImplementation(async ({ webFetch }) => {
      void webFetch('https://other.com/page').catch(() => {});
      return { text: paragraph, sourceUrl: 'https://example.com/article' };
    });
    const pending = f.run({ permission: true });
    await vi.waitFor(() => expect(f.fallback.extract).toHaveBeenCalled());
    expect(f.publications).toHaveLength(0);
    release();
    expect((await pending).status).toBe('succeeded');
  });
  it.each([
    ['HTTP charset', 'text/html; charset=iso-8859-1', ''],
    ['meta charset', 'text/html', '<meta charset="iso-8859-1">'],
    ['http-equiv', 'text/html', '<meta http-equiv="content-type" content="text/html; charset=iso-8859-1">'],
    ['XML declaration', 'application/xhtml+xml', '<?xml version="1.0" encoding="iso-8859-1"?>'],
    ['duplicate HTTP charset', 'text/html; charset=utf-8; charset=iso-8859-1', ''],
    ['malformed HTTP charset', 'text/html; charset = iso-8859-1', ''],
    ['conflicting meta charset', 'text/html; charset=utf-8', '<meta charset="utf-8"><meta charset="windows-1252">'],
    ['duplicate XML encoding', 'application/xhtml+xml', '<?xml version="1.0" encoding="utf-8" encoding="iso-8859-1"?>'],
    ['invalid UTF-8', 'text/html', ''],
    ['NUL in document', 'text/html', '\0'],
  ])('rejects %s without publishing mojibake', async (_name, type, declaration) => {
    const f = fixture();
    f.web.get = async () => ({ status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': type }, body: Buffer.concat([Buffer.from(declaration + html(paragraph)), _name === 'invalid UTF-8' ? Buffer.from([0xe9]) : Buffer.alloc(0)]) });
    expect(await f.run()).toEqual({ status: 'failed', revision: 4 });
    expect(f.content()).toBe('previous');
  });
  it('accepts valid UTF-8 declarations and non-ASCII text', async () => {
    const f = fixture('<?xml version="1.0" encoding="UTF-8"?>' + html('<meta charset="UTF-8">' + paragraph + ' café'));
    expect((await f.run()).status).toBe('succeeded');
    expect(f.content()).toContain('café');
  });
  it('rejects ISO-8859-1 header and bytes instead of publishing mojibake', async () => {
    const f = fixture();
    f.web.get = async () => ({ status: 200, finalUrl: 'https://example.com/article', headers: { 'content-type': 'text/html; charset=iso-8859-1' }, body: Buffer.from(html(paragraph + ' café'), 'latin1') });
    expect(await f.run()).toEqual({ status: 'failed', revision: 4 });
    expect(f.content()).toBe('previous');
  });
  it('access evidence overrides long text and never invokes fallback', async () => {
    const f = fixture(html(paragraph + ' Subscribe to continue reading.'));
    expect((await f.run({ permission: true })).status).toBe('failed');
    expect(f.publications[0]).toMatchObject({ kind: 'failure', errorCode: 'access_denied' }); expect(f.content()).toBe('previous');
    expect(f.classifier.classify).not.toHaveBeenCalled(); expect(f.fallback.extract).not.toHaveBeenCalled();
  });
  it('fences stale success and failure and preserves previous content', async () => {
    const f = fixture(); f.stale();
    expect((await f.run()).status).toBe('stale');
    vi.mocked(f.classifier.classify).mockResolvedValue(null);
    expect((await f.run()).status).toBe('stale'); expect(f.content()).toBe('previous');
  });
  it('cancels a pending retrieval and publishes a fenced failure', async () => {
    const f = fixture(); f.web.get = () => new Promise(() => {});
    const abort = new AbortController(); const pending = f.run({ signal: abort.signal }); abort.abort();
    expect((await pending).status).toBe('failed'); expect(f.publications[0]).toMatchObject({ kind: 'failure', errorCode: 'cancelled_or_timeout' }); expect(f.content()).toBe('previous');
  });
});

describe('bounded readability worker', () => {
  it('times out and handles a crash', async () => {
    await expect(extractHtml(Buffer.from('x'), undefined, { timeoutMs: 100, workerUrl: new URL('data:text/javascript,while(true){}') })).rejects.toThrow();
    await expect(extractHtml(Buffer.from('x'), undefined, { workerUrl: new URL('data:text/javascript,throw new Error("crash")') })).rejects.toThrow('crash');
  });
  it('does not execute scripts or load subresources', async () => {
    let requests = 0;
    const server = createServer((_req, res) => { requests++; res.end('bad'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('no address');
      const url = `http://127.0.0.1:${address.port}/`;
      const result = await extractHtml(Buffer.from(html(`${paragraph}<img src="${url}"><script>fetch('${url}')</script><iframe src="${url}"></iframe>`)));
      expect(result.text).toContain('thoughtful report'); expect(result.text).not.toContain('fetch('); expect(requests).toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
