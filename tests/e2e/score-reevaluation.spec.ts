import { test, expect, type Page } from '@playwright/test';

const articleId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const taskId = '00000000-0000-4000-8000-000000000003';
const targetId = '00000000-0000-4000-8000-000000000004';
const article = (id: string, title: string) => ({ id, title, sourceId: null, url: null, author: null, publishedAt: null, importedAt: '2026-01-01T00:00:00Z', kind: 'article', isRead: false, mailState: 'not_selected', scoreValue: null });
const status = (state: string, errorCode: string | null = null) => ({ id: taskId, articleId, action: 'scores', scoreTargetId: targetId, generation: 7, state, errorCode, endedAt: null });

async function setup(page: Page) {
  await page.addInitScript(() => {
    class TestEventSource {
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      constructor() { window.addEventListener('score-refresh', () => this.onmessage?.()); }
      close() {}
    }
    window.EventSource = TestEventSource as unknown as typeof EventSource;
  });
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/articles') return route.fulfill({ json: { items: [article(articleId, 'First'), article(otherId, 'Second')], nextCursor: null } });
    if (path === `/api/v1/articles/${articleId}`) return route.fulfill({ json: article(articleId, 'First') });
    if (path === `/api/v1/articles/${otherId}`) return route.fulfill({ json: article(otherId, 'Second') });
    if (path.endsWith('/summary')) return route.fulfill({ json: { status: 'missing' } });
    if (path.endsWith('/catalog')) return route.fulfill({ json: { category: { id: targetId, label: 'Fallback', archivedAt: null }, tags: [], assignmentRevision: 0 } });
    if (path.endsWith('/categories')) return route.fulfill({ json: { items: [{ id: targetId, label: 'Fallback', archivedAt: null }] } });
    if (path.endsWith('/tags') || path.endsWith('/scores')) return route.fulfill({ json: { items: [] } });
    return route.abort();
  });
}

test('reevaluation shows only authoritative status, polls, handles SSE races and clears on article change', async ({ page }) => {
  await setup(page);
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (response.url.includes('/processing-tasks/')) {
        const json = response.json.bind(response);
        response.json = async () => {
          const body = await json();
          if (body.state === 'succeeded') document.documentElement.dataset.staleStatusConsumed = 'true';
          return body;
        };
      }
      return response;
    };
  });
  let posts = 0;
  let gets = 0;
  let resolveFirst!: () => void;
  let resolvePoll!: () => void;
  const firstGate = new Promise<void>(resolve => { resolveFirst = resolve; });
  const pollGate = new Promise<void>(resolve => { resolvePoll = resolve; });
  await page.route(`**/api/v1/articles/${articleId}/reevaluations`, route => {
    posts++;
    expect(route.request().method()).toBe('POST');
    expect(route.request().postData()).toBe('{}');
    return route.fulfill({ status: 202, json: { tasks: [{ taskId, scoreTargetId: targetId, generation: 7, state: 'succeeded' }] } });
  });
  await page.route(`**/api/v1/processing-tasks/${taskId}`, async route => {
    const count = ++gets;
    if (count === 1) { await firstGate; return route.fulfill({ json: status('succeeded') }).catch(() => {}); }
    if (count === 2) return route.fulfill({ json: status('queued') });
    await pollGate;
    return route.fulfill({ json: status('needs_input', 'configuration_required') }).catch(() => {});
  });
  await page.goto('/');
  await page.getByRole('button', { name: /First/ }).click();
  const region = page.getByRole('region', { name: 'Score reevaluation' });
  await region.getByRole('button', { name: 'Reevaluate scores' }).click();
  await expect(region.getByText(/awaiting authoritative status/)).toBeVisible();
  await expect(region.getByText(/State: succeeded/)).toHaveCount(0);
  await expect.poll(() => gets).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('score-refresh')));
  await expect(region.getByText(/State: queued/)).toContainText(`Target: ${targetId} · Generation: 7`);
  resolveFirst();
  // Wait for the stale body to be consumed and React to render before allowing a poll to overwrite it.
  await expect(page.locator('html')).toHaveAttribute('data-stale-status-consumed', 'true');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect.poll(() => gets).toBeGreaterThanOrEqual(3);
  await expect(region.getByText(/State: queued/)).toBeVisible();
  await expect(region.getByText(/State: succeeded/)).toHaveCount(0);
  resolvePoll();
  await expect(region.getByText(/configuration_required/)).toContainText('Configuration required');
  expect(posts).toBe(1);
  expect(gets).toBeGreaterThanOrEqual(3);
  await page.getByRole('button', { name: /Second/ }).click();
  await expect(region.getByText(/configuration_required/)).toHaveCount(0);
  await page.getByRole('button', { name: /First/ }).click();
  await expect(region.getByText(/configuration_required/)).toHaveCount(0);
});

test('offline is disabled; lost response is ambiguous and a new request is explicit', async ({ page, context }) => {
  await setup(page);
  let posts = 0;
  await page.route(`**/api/v1/articles/${articleId}/reevaluations`, route => {
    posts++;
    return posts === 1 ? route.abort() : route.fulfill({ status: 202, json: { tasks: [] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /First/ }).click();
  const region = page.getByRole('region', { name: 'Score reevaluation' });
  const button = region.getByRole('button', { name: 'Reevaluate scores' });
  await context.setOffline(true);
  await expect(button).toBeDisabled();
  await expect(region.getByText(/Offline/)).toBeVisible();
  expect(posts).toBe(0);
  await context.setOffline(false);
  await button.click();
  await expect(region.getByRole('status')).toContainText('Tasks may have been created');
  await expect(region.getByRole('status')).toContainText('fresh generations');
  expect(posts).toBe(1);
  await button.click();
  await expect(region.getByRole('status')).toContainText('No active score definitions; no tasks were created.');
  expect(posts).toBe(2);
});

test('late admission response cannot appear after switching articles', async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let posts = 0;
  await page.route(`**/api/v1/articles/${articleId}/reevaluations`, async route => {
    posts++;
    await gate;
    await route.fulfill({ status: 202, json: { tasks: [{ taskId, scoreTargetId: targetId, generation: 7, state: 'queued' }] } }).catch(() => {});
  });
  let gets = 0;
  await page.route(`**/api/v1/processing-tasks/${taskId}`, route => { gets++; return route.fulfill({ json: status('queued') }); });
  await page.goto('/');
  await page.getByRole('button', { name: /First/ }).click();
  const region = page.getByRole('region', { name: 'Score reevaluation' });
  await region.getByRole('button', { name: 'Reevaluate scores' }).click();
  await expect.poll(() => posts).toBe(1);
  await page.getByRole('button', { name: /Second/ }).click();
  await expect(page.getByRole('heading', { name: 'Second' })).toBeVisible();
  const response = page.waitForResponse(r => r.url().endsWith('/reevaluations'));
  release();
  await response;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(region.getByRole('status')).toBeEmpty();
  expect(gets).toBe(0);
});

test('HTTP rejection is not described as successful admission', async ({ page }) => {
  await setup(page);
  await page.route(`**/api/v1/articles/${articleId}/reevaluations`, route => route.fulfill({ status: 404, json: { error: { message: 'Not found' } } }));
  await page.goto('/');
  await page.getByRole('button', { name: /First/ }).click();
  const region = page.getByRole('region', { name: 'Score reevaluation' });
  await region.getByRole('button', { name: 'Reevaluate scores' }).click();
  await expect(region.getByRole('status')).toContainText('Reevaluation request rejected: Not found');
  await expect(region.getByText(/Request admitted/)).toHaveCount(0);
});
