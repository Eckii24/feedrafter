import { expect, it } from 'vitest';
import { FreshRssClient } from '../../src/server/adapters/freshrss/client.js';
import { liveConfig, pinnedTransport } from './safety.js';

// Intentionally read-only: this cannot establish V5 acknowledgement compatibility.
it('reads the explicitly seeded disposable fixture IDs across unread pages', async () => {
  const config = liveConfig(process.env); // All consent and identity checks precede DNS/network.
  const client = new FreshRssClient({ ...config, transport: pinnedTransport(config.host) });
  const found = new Set<string>(); const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 0; pages < 100; pages++) {
    const page = await client.listUnreadPage(cursor);
    for (const item of page.items) found.add(item.id);
    if (page.continuation === null) {
      for (const id of config.ids) expect(found.has(id)).toBe(true);
      return;
    }
    if (cursors.has(page.continuation)) throw new Error('Repeated continuation');
    cursors.add(page.continuation); cursor = page.continuation;
  }
  throw new Error('Page limit exceeded');
});
