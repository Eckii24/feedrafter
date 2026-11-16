import { test, expect } from '@playwright/test';

test('reconnect during post-save refresh does not discard its result or strand loading', async ({ page }) => {
  let reads = 0;
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const refreshStarted = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/settings/source-permissions') {
      const count = ++reads;
      if (count === 2) { started(); await blocked; }
      return route.fulfill({ json: { sources: [{ id: 's', contextId: 'c', externalFeedId: 'f', title: 'News', override: count === 1 ? null : true }], hostRules: [] } });
    }
    if (path === '/api/v1/sources/s/fallback-permission') return route.fulfill({ json: { ok: true } });
    if (path === '/api/v1/settings/preferences') return route.fulfill({ json: { halfLifeDays: 90 } });
    if (path.startsWith('/api/v1/preferences/')) return route.fulfill({ json: { items: [], nextCursor: null, asOf: '2026-01-01', halfLifeDays: 90 } });
    if (path === '/api/v1/articles') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/v1/scores') return route.fulfill({ json: { items: [] } });
    return route.abort();
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    const section = page.getByRole('region', { name: 'Source fallback permissions' });
    const select = section.getByLabel('Override for News (f) — context c');
    await select.selectOption('allow');
    await section.getByRole('button', { name: 'Save override for News (f) — context c' }).click();
    await refreshStarted;
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(section.getByText(/Offline/)).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(section.getByText(/Offline/)).toHaveCount(0);
    release();
    await expect(section.getByText('News (f) — context c — Saved: allow')).toBeVisible();
    await expect(select).toBeEnabled();
    await expect(section.getByText('Loading source permissions…')).toHaveCount(0);
    expect(reads).toBe(2);
  } finally { release(); }
});
