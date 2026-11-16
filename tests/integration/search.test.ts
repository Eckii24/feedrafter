import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { createPublicWeb, type TransportSeam } from '../../src/server/adapters/web/request.js';
import { createWebSearch } from '../../src/server/adapters/web/search.js';

describe('search through pinned public web (offline transport)', () => {
  it('pins validated DNS and applies the 2 MiB decompressed cap before fallback', async () => {
    const resolver = vi.fn(async (host: string) => { void host; return ['8.8.8.8']; });
    const transport = vi.fn<TransportSeam>(async url => ({ status: 200, headers: url.hostname.includes('duckduckgo') ? { 'content-encoding': 'gzip' } : {}, body: Readable.from([url.hostname.includes('duckduckgo') ? gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1, 65)) : Buffer.from('<rss><channel/></rss>')]) }));
    const result = await createWebSearch(createPublicWeb({ resolver, transport })).search('q');
    expect(result).toEqual({ provider: 'Bing RSS', results: [] });
    expect(resolver.mock.calls.map(([host]) => host)).toEqual(['html.duckduckgo.com', 'www.bing.com']);
    expect(transport.mock.calls.map(([, address]) => address)).toEqual(['8.8.8.8', '8.8.8.8']);
  });
  it('does not follow redirects, so the four-attempt cap includes wire requests', async () => {
    const transport = vi.fn<TransportSeam>(async () => ({ status: 302, headers: { location: 'https://other.example/' }, body: Readable.from([]) }));
    await expect(createWebSearch(createPublicWeb({ resolver: async () => ['8.8.8.8'], transport })).search('q')).rejects.toThrow('SEARCH_UNAVAILABLE');
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
