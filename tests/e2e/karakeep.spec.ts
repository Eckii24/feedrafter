import { test, expect, type Page } from '@playwright/test';

const id = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';
const article = { id, sourceId: null, title: 'Example article', url: 'https://example.com/article', author: null, publishedAt: null, importedAt: '2026-01-01T00:00:00Z', kind: 'article', isRead: false, mailState: 'not_selected' };

async function setup(page: Page, url: string | null = article.url, available = true) {
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/events')) return route.abort();
    if (path === '/api/v1/karakeep') return route.fulfill({ json: { available } });
    if (path === '/api/v1/articles') return route.fulfill({ json: { items: [{ ...article, url }], nextCursor: null } });
    if (path === `/api/v1/articles/${id}`) return route.fulfill({ json: { ...article, url } });
    if (path.endsWith('/catalog')) return route.fulfill({ json: { category: { id, label: 'Fallback', archivedAt: null }, tags: [], assignmentRevision: 0 } });
    if (path.endsWith('/categories') || path.endsWith('/tags') || path.endsWith('/scores')) return route.fulfill({ json: { items: [] } });
    return route.abort();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Example article' }).click();
}

for (const [outcome, text] of [['created', 'Saved to Karakeep.'], ['existing', 'Already exists in Karakeep.'], ['uncertain', 'Karakeep needs input. Check Karakeep manually before taking further action; this request will not be retried automatically.']] as const) {
  test(`keyboard and mobile: confirmed ${outcome} only after polling`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    let posts = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await setup(page);
    await page.route(`**/api/v1/articles/${id}/karakeep`, async route => { posts++; await gate; await route.fulfill({ status: 202, json: { taskId, state: 'queued', reused: false } }); });
    await page.route(`**/api/v1/processing-tasks/${taskId}`, route => route.fulfill({ json: { id: taskId, articleId: id, action: 'karakeep', state: outcome === 'uncertain' ? 'needs_input' : 'succeeded', outcome, bookmarkId: null, nextStep: outcome === 'uncertain' ? 'Check Karakeep manually before taking further action; this request will not be retried automatically.' : null } }));
    const button = page.getByRole('button', { name: 'Save to Karakeep' });
    await button.focus(); await page.keyboard.press('Enter');
    await expect(button).toBeDisabled();
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
    expect(posts).toBe(1);
    release();
    await expect(page.getByRole('status').filter({ hasText: text })).toBeVisible();
    await expect(button).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.context().setOffline(true);
    await expect(button).toBeDisabled();
    await expect(page.getByRole('status').filter({ hasText: text })).toBeVisible();
    await page.context().setOffline(false);
  });
}

test('unavailable, invalid and unsafe URLs do not offer the action', async ({ page }) => {
  await setup(page, 'https://example.com/', false);
  await expect(page.getByRole('button', { name: 'Save to Karakeep' })).toHaveCount(0);
  for (const url of [null, 'javascript:alert(1)', 'https://user:pass@example.com/']) {
    await setup(page, url);
    await expect(page.getByRole('button', { name: 'Save to Karakeep' })).toHaveCount(0);
  }
});

test('503 hides the action', async ({ page }) => {
  await setup(page);
  let posts = 0;
  await page.route(`**/api/v1/articles/${id}/karakeep`, route => { posts++; return route.fulfill({ status: 503, json: { error: { message: 'Karakeep unavailable' } } }); });
  await page.getByRole('button', { name: 'Save to Karakeep' }).click();
  await expect(page.getByText('Karakeep is unavailable.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save to Karakeep' })).toHaveCount(0);
  expect(posts).toBe(1);
});

test('failed polling preserves task and resumes on reconnect', async ({ page }) => {
  await setup(page);
  let polls = 0;
  await page.route(`**/api/v1/articles/${id}/karakeep`, route => route.fulfill({ status: 202, json: { taskId, state: 'queued', reused: true } }));
  await page.route(`**/api/v1/processing-tasks/${taskId}`, route => {
    if (++polls === 1) return route.fulfill({ json: { id: taskId, articleId: id, action: 'karakeep', state: 'running', outcome: null, bookmarkId: null, nextStep: null } });
    if (polls === 2) return route.fulfill({ status: 500, json: { error: { message: 'failed' } } });
    return route.fulfill({ json: { id: taskId, articleId: id, action: 'karakeep', state: 'succeeded', outcome: 'created', bookmarkId: 'b', nextStep: null } });
  });
  await page.getByRole('button', { name: 'Save to Karakeep' }).click();
  await expect(page.getByText(/Could not confirm Karakeep status/)).toBeVisible();
  await expect(page.getByText('Saving to Karakeep…')).toBeVisible();
  await page.context().setOffline(true);
  await expect(page.getByText(/Could not confirm Karakeep status/)).toBeVisible();
  await page.context().setOffline(false);
  await expect(page.getByText('Saved to Karakeep.')).toBeVisible();
});
