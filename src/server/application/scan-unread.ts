import type { FreshRssEntry, FreshRssPort } from '../ports/freshrss.js';

/** Fetch and commit one page at a time. This phase never acknowledges entries. */
export async function scanUnread(
  freshrss: Pick<FreshRssPort, 'listUnreadPage'>,
  savePage: (items: readonly FreshRssEntry[]) => Promise<void>,
  signal: AbortSignal,
): Promise<number> {
  const seen = new Set<string>();
  let continuation: string | undefined;
  let count = 0;
  for (;;) {
    signal.throwIfAborted();
    const page = await freshrss.listUnreadPage(continuation, signal);
    signal.throwIfAborted();
    const next = page.continuation;
    if (next !== null && (typeof next !== 'string' || next.length === 0 || next.length > 4096 ||
        Array.from(next).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || seen.has(next))) {
      throw new Error('Invalid FreshRSS continuation');
    }
    await savePage(page.items);
    signal.throwIfAborted();
    count += page.items.length;
    if (next === null) return count;
    seen.add(next);
    continuation = next;
  }
}
