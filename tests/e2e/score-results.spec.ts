import { expect, test } from '@playwright/test';

const id = '00000000-0000-4000-8000-000000000001';
const article = { id, title: 'Example', sourceId: null, url: null, author: null, publishedAt: null, importedAt: '2026-01-01T00:00:00Z', kind: 'article', isRead: false, mailState: 'not_selected', scoreValue: null };
const result = { scoreTargetId: id, name: 'Signal', active: false, deleted: true, value: 42, calculatedAt: '2026-01-01T00:00:00Z', contentRevision: 1, assignmentRevision: 2, stale: true, condensed: true, limited: true, latestTask: { generation: 3, state: 'failed', errorCode: 'configuration_required' } };

test('reader displays saved results independently of reevaluation and never submits work', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') { writes++; return route.abort(); }
    if (path === '/api/v1/articles') return route.fulfill({ json: { items: [article], nextCursor: null } });
    if (path === `/api/v1/articles/${id}`) return route.fulfill({ json: article });
    if (path === `/api/v1/articles/${id}/scores`) return route.fulfill({ json: { items: [result, { ...result, scoreTargetId: 'other', name: 'No score', active: true, deleted: false, value: null, calculatedAt: null, contentRevision: null, assignmentRevision: null, stale: null, condensed: null, limited: null, latestTask: null }, { ...result, scoreTargetId: 'current', name: 'Current score', active: true, deleted: false, stale: false, condensed: false, limited: false, latestTask: { generation: 4, state: 'paused_budget', errorCode: null } }] } });
    if (path.endsWith('/summary')) return route.fulfill({ json: { status: 'missing' } });
    if (path.endsWith('/catalog')) return route.fulfill({ json: { category: { id, label: 'Fallback', archivedAt: null }, tags: [], assignmentRevision: 0 } });
    if (path.endsWith('/categories') || path.endsWith('/tags') || path.endsWith('/scores')) return route.fulfill({ json: { items: [] } });
    return route.abort();
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Example/ }).click();
  const region = page.getByRole('region', { name: 'Score results' });
  await expect(region.getByText('Previous result (stale): 42')).toBeVisible();
  await expect(region.getByText('Current result: 42')).toBeVisible();
  await expect(region.getByText('No result.')).toBeVisible();
  await expect(region.getByText('Condensed', { exact: true })).toBeVisible();
  await expect(region.getByText('Limited', { exact: true })).toBeVisible();
  await expect(region.getByText(/Definition: Deleted/)).toBeVisible();
  await expect(region.getByText(/State: failed.*configuration_required/)).toBeVisible();
  await expect(region.getByText(/State: paused_budget/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Score reevaluation' }).getByRole('button', { name: 'Reevaluate scores' })).toBeVisible();
  expect(writes).toBe(0);
});
