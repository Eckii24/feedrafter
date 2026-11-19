import { expect, test } from '@playwright/test';
import { articleProcessingFixture, eventually } from '../helpers/article-processing-fixture.js';

test('real server and workers persist enrichment and score-only reevaluations', async ({ page }) => {
  test.setTimeout(120000);
  const f = await articleProcessingFixture();
  try {
    const get = async (path: string) => {
      const response = await fetch(`${f.origin}${path}`);
      expect(response.ok).toBe(true);
      return response.json();
    };
    expect(await get(`/api/v1/processing-tasks/${f.admitted.tagsTaskId}`)).toMatchObject({ action: 'tags', state: 'waiting_dependency', scoreTargetId: null });
    await f.startWorkers();
    const ids = [f.admitted.categoryTaskId, f.admitted.tagsTaskId, ...f.admitted.scoreTaskIds];
    await eventually(async () => (await Promise.all(ids.map(id => get(`/api/v1/processing-tasks/${id}`)))).every(task => task.state === 'succeeded'));
    const catalog = await get(`/api/v1/articles/${f.article}/catalog`);
    expect(catalog.tags.map((tag: { label: string }) => tag.label)).toContain('synthetic topic');
    expect(catalog.category.label).toBeTruthy();
    const scores = await get(`/api/v1/articles/${f.article}/scores`);
    const initial = scores.items.find((item: { scoreTargetId: string }) => item.scoreTargetId === f.target);
    expect(initial).toMatchObject({ value: 25, contentRevision: 1, assignmentRevision: catalog.assignmentRevision, stale: false });
    await page.goto(f.origin);
    await page.getByRole('button', { name: /Synthetic product article/ }).click();
    const editor = page.getByRole('region', { name: 'Article catalog' });
    await expect(editor.getByLabel('Category')).toHaveValue(catalog.category.id);
    await expect(editor).toContainText('synthetic topic');
    await expect(page.getByRole('region', { name: 'Score results' })).toContainText('Current result: 25');
    await page.reload();
    await page.getByRole('button', { name: /Synthetic product article/ }).click();
    await expect(editor.getByLabel('Category')).toHaveValue(catalog.category.id);
    await expect(editor).toContainText('synthetic topic');
    await expect(page.getByRole('region', { name: 'Score results' })).toContainText('Current result: 25');
    const reevaluation = page.getByRole('region', { name: 'Score reevaluation' });
    expect(f.preparationFetches).toBe(1);
    f.setScoreMode('changed');
    const admissionResponse = page.waitForResponse(response => response.url().endsWith('/reevaluations') && response.request().method() === 'POST');
    await reevaluation.getByRole('button', { name: 'Reevaluate scores' }).click();
    const admission = await (await admissionResponse).json();
    expect(admission.tasks).toEqual([expect.objectContaining({ scoreTargetId: f.target, generation: initial.latestTask.generation + 1 })]);
    await expect(reevaluation).toContainText('State: succeeded', { timeout: 30000 });
    await expect(page.getByRole('region', { name: 'Score results' })).toContainText('Current result: 75', { timeout: 30000 });
    expect(await get(`/api/v1/articles/${f.article}/catalog`)).toEqual(catalog);
    expect(f.calls.filter(call => call === 'category')).toHaveLength(1);
    expect(f.calls.filter(call => call === 'tags')).toHaveLength(1);
    expect(f.preparationFetches).toBe(1);
    f.setScoreMode('failed');
    await reevaluation.getByRole('button', { name: 'Reevaluate scores' }).click();
    await expect(reevaluation).toContainText('cancelled_before_dispatch', { timeout: 30000 });
    await expect(page.getByRole('region', { name: 'Score results' })).toContainText('Current result: 75', { timeout: 30000 });
    const final = await get(`/api/v1/articles/${f.article}/scores`);
    expect(final.items.find((item: { scoreTargetId: string }) => item.scoreTargetId === f.target)).toMatchObject({ value: 75, latestTask: { state: 'failed', errorCode: 'cancelled_before_dispatch' } });
    expect(await get(`/api/v1/articles/${f.article}/catalog`)).toEqual(catalog);
    expect(f.calls.filter(call => call === 'category')).toHaveLength(1);
    expect(f.calls.filter(call => call === 'tags')).toHaveLength(1);
    expect(f.preparationFetches).toBe(1);
  } finally { await f.close(); }
});
