import { test, expect } from '@playwright/test';

const id = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';
const item = { id, sourceId: null, title: 'Article', url: 'https://example.com/', author: null, publishedAt: null, importedAt: '2026-01-01T00:00:00Z', kind: 'article', isRead: false, mailState: 'not_selected' };

test('failed start can be checked again; polling continues away from the article', async ({ page }) => {
  let posts = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.setViewportSize({ width: 375, height: 700 });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/events')) return route.abort();
    if (path === '/api/v1/karakeep') return route.fulfill({ json: { available: true } });
    if (path === '/api/v1/articles') return route.fulfill({ json: { items: [item], nextCursor: null } });
    if (path === `/api/v1/articles/${id}`) return route.fulfill({ json: item });
    if (path === `/api/v1/articles/${id}/karakeep`) {
      if (++posts === 1) return route.fulfill({ status: 500, json: { error: { message: 'failure' } } });
      return route.fulfill({ status: 202, json: { taskId, state: 'running', reused: true } });
    }
    if (path === `/api/v1/processing-tasks/${taskId}`) { await gate; return route.fulfill({ json: { id: taskId, articleId: id, action: 'karakeep', state: 'succeeded', outcome: 'existing', bookmarkId: 'b', nextStep: null } }); }
    if (path.endsWith('/catalog')) return route.fulfill({ json: { category: { id, label: 'Fallback', archivedAt: null }, tags: [], assignmentRevision: 0 } });
    if (path.endsWith('/scores') || path.endsWith('/categories') || path.endsWith('/tags')) return route.fulfill({ json: { items: [] } });
    return route.abort();
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Article', exact: false }).click();
  await page.getByRole('button', { name: 'Save to Karakeep' }).click();
  await expect(page.getByText(/Could not confirm Karakeep request/)).toBeVisible();
  await page.getByRole('button', { name: 'Save to Karakeep' }).click();
  await expect(page.getByText('Saving to Karakeep…')).toBeVisible();
  await page.getByRole('button', { name: 'Back to articles' }).click();
  const response = page.waitForResponse(r => r.url().endsWith(`/processing-tasks/${taskId}`));
  release(); await response;
  await page.getByRole('button', { name: 'Article', exact: false }).click();
  await expect(page.getByText('Already exists in Karakeep.')).toBeVisible();
  expect(posts).toBe(2);
});

test('shows an auth pause and follows recovery without another save', async ({ page }) => {
  let polls = 0; let posts = 0;
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/events')) return route.abort();
    if (path === '/api/v1/karakeep') return route.fulfill({ json: { available: true } });
    if (path === '/api/v1/articles') return route.fulfill({ json: { items: [item], nextCursor: null } });
    if (path === `/api/v1/articles/${id}`) return route.fulfill({ json: item });
    if (path === `/api/v1/articles/${id}/karakeep`) { posts++; return route.fulfill({ status: 202, json: { taskId } }); }
    if (path === `/api/v1/processing-tasks/${taskId}`) return route.fulfill({ json: ++polls === 1
      ? { id: taskId, articleId: id, state: 'paused_auth', outcome: null, nextStep: 'Repair credentials and restart.' }
      : { id: taskId, articleId: id, state: 'succeeded', outcome: 'created', nextStep: null } });
    if (path.endsWith('/catalog')) return route.fulfill({ json: { category: { id, label: 'Fallback', archivedAt: null }, tags: [], assignmentRevision: 0 } });
    if (path.endsWith('/scores') || path.endsWith('/categories') || path.endsWith('/tags')) return route.fulfill({ json: { items: [] } });
    return route.abort();
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Article', exact: false }).click();
  await page.getByRole('button', { name: 'Save to Karakeep' }).click();
  await expect(page.getByText('Karakeep authentication paused. Repair credentials and restart.')).toBeVisible();
  await expect(page.getByText('Saved to Karakeep.')).toBeVisible({ timeout: 10000 });
  expect(posts).toBe(1);
});

test('server rejection disables an unsuitable URL without success', async ({ page }) => {
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/events')) return route.abort();
    if (path === '/api/v1/karakeep') return route.fulfill({ json: { available: true } });
    if (path === '/api/v1/articles') return route.fulfill({ json: { items: [item], nextCursor: null } });
    if (path === `/api/v1/articles/${id}`) return route.fulfill({ json: item });
    if (path === `/api/v1/articles/${id}/karakeep`) return route.fulfill({ status: 422, json: { error: { message: 'invalid' } } });
    if (path.endsWith('/catalog')) return route.fulfill({ json: { category: { id, label: 'Fallback', archivedAt: null }, tags: [], assignmentRevision: 0 } });
    if (path.endsWith('/scores') || path.endsWith('/categories') || path.endsWith('/tags')) return route.fulfill({ json: { items: [] } });
    return route.abort();
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Article', exact: false }).click();
  await page.getByRole('button', { name: 'Save to Karakeep' }).click();
  await expect(page.getByText('Article has no suitable original URL.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save to Karakeep' })).toHaveCount(0);
  await expect(page.getByText('Saved to Karakeep.')).toHaveCount(0);
});
