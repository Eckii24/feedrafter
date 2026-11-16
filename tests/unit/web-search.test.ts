import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebSearch } from '../../src/server/adapters/web/search.js';
import type { PublicWeb, PublicWebResponse } from '../../src/server/ports/public-web.js';

const html = `<div id="links" class="results"><div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%23part"> First &amp; title </a><div class="result__snippet"> One <b>two</b> </div></div><div class="result"><a class="result__a" href="https://example.com/a">Duplicate</a></div><div class="result"><a class="result__a" href="http://127.0.0.1/">unsafe</a></div><div class="result"><a class="result__a" href="https://duckduckgo.com/l/?uddg=http%3A%2F%2Flocalhost">redirect</a></div><div class="result"><a class="result__a" href="https://www.bing.com/ck/a">bing</a></div></div>`;
const rss = `<?xml version="1.0"?><rss version="2.0"><channel><item><title><![CDATA[Hello & world]]></title><link>https://example.org/?a=1&amp;b=2#x</link><description><![CDATA[<b>Great</b> &amp; useful]]></description></item></channel></rss>`;
const response = (body: string, status = 200, headers = {}): PublicWebResponse => ({ status, headers, body: Buffer.from(body), finalUrl: 'https://example.com/' });
const setup = (...responses: Array<PublicWebResponse | Error>) => {
  const get = vi.fn<PublicWeb['get']>(async () => { const value = responses.shift(); if (value instanceof Error) throw value; if (!value) throw new Error('extra request'); return value; });
  return { get, search: createWebSearch({ get }).search };
};
afterEach(() => vi.useRealTimers());

describe('offline search', () => {
  it('validates inputs without dispatch or query leakage', async () => {
    const { get, search } = setup();
    for (const query of ['', '   ', 'a'.repeat(501)]) await expect(search(query)).rejects.toThrow('Invalid search query');
    for (const n of [0, 11, 1.2, NaN]) await expect(search('private', n)).rejects.toThrow('Invalid maxResults');
    expect(get).not.toHaveBeenCalled();
  });
  it('encodes trimmed query, unwraps, normalizes, filters, deduplicates and caps', async () => {
    const { get, search } = setup(response(html));
    expect(await search('  a & b/ü  ')).toEqual({ provider: 'DuckDuckGo', results: [{ title: 'First & title', url: 'https://example.com/a', snippet: 'One two' }] });
    const [url, signal, limits] = get.mock.calls[0]!;
    expect(new URL(url).searchParams.get('q')).toBe('a & b/ü');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(limits).toEqual({ maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000, maxRedirects: 0 });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('enforces requested result count and filters internal redirect links', async () => {
    const page = '<div id="links"><div class="result"><a class="result__a" href="https://example.com/1">One</a></div><div class="result"><a class="result__a" href="https://example.org/2">Two</a></div></div>';
    expect((await setup(response(page)).search('q', 1)).results).toEqual([{ title: 'One', url: 'https://example.com/1', snippet: '' }]);
    const xml = '<rss><channel><item><title>bad</title><link>https://www.bing.com/ck/a</link></item><item><title>ok</title><link>https://example.org/</link><description>Some &amp; text</description></item><item><title>duplicate</title><link>https://example.org/#x</link></item></channel></rss>';
    expect((await setup(response('bad'), response(xml)).search('q')).results).toEqual([{ title: 'ok', url: 'https://example.org/', snippet: 'Some & text' }]);
  });
  it('falls back on challenge, parses RSS entities, CDATA and HTML snippets', async () => {
    const { get, search } = setup(response('Unfortunately, bots use DuckDuckGo too'), response(rss));
    expect(await search('q')).toEqual({ provider: 'Bing RSS', results: [{ title: 'Hello & world', url: 'https://example.org/?a=1&b=2', snippet: 'Great & useful' }] });
    expect(new URL(get.mock.calls[1]![0]).searchParams.get('format')).toBe('rss');
  });
  it('falls back on HTTP errors, oversized bodies and malformed UTF-8', async () => {
    for (const first of [response('', 404), response('x'.repeat(2 * 1024 * 1024 + 1)), { ...response(''), body: Buffer.from([0xff]) }]) {
      const { get, search } = setup(first, response(rss));
      expect((await search('q')).provider).toBe('Bing RSS'); expect(get).toHaveBeenCalledTimes(2);
    }
  });
  it('recognizes valid empty results without fallback', async () => {
    const a = setup(response('<div id="links" class="results"><div class="result result--no-result">No results found</div></div>'));
    expect(await a.search('q')).toEqual({ provider: 'DuckDuckGo', results: [] }); expect(a.get).toHaveBeenCalledTimes(1);
    const b = setup(response('bad'), response('<rss><channel></channel></rss>'));
    expect(await b.search('q')).toEqual({ provider: 'Bing RSS', results: [] });
  });
  it.each(['no-results', 'result--no-result'])('falls back for an out-of-container DDG %s marker', async marker => {
    const { get, search } = setup(response(`<main>Service unavailable</main><footer class="${marker}">widget</footer>`), response(rss));
    expect(await search('q')).toEqual({ provider: 'Bing RSS', results: [{ title: 'Hello & world', url: 'https://example.org/?a=1&b=2', snippet: 'Great & useful' }] });
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('falls back when DDG rows have no valid destinations and rejects the same Bing outcome', async () => {
    const duck = '<div id="links"><div class="result"><a class="result__a" href="http://127.0.0.1/">bad</a></div></div>';
    const bing = '<rss><channel><item><title>bad</title><link>http://127.0.0.1/</link></item></channel></rss>';
    const a = setup(response(duck), response(rss));
    expect((await a.search('q')).provider).toBe('Bing RSS'); expect(a.get).toHaveBeenCalledTimes(2);
    await expect(setup(response(duck), response(bing)).search('q')).rejects.toThrow('SEARCH_UNAVAILABLE');
  });
  it.each([
    '<rss><channel><error>Service temporarily unavailable</error></channel></rss>',
    '<rss><channel><wrapper><item><title>x</title><link>https://example.com/</link></item></wrapper></channel></rss>',
    '<rss><channel><description><item/></description></channel></rss>',
    '<rss><channel><description><error code="503">Unavailable</error></description></channel></rss>',
    '<rss xmlns="urn:not-rss"><channel/></rss>', '<rss><channel xmlns="urn:provider-error"/></rss>',
    '<x:rss xmlns:x="urn:not-rss"><channel/></x:rss>', '<rss xmlns:x="urn:not-rss"><x:channel/></rss>',
    '<rss><channel><description xmlns="urn:provider-error">Results</description></channel></rss>',
    '<rss xmlns="urn:not-rss"><channel xmlns=""/></rss>',
    '<rss><channel><image><error/></image></channel></rss>', '<rss><channel><image><title><error/></title></image></channel></rss>',
    '<rss><channel><item><title>x</title><link>https://example.com/</link><error/></item></channel></rss>',
    '<rss><channel><item><title><error/></title><link>https://example.com/</link></item></channel></rss>',
    '<rss><channel/><item/></rss>', '<rss><channel>Service unavailable</channel></rss>',
  ])('rejects unknown or misplaced RSS layouts', async xml => {
    await expect(setup(response('bad'), response(xml)).search('q')).rejects.toThrow('SEARCH_UNAVAILABLE');
  });
  it('accepts an RSS metadata-only channel', async () => {
    expect(await setup(response('bad'), response('<rss><channel><title>Search</title><link>https://example.org/</link><description>Results</description></channel></rss>')).search('q')).toEqual({ provider: 'Bing RSS', results: [] });
  });
  it('accepts supported compound channel and item metadata', async () => {
    const xml = '<rss xmlns=""><channel><image><url>https://example.org/logo</url><title>Logo</title><link>https://example.org/</link><width>88</width><height>31</height><description>Logo</description></image><textInput><title>Search</title><description>Query</description><name>q</name><link>https://example.org/</link></textInput><skipHours><hour>1</hour></skipHours><skipDays><day>Monday</day></skipDays><item><title>News</title><link>https://example.org/</link><description>Snippet</description><pubDate>Today</pubDate><guid isPermaLink="false">id</guid><source url="https://example.org/">Source</source><category>News</category><enclosure url="https://example.org/a" length="1" type="text/plain"/></item></channel></rss>';
    expect(await setup(response('bad'), response(xml)).search('q')).toEqual({ provider: 'Bing RSS', results: [{ title: 'News', url: 'https://example.org/', snippet: 'Snippet' }] });
  });
  it.each(['<html>not results</html>', '<div id="links"><div class="result">bad</div></div>', '<div id="links">captcha</div>'])('falls back on malformed/challenge page', async page => {
    const { search } = setup(response(page), response(rss)); expect((await search('q')).provider).toBe('Bing RSS');
  });
  it.each(['<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel/></rss>', '<rss><channel></rss>', '<rss><channel><item><title>x</title></item></channel></rss>', '<rss><channel>&evil;</channel></rss>', '<rss><channel/></rss><other/>'])('rejects malformed/unsafe XML', async xml => {
    const { search } = setup(response('bad'), response(xml)); await expect(search('secret query')).rejects.toThrow(/^SEARCH_UNAVAILABLE$/);
  });
  it.each([
    '<div id="links"><div class="error">Service temporarily unavailable</div></div>',
    '<div class="results"><div>Unknown layout</div></div>',
    '<form action="/challenge"><div id="links"></div></form>',
  ])('falls back for unknown containers and structural challenges', async page => {
    expect((await setup(response(page), response(rss)).search('q')).provider).toBe('Bing RSS');
  });
  it('accepts challenge words in actual results', async () => {
    const page = '<div id="links"><div class="result"><a class="result__a" href="https://example.com/">CAPTCHA research</a><p class="result__snippet">human verification and captcha</p></div></div>';
    expect((await setup(response(page)).search('q')).results).toEqual([{ title: 'CAPTCHA research', url: 'https://example.com/', snippet: 'human verification and captcha' }]);
  });
  it('isolates a 20,000 nested result page from the event loop', async () => {
    const page = '<div id="links">' + '<div class="result">'.repeat(20_000) + '</div>'.repeat(20_000) + '</div>';
    const controller = new AbortController(); let ticked = false;
    const pending = setup(response(page)).search('q', 5, controller.signal);
    const tick = new Promise<void>(resolve => setTimeout(() => { ticked = true; controller.abort(); resolve(); }, 25));
    await tick; await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(ticked).toBe(true);
  }, 5000);
  it('processes the 20,000 nested-row fixture without blocking the event loop', async () => {
    const page = '<div id="links">' + '<div class="result">'.repeat(20_000) + '</div>'.repeat(20_000) + '</div>';
    let ticks = 0; const timer = setInterval(() => { ticks++; }, 10);
    const started = performance.now();
    try {
      await expect(setup(response(page), response('', 404)).search('q')).rejects.toThrow('SEARCH_UNAVAILABLE');
      expect(performance.now() - started).toBeLessThan(20_000);
      expect(ticks).toBeGreaterThan(1);
    } finally { clearInterval(timer); }
  }, 22000);
  it('rejects the XML 1.0 subset malformed vectors', async () => {
    const invalid = [
      '<rss a="1" a="2"><channel/></rss>', '<rss><channel>&#0;</channel></rss>',
      '<rss><channel>\u0001</channel></rss>', '<rss><channel>]]></channel></rss>',
      '<?xml broken?><rss><channel/></rss>', '<?xml version="1.0" junk="x"?><rss><channel/></rss>',
      '<rss><channel><!-- bad -- comment --></channel></rss>', '<rss><channel><![CDATA[unterminated</channel></rss>',
      '<rss a="&evil;"><channel/></rss>', '<rss a="&#xD800;"><channel/></rss>',
      '<rss a="unclosed><channel/></rss>', '<rss><channel>&#x110000;</channel></rss>',
      '<!DOCTYPE rss SYSTEM "file:///etc/passwd"><rss><channel/></rss>',
    ];
    for (const xml of invalid) await expect(setup(response('', 404), response(xml)).search('q')).rejects.toThrow('SEARCH_UNAVAILABLE');
  }, 30000);
  it('accepts subset comments, attributes, entities, and CDATA', async () => {
    const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss a="&quot;&apos;&#65;"><!-- hi --><channel><item><title><![CDATA[A & B]]></title><link>https://example.org/?a=1&amp;b=2</link><description>Research &#x41; &lt;b&gt;good&lt;/b&gt;</description></item></channel></rss>';
    expect((await setup(response('', 404), response(xml)).search('q')).results).toEqual([{ title: 'A & B', url: 'https://example.org/?a=1&b=2', snippet: 'Research A good' }]);
  });
  it('bounds attempts and honors bounded retry-after', async () => {
    vi.useFakeTimers();
    const { get, search } = setup(response('', 429, { 'retry-after': '9' }), response('', 503), response('', 202, { 'retry-after': '1' }), response('', 500));
    const result = search('secret query'); const assertion = expect(result).rejects.toThrow(/^SEARCH_UNAVAILABLE$/);
    await vi.advanceTimersByTimeAsync(1999); expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(get).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(999); expect(get).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); await assertion; expect(get).toHaveBeenCalledTimes(4);
  });
  it('uses default 250ms retry and fallback on thrown errors without leaking them', async () => {
    const log = vi.spyOn(console, 'log'); const error = vi.spyOn(console, 'error'); const warn = vi.spyOn(console, 'warn');
    vi.useFakeTimers();
    const { get, search } = setup(response('', 202), new Error('sensitive query'), new Error('private error'));
    const pending = search('sensitive query'); const assertion = expect(pending).rejects.toThrow(/^SEARCH_UNAVAILABLE$/);
    await vi.advanceTimersByTimeAsync(249); expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await assertion; expect(get).toHaveBeenCalledTimes(3);
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
    log.mockRestore(); error.mockRestore(); warn.mockRestore();
  });
  it('honors HTTP-date Retry-After and cancellation during backoff', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const controller = new AbortController();
    const { get, search } = setup(response('', 429, { 'retry-after': 'Thu, 01 Jan 2026 00:00:01 GMT' }), response(html));
    const pending = search('q', 5, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'Search cancelled' });
    await vi.advanceTimersByTimeAsync(999); expect(get).toHaveBeenCalledTimes(1);
    controller.abort('secret'); await assertion;
    await vi.advanceTimersByTimeAsync(2000); expect(get).toHaveBeenCalledTimes(1);
  });
  it('cancels pending requests and ignores raw cancellation reasons', async () => {
    const controller = new AbortController();
    const search = createWebSearch({ get: () => new Promise(() => {}) }).search;
    const pending = search('secret', 5, controller.signal); controller.abort(new Error('secret'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'Search cancelled' });
  });
  it('enforces 20 second total deadline even with a noncooperative port', async () => {
    vi.useFakeTimers();
    const get = vi.fn<PublicWeb['get']>(() => new Promise(() => {}));
    const pending = createWebSearch({ get }).search('secret');
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'Search cancelled' });
    await vi.advanceTimersByTimeAsync(20_000); await assertion; expect(get).toHaveBeenCalledTimes(1);
  });
});
