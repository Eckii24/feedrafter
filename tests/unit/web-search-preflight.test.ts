import { afterEach, describe, expect, it, vi } from 'vitest';

const dom = vi.hoisted(() => ({ html: vi.fn(), xml: vi.fn(), post: vi.fn() }));
vi.mock('linkedom', () => ({ parseHTML: dom.html, DOMParser: class { parseFromString = dom.xml; } }));
vi.mock('node:worker_threads', () => ({ parentPort: { postMessage: dom.post }, workerData: { body: Buffer.from(''), provider: '' } }));
import * as threads from 'node:worker_threads';

afterEach(() => { vi.resetModules(); vi.clearAllMocks(); });
async function run(body: string, provider: string) {
  Object.assign(threads.workerData, { body: Buffer.from(body), provider });
  dom.html.mockImplementation(() => { throw new Error('DOM entered'); });
  dom.xml.mockImplementation(() => { throw new Error('DOM entered'); });
  await import('../../src/server/adapters/web/search-worker.js');
  expect(dom.post).toHaveBeenCalledWith({ error: true });
}
describe('search raw complexity preflight', () => {
  it.each([
    ['shallow HTML nodes', '<div></div>'.repeat(100_000), 'DuckDuckGo'],
    ['HTML entities', '&amp;'.repeat(50_001), 'DuckDuckGo'],
    ['HTML comments', '<!--x-->'.repeat(25_001), 'DuckDuckGo'],
    ['attribute entities', '<div a="' + '&amp;'.repeat(50_001) + '">', 'DuckDuckGo'],
    ['boolean HTML attributes', '<div' + ' a'.repeat(50_001) + '>', 'DuckDuckGo'],
    ['XML entities', '<rss><channel>' + '&amp;'.repeat(50_001) + '</channel></rss>', 'Bing RSS'],
    ['XML attributes', '<rss ' + Array.from({ length: 13_000 }, (_, i) => `a${i}="x"`).join(' ') + '><channel/></rss>', 'Bing RSS'],
  ])('rejects %s before DOM construction', async (_name, body, provider) => {
    await run(body, provider);
    expect(dom.html).not.toHaveBeenCalled(); expect(dom.xml).not.toHaveBeenCalled();
  });
  it('permits the raw budget boundary to reach HTML DOM construction', async () => {
    await run(' '.repeat(50_000), 'DuckDuckGo'); expect(dom.html).toHaveBeenCalledOnce();
  });
  it('rejects one unit over the raw budget before HTML DOM construction', async () => {
    await run(' '.repeat(50_001), 'DuckDuckGo'); expect(dom.html).not.toHaveBeenCalled();
  });
  it('permits the raw budget boundary to reach XML DOM construction', async () => {
    await run('<rss><channel>' + ' '.repeat(49_990) + '</channel></rss>', 'Bing RSS'); expect(dom.xml).toHaveBeenCalledOnce();
  });
  it('rejects one unit over the raw XML budget before DOM construction', async () => {
    await run('<rss><channel>' + ' '.repeat(49_991) + '</channel></rss>', 'Bing RSS'); expect(dom.xml).not.toHaveBeenCalled();
  });
});
