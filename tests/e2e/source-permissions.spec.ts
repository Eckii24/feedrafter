import { test, expect } from '@playwright/test';

test('manages source overrides and exact-host rules with retry, refresh and offline protection', async ({ page, context }) => {
  const source = { id: 'source/1', contextId: 'context', externalFeedId: 'feed-42', title: 'News', override: null as boolean | null };
  const hostRules = [{ host: 'youtube.com', allowed: true }];
  const writes: { method: string; path: string; body: unknown }[] = [];
  let reads = 0;
  let failRead = true;
  let failWrite = true;
  let failRefresh = false;
  let releaseWrite!: () => void;
  let writeStarted!: () => void;
  const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
  const pendingWrite = new Promise<void>(resolve => { writeStarted = resolve; });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/v1/settings/source-permissions') {
      reads++;
      if (failRead || failRefresh) { failRead = false; failRefresh = false; return route.fulfill({ status: 500, json: { error: { message: 'Read failed' } } }); }
      return route.fulfill({ json: { sources: [source], hostRules } });
    }
    if (path === '/api/v1/sources/source%2F1/fallback-permission') {
      const body = route.request().postDataJSON() as { override: boolean | null };
      writes.push({ path, method, body });
      if (failWrite) { failWrite = false; return route.fulfill({ status: 500, json: { error: { message: 'Write failed' } } }); }
      if (body.override === true) { writeStarted(); await blockedWrite; failRefresh = true; }
      source.override = body.override;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/v1/settings/source-permissions/host') {
      const body = route.request().postDataJSON() as { host: string; allowed: boolean };
      writes.push({ path, method, body });
      hostRules.push({ host: body.host.toLowerCase(), allowed: body.allowed });
      return route.fulfill({ json: hostRules[hostRules.length - 1] });
    }
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
    await expect(section.getByRole('alert')).toContainText('Read failed');
    await section.getByRole('button', { name: 'Retry source permissions' }).click();
    await expect(section.getByText('News (feed-42) — context context — Saved: inherit')).toBeVisible();
    await expect(section.getByText('youtube.com — allow')).toBeVisible();
    const select = section.getByLabel('Override for News (feed-42) — context context');
    const save = section.getByRole('button', { name: 'Save override for News (feed-42) — context context' });
    await select.selectOption('allow');
    await save.click();
    await expect(section.getByRole('alert')).toContainText('Write failed');
    await expect(select).toHaveValue('allow');
    await section.getByRole('button', { name: 'Retry source permissions' }).click();
    await expect(save).toBeEnabled();
    await save.click();
    await pendingWrite;
    await expect(select).toBeDisabled();
    await expect(section.getByRole('button', { name: 'Save host rule' })).toBeDisabled();
    releaseWrite();
    await expect(section.getByRole('alert')).toContainText('Read failed');
    await expect(select).toHaveValue('allow');
    await expect(select).toBeDisabled();
    await section.getByRole('button', { name: 'Retry source permissions' }).click();
    await expect(section.getByText('News (feed-42) — context context — Saved: allow')).toBeVisible();
    await select.selectOption('deny');
    await save.click();
    await expect(section.getByText('News (feed-42) — context context — Saved: deny')).toBeVisible();
    await select.selectOption('inherit');
    await save.click();
    await expect(section.getByText('News (feed-42) — context context — Saved: inherit')).toBeVisible();
    await section.getByLabel('Exact host').fill('Example.COM');
    await section.getByLabel('Host permission').selectOption('deny');
    await section.getByRole('button', { name: 'Save host rule' }).click();
    await expect(section.getByText('example.com — deny')).toBeVisible();
    expect(reads).toBeGreaterThanOrEqual(6);
    expect(writes).toEqual([
      { path: '/api/v1/sources/source%2F1/fallback-permission', method: 'PATCH', body: { override: true } },
      { path: '/api/v1/sources/source%2F1/fallback-permission', method: 'PATCH', body: { override: true } },
      { path: '/api/v1/sources/source%2F1/fallback-permission', method: 'PATCH', body: { override: false } },
      { path: '/api/v1/sources/source%2F1/fallback-permission', method: 'PATCH', body: { override: null } },
      { path: '/api/v1/settings/source-permissions/host', method: 'PUT', body: { host: 'Example.COM', allowed: false } },
    ]);
    await select.selectOption('allow');
    await context.setOffline(true);
    await expect(section.getByText(/Offline/)).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(section.getByRole('button', { name: 'Save host rule' })).toBeDisabled();
    await context.setOffline(false);
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue('allow');
    expect(writes).toHaveLength(5);
  } finally { releaseWrite(); }
});

test('distinguishes identical feeds in different contexts and saves the selected source', async ({ page }) => {
  const sources = [
    { id: '11111111-1111-4111-8111-111111111111', contextId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', externalFeedId: 'feed/42', title: 'News', override: null as boolean | null },
    { id: '22222222-2222-4222-8222-222222222222', contextId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', externalFeedId: 'feed/42', title: 'News', override: null as boolean | null },
  ];
  const writes: { method: string; path: string; body: unknown }[] = [];
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/settings/source-permissions') return route.fulfill({ json: { sources, hostRules: [] } });
    if (path.startsWith('/api/v1/sources/') && path.endsWith('/fallback-permission')) {
      const body = route.request().postDataJSON() as { override: boolean | null };
      writes.push({ method: route.request().method(), path, body });
      const source = sources.find(item => path === `/api/v1/sources/${item.id}/fallback-permission`);
      if (!source) return route.fulfill({ status: 404 });
      source.override = body.override;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/v1/settings/preferences') return route.fulfill({ json: { halfLifeDays: 90 } });
    if (path.startsWith('/api/v1/preferences/')) return route.fulfill({ json: { items: [], nextCursor: null, asOf: '2026-01-01', halfLifeDays: 90 } });
    if (path === '/api/v1/articles') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/v1/scores') return route.fulfill({ json: { items: [] } });
    return route.abort();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  const section = page.getByRole('region', { name: 'Source fallback permissions' });
  const labels = sources.map(source => `News (feed/42) — context ${source.contextId}`);
  for (const label of labels) {
    await expect(section.getByText(`${label} — Saved: inherit`, { exact: true })).toBeVisible();
    await expect(section.getByRole('combobox', { name: `Override for ${label}`, exact: true })).toBeVisible();
    await expect(section.getByRole('button', { name: `Save override for ${label}`, exact: true })).toBeVisible();
  }
  await section.getByRole('combobox', { name: `Override for ${labels[1]}`, exact: true }).selectOption('allow');
  await section.getByRole('button', { name: `Save override for ${labels[1]}`, exact: true }).click();
  await expect(section.getByText(`${labels[1]} — Saved: allow`, { exact: true })).toBeVisible();
  await expect(section.getByText(`${labels[0]} — Saved: inherit`, { exact: true })).toBeVisible();
  expect(writes).toEqual([{ method: 'PATCH', path: `/api/v1/sources/${sources[1].id}/fallback-permission`, body: { override: true } }]);
});
