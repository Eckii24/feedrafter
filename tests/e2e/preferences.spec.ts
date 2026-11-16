import { test, expect } from '@playwright/test';

test('manages preferences, paginates and merges selected tags', async ({ page, context }) => {
  const tags = [
    { id: 'a', label: 'Alpha', positive: 3, negative: 1, weight: 1.5, manualOffset: 0 },
    { id: 'b', label: 'Beta', positive: 2, negative: 0, weight: 2, manualOffset: 0 },
  ];
  const source = { id: 's', label: 'News', positive: 4, negative: 2, weight: 0.75, manualOffset: 0 };
  let halfLife = 90;
  let mergeBody: unknown;
  let failOffset = true;
  let failHalfLife = true;
  let failMerge = true;
  const queries: string[] = [];
  const writes: string[] = [];
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/api/v1/articles') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (url.pathname === '/api/v1/scores') return route.fulfill({ json: { items: [] } });
    if (url.pathname === '/api/v1/settings/preferences') {
      if (method === 'PATCH') {
        if (failHalfLife) { failHalfLife = false; return route.fulfill({ status: 500, json: { error: { message: 'Half-life failed' } } }); }
        halfLife = route.request().postDataJSON().halfLifeDays; writes.push('half-life');
      }
      return route.fulfill({ json: { halfLifeDays: halfLife } });
    }
    if (url.pathname === '/api/v1/preferences/tags' || url.pathname === '/api/v1/preferences/sources') {
      queries.push(url.search);
      const items = url.pathname.endsWith('tags') ? (url.searchParams.has('cursor') ? tags.slice(1) : tags.slice(0, 1)) : [source];
      return route.fulfill({ json: { items, nextCursor: url.pathname.endsWith('tags') && !url.searchParams.has('cursor') && tags.length > 1 ? 'next' : null, asOf: '2026-01-01T00:00:00.000Z', halfLifeDays: halfLife } });
    }
    if (url.pathname === '/api/v1/sources/s/preference') {
      if (failOffset) { failOffset = false; return route.fulfill({ status: 500, json: { error: { message: 'Offset failed' } } }); }
      source.manualOffset = route.request().postDataJSON().manualOffset; writes.push('offset');
      return route.fulfill({ json: { id: source.id, manualOffset: source.manualOffset } });
    }
    if (url.pathname === '/api/v1/tags/a/preference') {
      tags[0]!.manualOffset = route.request().postDataJSON().manualOffset; writes.push('tag offset');
      return route.fulfill({ json: { id: 'a', manualOffset: tags[0]!.manualOffset } });
    }
    if (url.pathname === '/api/v1/tags/merge') {
      if (failMerge) { failMerge = false; return route.fulfill({ status: 409, json: { error: { message: 'Tags cannot be merged' } } }); }
      mergeBody = route.request().postDataJSON(); writes.push('merge'); tags.splice(1, 1);
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === '/api/v1/settings/source-permissions') return route.fulfill({ json: { sources: [], hostRules: [] } });
    return route.abort();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Preferences', exact: true })).toBeFocused();
  const tagSection = page.getByRole('region', { name: 'Tag preferences' });
  const sourceSection = page.getByRole('region', { name: 'Source preferences' });
  await expect(tagSection.getByText(/Positive votes: 3; Negative votes: 1; Decayed weight: 1.5/)).toBeVisible();
  await expect(sourceSection.getByText(/Positive votes: 4; Negative votes: 2; Decayed weight: 0.75/)).toBeVisible();
  await page.getByLabel('Vote half-life (days)').fill('30');
  await page.keyboard.press('Tab');
  const saveHalfLife = page.getByRole('button', { name: 'Save half-life' });
  await expect(saveHalfLife).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Half-life failed');
  await expect(saveHalfLife).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Half-life saved.')).toBeVisible();
  await expect(saveHalfLife).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(tagSection.getByLabel('Search tags')).toBeFocused();
  expect(halfLife).toBe(30);
  await sourceSection.getByLabel('Manual offset for News').fill('-2.5');
  await sourceSection.getByRole('button', { name: 'Save offset for News' }).click();
  await expect(sourceSection.getByRole('alert')).toContainText('Offset failed');
  await expect(sourceSection.getByLabel('Manual offset for News')).toHaveValue('-2.5');
  await expect(sourceSection.getByLabel('Manual offset for News')).toBeFocused();
  await sourceSection.getByRole('button', { name: 'Save offset for News' }).click();
  await expect(sourceSection.getByText('Manual offset saved.')).toBeVisible();
  expect(source.manualOffset).toBe(-2.5);
  await tagSection.getByLabel('Manual offset for Alpha').fill('1.25');
  await tagSection.getByRole('button', { name: 'Save offset for Alpha' }).click();
  await expect(tagSection.getByText('Manual offset saved.')).toBeVisible();
  expect(tags[0]!.manualOffset).toBe(1.25);
  await tagSection.getByLabel('Search tags').fill('alp');
  await tagSection.getByRole('button', { name: 'Search' }).click();
  await tagSection.getByLabel('Sort tags').selectOption('weight');
  await tagSection.getByLabel('Order tags').selectOption('desc');
  await expect.poll(() => queries.some(q => q.includes('query=alp') && q.includes('sort=weight') && q.includes('direction=desc'))).toBe(true);
  await tagSection.getByLabel('Select Alpha for merge').check();
  await tagSection.getByRole('button', { name: 'Next' }).click();
  await tagSection.getByLabel('Select Beta for merge').check();
  await tagSection.getByRole('button', { name: 'Previous' }).click();
  await expect(tagSection.getByLabel('Select Alpha for merge')).toBeChecked();
  await tagSection.getByLabel('Target: Alpha').check();
  page.once('dialog', dialog => dialog.dismiss());
  await tagSection.getByRole('button', { name: 'Merge tags' }).click();
  expect(mergeBody).toBeUndefined();
  page.once('dialog', dialog => dialog.accept());
  await tagSection.getByRole('button', { name: 'Merge tags' }).focus();
  await page.keyboard.press('Enter');
  await expect(tagSection.getByRole('alert')).toContainText('Tags cannot be merged');
  await expect(tagSection.getByLabel('Target: Alpha')).toBeChecked();
  await expect(tagSection.getByRole('button', { name: 'Merge tags' })).toBeFocused();
  page.once('dialog', dialog => dialog.accept());
  await page.keyboard.press('Enter');
  await expect(tagSection.getByText('Tags merged.')).toBeVisible();
  await expect(tagSection.getByRole('heading', { name: 'Tag preferences' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(tagSection.getByLabel('Search tags')).toBeFocused();
  expect(mergeBody).toEqual({ targetId: 'a', sourceIds: ['b'] });
  await context.setOffline(true);
  await expect(page.getByText(/Offline\. Preference/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save half-life' })).toBeDisabled();
  await expect(sourceSection.getByRole('button', { name: 'Save offset for News' })).toBeDisabled();
  expect(writes).toEqual(['half-life', 'offset', 'tag offset', 'merge']);
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Back to reader' }).click();
  await expect(page.getByRole('button', { name: 'Preferences', exact: true })).toBeFocused();
});

for (const staleFails of [false, true]) {
  test(`older settings GET ${staleFails ? 'failure' : 'success'} cannot replace a confirmed save`, async ({ page, context }) => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let getCount = 0;
    let patchBody: unknown;
    await page.addInitScript(() => {
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (String(args[0]).endsWith('/api/v1/settings/preferences') && (!args[1]?.method || args[1].method === 'GET')) {
          const originalJson = response.json.bind(response);
          response.json = () => originalJson().then(value => {
            setTimeout(() => { document.documentElement.dataset.settingsReads = String(Number(document.documentElement.dataset.settingsReads || 0) + 1); }, 0);
            return value;
          });
        }
        return response;
      };
    });
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/v1/settings/preferences') {
        if (route.request().method() === 'PATCH') {
          patchBody = route.request().postDataJSON();
          return route.fulfill({ json: { halfLifeDays: 30 } });
        }
        const current = ++getCount;
        if (current !== 2) await blocked;
        if (current === 3 && staleFails) return route.fulfill({ status: 500, json: { error: { message: 'Stale load failed' } } });
        return route.fulfill({ json: { halfLifeDays: 90 } });
      }
      if (path === '/api/v1/settings/source-permissions') return route.fulfill({ json: { sources: [], hostRules: [] } });
      if (path.startsWith('/api/v1/preferences/')) return route.fulfill({ json: { items: [], nextCursor: null, asOf: '2026-01-01T00:00:00.000Z', halfLifeDays: 90 } });
      if (path === '/api/v1/articles') return route.fulfill({ json: { items: [], nextCursor: null } });
      if (path === '/api/v1/scores') return route.fulfill({ json: { items: [] } });
      return route.abort();
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    await expect.poll(() => getCount).toBe(1);
    await page.getByRole('button', { name: 'Retry preference settings' }).click();
    const halfLife = page.getByLabel('Vote half-life (days)');
    await expect(halfLife).toHaveValue('90');
    await context.setOffline(true);
    await expect(page.getByText(/Offline\. Preference/)).toBeVisible();
    await context.setOffline(false);
    await expect.poll(() => getCount).toBe(3);
    await halfLife.fill('30');
    await page.getByRole('button', { name: 'Save half-life' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Half-life saved.' })).toBeVisible();
    expect(patchBody).toEqual({ halfLifeDays: 30 });
    release();
    await expect.poll(() => page.locator('html').getAttribute('data-settings-reads')).toBe('3');
    await expect(halfLife).toHaveValue('30');
    await expect(page.getByRole('status').filter({ hasText: 'Half-life saved.' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(halfLife).toBeEnabled();
  });
}

for (const staleFails of [false, true]) {
  test(`settings GET ${staleFails ? 'failure' : 'success'} during a pending half-life save is ignored`, async ({ page, context }) => {
    let releasePatch!: () => void;
    let patchStarted!: () => void;
    const blockedPatch = new Promise<void>(resolve => { releasePatch = resolve; });
    const patchPending = new Promise<void>(resolve => { patchStarted = resolve; });
    let getCount = 0;
    let patchBody: unknown;
    await page.addInitScript(() => {
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (String(args[0]).endsWith('/api/v1/settings/preferences') && (!args[1]?.method || args[1].method === 'GET')) {
          const originalJson = response.json.bind(response);
          response.json = () => originalJson().then(value => {
            setTimeout(() => { document.documentElement.dataset.settingsReads = String(Number(document.documentElement.dataset.settingsReads || 0) + 1); }, 0);
            return value;
          });
        }
        return response;
      };
    });
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/v1/settings/preferences') {
        if (route.request().method() === 'PATCH') {
          patchBody = route.request().postDataJSON();
          patchStarted();
          await blockedPatch;
          return route.fulfill({ json: { halfLifeDays: 30 } });
        }
        const current = ++getCount;
        if (current === 2 && staleFails) return route.fulfill({ status: 500, json: { error: { message: 'Stale load failed' } } });
        return route.fulfill({ json: { halfLifeDays: 90 } });
      }
      if (path === '/api/v1/settings/source-permissions') return route.fulfill({ json: { sources: [], hostRules: [] } });
      if (path.startsWith('/api/v1/preferences/')) return route.fulfill({ json: { items: [], nextCursor: null, asOf: '2026-01-01T00:00:00.000Z', halfLifeDays: 90 } });
      if (path === '/api/v1/articles') return route.fulfill({ json: { items: [], nextCursor: null } });
      if (path === '/api/v1/scores') return route.fulfill({ json: { items: [] } });
      return route.abort();
    });
    try {
      await page.goto('/');
      await page.getByRole('button', { name: 'Preferences', exact: true }).click();
      const halfLife = page.getByLabel('Vote half-life (days)');
      await expect(halfLife).toHaveValue('90');
      await halfLife.fill('30');
      await page.getByRole('button', { name: 'Save half-life' }).click();
      await patchPending;
      expect(patchBody).toEqual({ halfLifeDays: 30 });
      await context.setOffline(true);
      await expect(page.getByText(/Offline\. Preference/)).toBeVisible();
      await context.setOffline(false);
      await expect.poll(() => getCount).toBe(2);
      await expect.poll(() => page.locator('html').getAttribute('data-settings-reads')).toBe('2');
      await expect(halfLife).toHaveValue('30');
      await expect(halfLife).toBeDisabled();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Retry preference settings' })).toHaveCount(0);
      releasePatch();
      await expect(page.getByRole('status').filter({ hasText: 'Half-life saved.' })).toBeVisible();
      await expect(halfLife).toHaveValue('30');
      await expect(halfLife).toBeEnabled();
      await expect(page.getByRole('alert')).toHaveCount(0);
    } finally {
      releasePatch();
    }
  });
}

for (const action of ['half-life', 'merge'] as const) {
  for (const fails of [false, true]) {
    test(`${action} ${fails ? 'failure' : 'success'} preserves focus moved during request`, async ({ page }) => {
      let release!: () => void;
      let started!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const requestStarted = new Promise<void>(resolve => { started = resolve; });
      const tags = [
        { id: 'a', label: 'Alpha', positive: 0, negative: 0, weight: 0, manualOffset: 0 },
        { id: 'b', label: 'Beta', positive: 0, negative: 0, weight: 0, manualOffset: 0 },
      ];
      await page.route('**/api/v1/**', async route => {
        const path = new URL(route.request().url()).pathname;
        const method = route.request().method();
        if ((action === 'half-life' && path === '/api/v1/settings/preferences' && method === 'PATCH') || (action === 'merge' && path === '/api/v1/tags/merge')) {
          started();
          await blocked;
          return fails ? route.fulfill({ status: 500, json: { error: { message: 'Write failed' } } }) : route.fulfill({ json: action === 'merge' ? { ok: true } : { halfLifeDays: 30 } });
        }
        if (path === '/api/v1/settings/preferences') return route.fulfill({ json: { halfLifeDays: 90 } });
        if (path.startsWith('/api/v1/preferences/')) return route.fulfill({ json: { items: path.endsWith('tags') ? tags : [], nextCursor: null, asOf: '2026-01-01T00:00:00.000Z', halfLifeDays: 90 } });
        if (path === '/api/v1/articles') return route.fulfill({ json: { items: [], nextCursor: null } });
        if (path === '/api/v1/scores') return route.fulfill({ json: { items: [] } });
        if (path === '/api/v1/settings/source-permissions') return route.fulfill({ json: { sources: [], hostRules: [] } });
        return route.abort();
      });
      await page.goto('/');
      await page.getByRole('button', { name: 'Preferences', exact: true }).click();
      if (action === 'half-life') {
        await page.getByLabel('Vote half-life (days)').fill('30');
        await page.keyboard.press('Tab');
        await expect(page.getByRole('button', { name: 'Save half-life' })).toBeFocused();
      } else {
        await page.getByLabel('Select Alpha for merge').check();
        await page.getByLabel('Select Beta for merge').check();
        await page.getByLabel('Target: Alpha').check();
        await page.getByRole('button', { name: 'Merge tags' }).focus();
        page.once('dialog', dialog => dialog.accept());
      }
      await page.keyboard.press('Enter');
      await requestStarted;
      await page.keyboard.press('Tab');
      const movedTo = await page.locator(':focus').elementHandle();
      expect(movedTo).not.toBeNull();
      expect(await movedTo!.evaluate(element => element.tagName)).not.toBe('BODY');
      release();
      await expect(page.getByText(fails ? 'Write failed' : action === 'merge' ? 'Tags merged.' : 'Half-life saved.', { exact: !fails })).toBeVisible();
      await expect.poll(() => movedTo!.evaluate(element => element === document.activeElement)).toBe(true);
    });
  }
}
