import { test, expect, type Page } from '@playwright/test';

const id = '00000000-0000-4000-8000-000000000001';
const source = '00000000-0000-4000-8000-000000000002';
const article = { id, sourceId: source, title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', author: 'Author', publishedAt: '2026-01-01T00:00:00Z', importedAt: '2026-01-01T00:00:00Z', kind: 'article', isRead: false, mailState: 'not_selected' };
async function mockApi(page: Page) {
  let read = false;
  const queries: string[] = [];
  const writes: string[] = [];
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/events')) return route.abort();
    if (url.pathname.endsWith('/summary')) return route.fulfill({ json: { status: 'missing' } });
    if (url.pathname.endsWith('/catalog')) return route.fulfill({ json: { category: { id, label: 'Fallback', archivedAt: null }, tags: [], assignmentRevision: 0 } });
    if (url.pathname.endsWith('/categories')) return route.fulfill({ json: { items: [{ id, label: 'Fallback', archivedAt: null }] } });
    if (url.pathname.endsWith('/tags')) return route.fulfill({ json: { items: [] } });
    if (route.request().method() === 'PATCH') { writes.push(route.request().postData() || ''); read = Boolean(route.request().postDataJSON().isRead); return route.fulfill({ json: { ...article, isRead: read } }); }
    if (url.pathname.endsWith('/articles')) { queries.push(url.search); return route.fulfill({ json: { items: [{ ...article, isRead: read }], nextCursor: url.searchParams.has('cursor') ? null : 'next-page' } }); }
    if (url.pathname.endsWith(id)) return route.fulfill({ json: { ...article, isRead: read } });
    if (url.pathname.endsWith('/pipeline/runs')) return route.fulfill({ status: 503, json: { error: { message: 'Import unavailable' } } });
    return route.abort();
  });
  return { queries, writes };
}

test('saved summary shows current, missing and outdated states without generation controls', async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => {
    class TestEventSource {
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      constructor() { window.addEventListener('summary-refresh', () => this.onmessage?.()); }
      close() {}
    }
    window.EventSource = TestEventSource as unknown as typeof EventSource;
  });
  let status: 'current' | 'missing' | 'outdated' | 'limited' = 'current';
  await page.route('**/api/v1/articles/*/summary', route => route.fulfill({ json: status === 'missing' ? { status } : { status, text: 'Saved summary text', contentRevision: 1, limitation: status === 'limited' ? 'Fallback source' : null, completedAt: '2026-01-02T03:04:05.000Z' } }));
  await page.goto('/');
  await page.getByRole('button', { name: /Untitled|img src/ }).click();
  const summary = page.getByRole('region', { name: 'Summary' });
  await expect(summary.getByText('Status: Current')).toBeVisible();
  await expect(summary.getByText('Saved summary text')).toBeVisible();
  await expect(summary.getByText(/Content revision: 1/)).toBeVisible();
  for (const [next, expected] of [['missing', 'No saved summary.'], ['outdated', 'Status: Outdated (content has changed)'], ['limited', 'Status: Limited']] as const) {
    status = next;
    await page.evaluate(() => window.dispatchEvent(new Event('summary-refresh')));
    await expect(summary.getByText(expected, { exact: true })).toBeVisible();
  }
  await expect(summary.getByText('Limitation: Fallback source')).toBeVisible();
  await expect(summary.getByRole('button')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(summary.getByText('Summary available online only.')).toBeVisible();
  await expect(summary.getByText('Saved summary text')).toHaveCount(0);
});

test('deleted external score recovers once after SSE invalidation and reconnect', async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => {
    class TestEventSource {
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      constructor() {
        window.addEventListener('test-sse-message', () => this.onmessage?.());
        window.addEventListener('test-sse-open', () => this.onopen?.());
      }
      close() {}
    }
    window.EventSource = TestEventSource as unknown as typeof EventSource;
  });
  let deleted = false;
  let catalogLoads = 0;
  let failedRequests = 0;
  const queries: URLSearchParams[] = [];
  await page.route('**/api/v1/scores', route => {
    catalogLoads++;
    return route.fulfill({ json: { items: [{ id, name: 'Signal', active: !deleted, deletedAt: deleted ? '2026-01-01' : null }] } });
  });
  await page.route('**/api/v1/articles?**', route => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    if (query.get('sort') === 'score' && deleted) { failedRequests++; return route.fulfill({ status: 400, json: { error: { message: 'Score is not active' } } }); }
    return route.fulfill({ json: { items: [article], nextCursor: query.has('cursor') ? null : 'next-page' } });
  });
  await page.goto('/');
  await page.getByLabel('Sort by').selectOption('score');
  await page.getByLabel(/^Score/).selectOption(id);
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect.poll(() => queries.some(q => q.get('sort') === 'score')).toBe(true);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  await expect.poll(() => queries.some(q => q.get('cursor') === 'next-page')).toBe(true);
  const scoreBeforeMessage = queries.filter(q => q.get('sort') === 'score').length;
  await page.evaluate(() => window.dispatchEvent(new Event('test-sse-message')));
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  await expect.poll(() => queries.filter(q => q.get('sort') === 'score').length).toBe(scoreBeforeMessage + 1);
  expect(catalogLoads).toBe(1);
  const dateBeforeDeletion = queries.filter(q => q.get('sort') === 'date').length;
  deleted = true;
  await page.evaluate(() => window.dispatchEvent(new Event('test-sse-open')));
  await expect(page.getByText('Selected score is no longer active. Showing articles sorted by date.')).toBeVisible();
  await expect(page.getByLabel('Sort by')).toHaveValue('date');
  await expect.poll(() => queries.filter(q => q.get('sort') === 'date').length).toBe(dateBeforeDeletion + 1);
  const last = queries.at(-1)!;
  expect(last.get('sort')).toBe('date');
  expect(last.has('scoreId')).toBe(false);
  expect(last.has('cursor')).toBe(false);
  await page.getByLabel('Sort by').selectOption('score');
  await expect(page.getByRole('option', { name: 'Signal' })).toHaveCount(0);
  const failedCount = queries.filter(q => q.get('sort') === 'score').length;
  expect(catalogLoads).toBe(2);
  expect(failedRequests).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('test-sse-message')));
  await expect.poll(() => queries.filter(q => q.get('sort') === 'date').length).toBe(dateBeforeDeletion + 2);
  expect(queries.filter(q => q.get('sort') === 'score')).toHaveLength(failedCount);
  expect(failedRequests).toBe(1);
  expect(catalogLoads).toBe(2);
});

test('score cursor 400 retries first page and exposes a repeated 400', async ({ page }) => {
  await mockApi(page);
  let scoreRequests = 0;
  let catalogLoads = 0;
  await page.route('**/api/v1/scores', route => { catalogLoads++; return route.fulfill({ json: { items: [{ id, name: 'Signal', active: true, deletedAt: null }] } }); });
  await page.route('**/api/v1/articles?**', route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('sort') === 'score' && ++scoreRequests !== 1 && scoreRequests !== 3) return route.fulfill({ status: 400, json: { error: { message: 'Invalid cursor' } } });
    return route.fulfill({ json: { items: [article], nextCursor: 'expired' } });
  });
  await page.goto('/');
  await page.getByLabel('Sort by').selectOption('score');
  await page.getByLabel(/^Score/).selectOption(id);
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect.poll(() => scoreRequests).toBe(1);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('The score page expired. Showing the first page.')).toBeVisible();
  await expect.poll(() => scoreRequests).toBe(3);
  await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('alert')).toHaveText('Could not load score-sorted articles: Invalid cursor');
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  expect(scoreRequests).toBe(5);
  expect(catalogLoads).toBe(4);
  await expect(page.getByLabel('Sort by')).toHaveValue('score');
});

test('score recovery reports an unavailable catalog without retrying the article request', async ({ page }) => {
  await mockApi(page);
  let catalogLoads = 0;
  let scoreRequests = 0;
  await page.route('**/api/v1/scores', route => {
    if (++catalogLoads > 1) return route.fulfill({ status: 503, json: { error: { message: 'Catalog unavailable' } } });
    return route.fulfill({ json: { items: [{ id, name: 'Signal', active: true, deletedAt: null }] } });
  });
  await page.route('**/api/v1/articles?**', route => {
    if (new URL(route.request().url()).searchParams.get('sort') === 'score') {
      scoreRequests++;
      return route.fulfill({ status: 400, json: { error: { message: 'Invalid score' } } });
    }
    return route.fulfill({ json: { items: [article], nextCursor: null } });
  });
  await page.goto('/');
  await page.getByLabel('Sort by').selectOption('score');
  await page.getByLabel(/^Score/).selectOption(id);
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByRole('alert')).toHaveText('Could not refresh scores after the article request failed: Catalog unavailable');
  await expect(page.getByText('Scores unavailable. Reopen the reader or reconnect to retry.')).toBeVisible();
  expect(scoreRequests).toBe(1);
  expect(catalogLoads).toBe(2);
});

test('catalog ignores an initial list response released after a create refresh', async ({ page }) => {
  await mockApi(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let initialStarted!: () => void;
  const started = new Promise<void>(resolve => { initialStarted = resolve; });
  let listCount = 0;
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (response.headers.get('x-test-stale') === 'yes') {
        const json = response.json.bind(response);
        response.json = async () => { const value: unknown = await json(); setTimeout(() => { document.documentElement.dataset.staleConsumed = 'yes'; }, 0); return value; };
      }
      return response;
    };
  });
  const item = { id, label: 'Fresh category', archivedAt: null };
  await page.route('**/api/v1/categories', async route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 201, json: item });
    if (++listCount === 1) { initialStarted(); await gate; return route.fulfill({ headers: { 'x-test-stale': 'yes' }, json: { items: [] } }); }
    return route.fulfill({ json: { items: [item] } });
  });
  await page.route('**/api/v1/tags', route => route.fulfill({ json: { items: [] } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Catalog settings' }).click();
  await started;
  await page.getByLabel('New category').fill(item.label);
  await page.getByRole('button', { name: 'Create category' }).click();
  await expect(page.getByLabel('Rename Fresh category')).toBeVisible();
  await expect(page.getByText('Catalog saved.')).toBeVisible();
  const staleResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/categories') && response.request().method() === 'GET' && response.status() === 200);
  release();
  await staleResponse;
  await expect(page.locator('html')).toHaveAttribute('data-stale-consumed', 'yes');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByLabel('Rename Fresh category')).toBeVisible();
  await expect(page.getByText('Catalog saved.')).toBeVisible();
});

test('article catalog preserves drafts through unrelated SSE and resets after a confirmed change', async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => {
    class TestEventSource {
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() { window.addEventListener('test-pipeline-changed', () => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'pipeline.changed', entityId: 'runs' }) }))); }
      close() {}
    }
    window.EventSource = TestEventSource as unknown as typeof EventSource;
  });
  const fallback = { id, label: 'Fallback', archivedAt: null };
  const category = { id: source, label: 'Chosen category', archivedAt: null };
  const tag = { id: source, label: 'Chosen tag', archivedAt: null };
  const secondId = '00000000-0000-4000-8000-000000000003';
  const secondArticle = { ...article, id: secondId, title: 'Second article' };
  let canonical = fallback;
  let categoryLabel = category.label;
  let available = true;
  const writes: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/v1/') && request.method() !== 'GET') writes.push(request.method()); });
  await page.route('**/api/v1/articles?**', route => route.fulfill({ json: { items: [article, secondArticle], nextCursor: null } }));
  await page.route(`**/api/v1/articles/${secondId}`, route => route.fulfill({ json: secondArticle }));
  await page.route(`**/api/v1/articles/${id}/catalog`, route => route.fulfill({ json: { category: canonical, tags: [], assignmentRevision: 0 } }));
  await page.route(`**/api/v1/articles/${secondId}/catalog`, route => route.fulfill({ json: { category: fallback, tags: [], assignmentRevision: 0 } }));
  await page.route('**/api/v1/categories', route => route.fulfill({ json: { items: [fallback, ...(available ? [{ ...category, label: categoryLabel }] : [])] } }));
  await page.route('**/api/v1/tags', route => route.fulfill({ json: { items: available ? [tag] : [] } }));
  await page.route(`**/api/v1/articles/${id}/category`, route => { canonical = category; return route.fulfill({ json: {} }); });
  await page.goto('/');
  await page.getByRole('button', { name: /<img/ }).click();
  const editor = page.getByRole('region', { name: 'Article catalog' });
  await editor.getByLabel('Category').selectOption(category.id);
  await editor.getByLabel('Add tag').selectOption(tag.id);
  categoryLabel = 'Refreshed category';
  await page.evaluate(() => window.dispatchEvent(new Event('test-pipeline-changed')));
  await expect(editor.getByRole('option', { name: categoryLabel })).toBeAttached();
  await expect(editor.getByLabel('Category')).toHaveValue(category.id);
  await expect(editor.getByLabel('Add tag')).toHaveValue(tag.id);
  expect(writes).toEqual([]);
  available = false;
  await page.evaluate(() => window.dispatchEvent(new Event('test-pipeline-changed')));
  await expect(editor.getByRole('option', { name: 'Chosen tag (unavailable)' })).toBeAttached();
  await expect(editor.getByRole('option', { name: 'Chosen category (unavailable)' })).toBeAttached();
  await expect(editor.getByRole('button', { name: 'Save category' })).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Add tag', exact: true })).toBeDisabled();
  available = true;
  await page.evaluate(() => window.dispatchEvent(new Event('test-pipeline-changed')));
  await expect(editor.getByRole('option', { name: categoryLabel })).toBeAttached();
  await expect(editor.getByLabel('Category')).toHaveValue(category.id);
  await expect(editor.getByLabel('Add tag')).toHaveValue(tag.id);
  expect(writes).toEqual([]);
  await editor.getByRole('button', { name: 'Save category' }).click();
  await expect(editor.getByRole('status')).toHaveText('Article catalog saved.');
  await expect(editor.getByLabel('Category')).toHaveValue(category.id);
  await expect(editor.getByLabel('Add tag')).toHaveValue('');
  expect(writes).toEqual(['PATCH']);
  canonical = fallback;
  categoryLabel = 'Refreshed again';
  await page.evaluate(() => window.dispatchEvent(new Event('test-pipeline-changed')));
  await expect(editor.getByRole('option', { name: categoryLabel })).toBeAttached();
  await expect(editor.getByLabel('Category')).toHaveValue(fallback.id);
  await editor.getByLabel('Category').selectOption(category.id);
  await editor.getByLabel('Add tag').selectOption(tag.id);
  await page.getByRole('button', { name: /Second article/ }).click();
  await expect(page.getByRole('heading', { name: 'Second article' })).toBeVisible();
  await expect(editor.getByLabel('Category')).toHaveValue(fallback.id);
  await expect(editor.getByLabel('Add tag')).toHaveValue('');
  expect(writes).toEqual(['PATCH']);
});

test('article catalog controls fit long available labels on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await mockApi(page);
  const label = 'W'.repeat(200);
  await page.route('**/api/v1/categories', route => route.fulfill({ json: { items: [{ id, label: 'Fallback', archivedAt: null }, { id: source, label, archivedAt: null }] } }));
  await page.route('**/api/v1/tags', route => route.fulfill({ json: { items: [{ id: source, label, archivedAt: null }] } }));
  await page.goto('/');
  await page.getByRole('button', { name: /<img/ }).click();
  const editor = page.getByRole('region', { name: 'Article catalog' });
  await expect(editor.getByLabel('Category').locator('option')).toHaveCount(2);
  await expect(editor.getByLabel('Add tag').locator('option')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await editor.getByLabel('Category').selectOption(source);
  await editor.getByLabel('Add tag').selectOption(source);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});

test('article catalog reports failed changes and disables offline edits', async ({ page, context }) => {
  await mockApi(page);
  const activeTag = { id: source, label: 'Topic', archivedAt: null };
  let attempts = 0;
  await page.route('**/api/v1/tags', route => route.fulfill({ json: { items: [activeTag] } }));
  await page.route(`**/api/v1/articles/${id}/tags/${source}`, route => { attempts++; return route.fulfill({ status: 409, json: { error: { message: 'Archived' } } }); });
  await page.goto('/');
  await page.getByRole('button', { name: /<img/ }).click();
  const editor = page.getByRole('region', { name: 'Article catalog' });
  await editor.getByLabel('Add tag').selectOption(source);
  await editor.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(editor.getByRole('alert')).toHaveText('Could not confirm catalog change. Reload to check.');
  await expect(editor.getByLabel('Add tag')).toHaveValue(source);
  expect(attempts).toBe(1);
  await context.setOffline(true);
  await expect(editor.getByText('Offline. Catalog changes are unavailable.')).toBeVisible();
  await expect(editor.getByLabel('Category')).toBeDisabled();
  await expect(editor.getByLabel('Add tag')).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Add tag', exact: true })).toBeDisabled();
  expect(attempts).toBe(1);
  await context.setOffline(false);
});

test('filters, paging, safe detail and confirmed read mutation', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /<img/ }).click();
  await expect(page.getByRole('heading', { name: article.title })).toBeVisible();
  await expect(page.locator('img')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Open original/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mark read' }).click();
  await expect(page.getByRole('button', { name: 'Mark unread' })).toBeVisible();
  expect(api.writes).toEqual(['{"isRead":true}']);
  await page.getByLabel('Title search').fill('needle');
  await page.getByLabel('Source ID').fill(source);
  await page.getByLabel('Status').selectOption('all');
  await page.getByLabel('Kind').selectOption('video');
  await page.getByLabel('Sort by').selectOption('title');
  await page.getByLabel('Order').selectOption('asc');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect.poll(() => api.queries.some(q => q.includes('title=needle') && q.includes('kind=video') && q.includes(`source=${source}`) && q.includes('sort=title') && q.includes('direction=asc') && q.includes('read=all'))).toBe(true);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect.poll(() => api.queries.some(q => q.includes('cursor=next-page'))).toBe(true);
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Import now' }).click();
  await expect(page.getByRole('alert')).toContainText('Import unavailable');
});

test('failed mail selection remains visible after reload until a successful retry', async ({ page }) => {
  await mockApi(page);
  let attempts = 0;
  let selected = false;
  let listLoads = 0;
  await page.route('**/api/v1/articles?**', route => {
    listLoads++;
    return route.fulfill({ json: { items: [{ ...article, title: `${article.title} (list ${listLoads})` }], nextCursor: null } });
  });
  await page.route('**/api/v1/articles/' + id + '/mail-selection', async route => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: { message: 'Mail unavailable' } } });
    selected = true;
    return route.fulfill({ json: { ...article, mailState: 'selected' } });
  });
  await page.route('**/api/v1/articles/' + id, route => route.fulfill({ json: { ...article, mailState: selected ? 'selected' : 'not_selected' } }));
  await page.goto('/');
  await page.getByRole('button', { name: /<img/ }).click();
  await expect(page.getByRole('button', { name: 'Select for mail' })).toBeVisible();
  const listsBefore = listLoads;
  await page.getByRole('button', { name: 'Select for mail' }).click();
  await expect(page.getByRole('button', { name: `(list ${listsBefore + 1})` })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Could not confirm mail selection');
  await expect(page.getByRole('alert')).toContainText('Mail unavailable');
  await expect(page.getByRole('button', { name: 'Select for mail' })).toBeVisible();
  await page.getByRole('button', { name: 'Select for mail' }).click();
  await expect(page.getByRole('button', { name: 'Remove from mail queue' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(attempts).toBe(2);
});

test('sent mail is displayed without a reset control', async ({ page }) => {
  await mockApi(page);
  let writes = 0;
  await page.route('**/api/v1/articles/' + id + '/mail-selection', route => { writes++; return route.abort(); });
  await page.route('**/api/v1/articles/' + id, route => route.fulfill({ json: { ...article, mailState: 'sent' } }));
  await page.goto('/');
  await page.getByRole('button', { name: /<img/ }).click();
  await expect(page.getByText('Mail sent', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /mail/i })).toHaveCount(0);
  expect(writes).toBe(0);
});

test('mobile navigation and offline writes are disabled', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /<img/ }).click();
  await expect(page.getByRole('button', { name: '← Back to articles' })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: 'Offline. Previously displayed articles' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark read' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Select for mail' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Import now' })).toBeDisabled();
  expect(api.writes).toHaveLength(0);
  await page.getByRole('button', { name: '← Back to articles' }).click();
  await expect(page.getByRole('button', { name: /<img/ })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toHaveCount(0);
  expect(api.writes).toHaveLength(0);
});

test('service worker caches only shell assets, not API responses', async ({ page, context }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: /<img/ })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.evaluate(() => fetch('/api/v1/articles?read=all'));
  const keys = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await caches.open(name)).keys()))).flat().map(request => new URL(request.url).pathname));
  expect(keys).toContain('/index.html');
  expect(keys.some(key => key.startsWith('/api/') || key.startsWith('/events'))).toBe(false);
  expect(keys.every(key => key === '/index.html' || key === '/icon.svg' || key === '/icon-192.png' || key === '/icon-512.png' || key === '/manifest.webmanifest' || key.startsWith('/assets/'))).toBe(true);
  const storage = await page.evaluate(async () => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    databases: await indexedDB.databases(),
  }));
  expect(storage.local).toEqual([]);
  expect(storage.session).toEqual([]);
  // Workbox may create its own metadata database; no application database is expected.
  expect(storage.databases.every(database => database.name?.startsWith('workbox-'))).toBe(true);
  const indexedValues = await page.evaluate(async names => Promise.all(names.map(name => new Promise<unknown[]>((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const stores = Array.from(db.objectStoreNames);
      if (!stores.length) { db.close(); resolve([]); return; }
      const tx = db.transaction(stores, 'readonly');
      const values: unknown[] = [];
      for (const store of stores) { const request = tx.objectStore(store).getAll(); request.onsuccess = () => values.push(...request.result); }
      tx.oncomplete = () => { db.close(); resolve(values); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }))), storage.databases.map(database => database.name!));
  expect(JSON.stringify(indexedValues)).not.toContain(article.title);
  expect(JSON.stringify(indexedValues)).not.toContain(id);
  await page.unroute('**/api/v1/**');
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible();
  expect(await page.evaluate(() => fetch('/api/v1/articles?read=all').then(() => true, () => false))).toBe(false);
});

test('failed write is not optimistic and import progress is visible', async ({ page }) => {
  const api = await mockApi(page);
  await page.route('**/api/v1/articles/' + id, async route => {
    if (route.request().method() === 'PATCH') return route.fulfill({ status: 503, json: { error: { message: 'Unavailable' } } });
    return route.fulfill({ json: article });
  });
  await page.route('**/api/v1/pipeline/runs**', async route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 202, json: { runId: id, state: 'running', reused: false } });
    return route.fulfill({ json: { id, status: 'running', phase: 'scan', fetchedCount: 4, confirmedCount: 2, pendingCount: 2, errorCode: null } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /<img/ }).click();
  await page.getByRole('button', { name: 'Mark read' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not confirm read state');
  await expect(page.getByRole('button', { name: 'Mark read' })).toBeVisible();
  expect(api.writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Import now' }).click();
  await expect(page.getByText(/running · scan · fetched 4, confirmed 2, pending 2/)).toBeVisible();
});
