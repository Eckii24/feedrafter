import { test, expect, type Page } from '@playwright/test';

const id = '00000000-0000-4000-8000-000000000001';
const article = { id, sourceId: null, title: 'A thoughtful article about the web', url: 'https://example.com/article', author: 'A Writer', publishedAt: '2026-01-01T00:00:00Z', importedAt: '2026-01-01T00:00:00Z', kind: 'article', isRead: false, mailState: 'not_selected', scoreValue: null };
async function mockApi(page: Page) {
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/events')) return route.abort();
    if (path.endsWith('/articles')) return route.fulfill({ json: { items: [article], nextCursor: null } });
    if (path.endsWith('/summary')) return route.fulfill({ json: { status: 'missing' } });
    if (path.endsWith('/catalog')) return route.fulfill({ json: { category: { id, label: 'Uncategorized', archivedAt: null }, tags: [], assignmentRevision: 0 } });
    if (path.endsWith('/categories')) return route.fulfill({ json: { items: [{ id, label: 'Uncategorized', archivedAt: null }] } });
    if (path.endsWith('/tags') || path.endsWith('/scores')) return route.fulfill({ json: { items: [] } });
    if (path.endsWith('/karakeep')) return route.fulfill({ json: { available: false } });
    if (path.endsWith(id)) return route.fulfill({ json: article });
    return route.abort();
  });
}

for (const width of [320, 390, 768, 1440]) {
  test(`reader stays within ${width}px and presents articles before advanced filters`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await mockApi(page);
    await page.goto('/');
    await page.getByText('Search & filters').click();
    await expect(page.getByLabel('Title search')).toBeVisible();
    await page.getByText('Search & filters').click();
    const item = page.getByRole('button', { name: /A thoughtful article/ });
    await expect(item).toBeVisible();
    expect(await item.evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(470);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await item.click();
    await expect(page.getByRole('heading', { name: article.title })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width <= 700) {
      await page.getByRole('button', { name: '← Back to articles' }).click();
      await expect(item).toBeVisible();
    }
  });
}


test('automatic preparation history survives reload and cannot be retried', async ({ page }) => {
  await mockApi(page);
  await page.route(`**/api/v1/articles/${id}/processing`, route => route.fulfill({ json: { eligibility: 'already_started', tasks: [{ id: 'prepare', action: 'prepare', generation: 1, state: 'failed', errorCode: 'content_unusable', scoreTargetId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', endedAt: null }] } }));
  await page.goto('/');
  await page.getByRole('button', { name: /A thoughtful article/ }).click();
  await expect(page.getByText(/prepare: failed.*content_unusable/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Process article', exact: true })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: /A thoughtful article/ }).click();
  await expect(page.getByText(/prepare: failed.*content_unusable/i)).toBeVisible();
});

test('recovers from a transient status failure on mobile and after reload', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await mockApi(page);
  let reads = 0;
  await page.route(`**/api/v1/articles/${id}/processing`, route => {
    reads++;
    return reads === 1 ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: { eligibility: 'already_started', tasks: [{ id: 'prepare', action: 'prepare', generation: 1, state: 'failed', errorCode: 'content_unusable', scoreTargetId: null }] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /A thoughtful article/ }).click();
  await expect(page.getByText('Processing status could not be confirmed.')).toBeVisible();
  await expect(page.getByText(/prepare: failed.*content_unusable/)).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('Processing status could not be confirmed.')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.reload();
  await page.getByRole('button', { name: /A thoughtful article/ }).click();
  await expect(page.getByText(/prepare: failed.*content_unusable/)).toBeVisible();
});

test('explains excerpt-based classification without claiming a specific result used excerpts', async ({ page }) => {
  await mockApi(page);
  await page.route(`**/api/v1/articles/${id}/processing`, route => route.fulfill({ json: { eligibility: 'already_started', tasks: [{ id: 'category', action: 'category', generation: 1, state: 'succeeded', errorCode: null, scoreTargetId: null }] } }));
  await page.goto('/');
  await page.getByRole('button', { name: /A thoughtful article/ }).click();
  await expect(page.getByText(/long content may be classified and tagged using excerpts/i)).toBeVisible();
  await expect(page.getByText(/category: succeeded/i)).toBeVisible();
});

test('explains video eligibility when its URL is missing', async ({ page }) => {
  await mockApi(page);
  await page.route(`**/api/v1/articles/${id}`, route => route.fulfill({ json: { ...article, kind: 'video', url: null } }));
  await page.route(`**/api/v1/articles/${id}/processing`, route => route.fulfill({ json: { eligibility: 'ineligible', tasks: [] } }));
  await page.goto('/');
  await page.getByRole('button', { name: /A thoughtful article/ }).click();
  await expect(page.getByText('First-time processing requires an article or video with a URL.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Process article', exact: true })).toBeDisabled();
});

test('explicit processing reports admission and authoritative task failure', async ({ page }) => {
  await mockApi(page);
  let writes = 0;
  await page.route(`**/api/v1/articles/${id}/processing`, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: writes ? { eligibility: 'already_started', tasks: [
      { id: 'category', action: 'category', generation: 1, state: 'failed', errorCode: 'configuration_required', scoreTargetId: null },
      { id: 'tags', action: 'tags', generation: 1, state: 'waiting_dependency', errorCode: null, scoreTargetId: null },
    ] } : { eligibility: 'eligible', tasks: [] } });
    writes++;
    expect(route.request().postDataJSON()).toEqual({});
    return route.fulfill({ json: { kind: 'admitted', prepareTaskId: 'prepare', categoryTaskId: 'category', tagsTaskId: 'tags', scoreTaskIds: [] } });
  });
  await page.route('**/api/v1/processing-tasks/*', route => {
    const taskId = new URL(route.request().url()).pathname.split('/').at(-1);
    return route.fulfill({ json: { id: taskId, articleId: id, action: taskId, state: taskId === 'category' ? 'failed' : 'waiting_dependency', errorCode: taskId === 'category' ? 'configuration_required' : null } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /A thoughtful article/ }).click();
  await page.getByRole('button', { name: 'Process article', exact: true }).click();
  await expect(page.getByText(/category: failed.*configuration_required/i)).toBeVisible();
  await expect(page.getByText(/tags: waiting_dependency/i)).toBeVisible();
  expect(writes).toBe(1);
});


test('processing unavailable is shown as unconfirmed rather than successful', async ({ page }) => {
  await mockApi(page);
  await page.route(`**/api/v1/articles/${id}/processing`, route => route.request().method() === 'GET'
    ? route.fulfill({ json: { eligibility: 'eligible', tasks: [] } })
    : route.fulfill({ status: 503, json: { error: { message: 'Article processing unavailable' } } }));
  await page.goto('/');
  await page.getByRole('button', { name: /A thoughtful article/ }).click();
  await page.getByRole('button', { name: 'Process article', exact: true }).click();
  await expect(page.getByText(/Could not confirm processing request/)).toBeVisible();
  await expect(page.getByText(/Processing admitted/)).toHaveCount(0);
});


test('explicit retry shows disclosure, sends failed task once and refreshes history', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await mockApi(page);
  const taskId = '00000000-0000-4000-8000-000000000002';
  let writes = 0;
  await page.route(`**/api/v1/articles/${id}/processing`, route => route.fulfill({ json: { eligibility: 'already_started', retryFailedTaskId: writes ? null : taskId, tasks: [{ id: taskId, action: 'prepare', generation: 1, state: 'failed', errorCode: 'content_unusable', scoreTargetId: null }, ...(writes ? [{ id: 'new', action: 'prepare', generation: 2, state: 'failed', errorCode: 'content_unusable', scoreTargetId: null }] : [])] } }));
  await page.route(`**/api/v1/articles/${id}/processing/retry`, async route => {
    writes++; expect(route.request().postDataJSON()).toEqual({ failedTaskId: taskId });
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.fulfill({ json: { kind: 'failed', prepareTaskId: taskId } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /A thoughtful article/ }).click();
  await expect(page.getByText(/new AI request may send/i)).toBeVisible();
  const button = page.getByRole('button', { name: 'Retry failed preparation' });
  await button.click();
  await expect(button).toBeDisabled();
  await expect(page.getByText(/generation 2/)).toBeVisible();
  expect(writes).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test('an active filter remains visible when the filter panel is collapsed', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByText('Search & filters').click();
  await page.getByLabel('Title search').fill('web');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.getByText('Search & filters').click();
  await expect(page.getByText('Search: web')).toBeVisible();
});
