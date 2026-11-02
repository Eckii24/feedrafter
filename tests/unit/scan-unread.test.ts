import { describe, expect, it } from 'vitest';
import { scanUnread } from '../../src/server/application/scan-unread.js';

describe('unread pagination', () => {
  it('rejects a non-adjacent repeated continuation rather than looping', async () => {
    const continuations = ['a', 'b', 'a'];
    let saved = 0;
    const client = { async listUnreadPage() { return { items: [], continuation: continuations.shift() ?? null }; } };
    await expect(scanUnread(client, async () => { saved++; }, new AbortController().signal))
      .rejects.toThrow('Invalid FreshRSS continuation');
    expect(saved).toBe(2);
  });

  it('does not fetch another page after a failed commit', async () => {
    let fetched = 0;
    const client = { async listUnreadPage() { fetched++; return { items: [], continuation: 'next' }; } };
    await expect(scanUnread(client, async () => { throw new Error('commit failed'); }, new AbortController().signal))
      .rejects.toThrow('commit failed');
    expect(fetched).toBe(1);
  });
});
