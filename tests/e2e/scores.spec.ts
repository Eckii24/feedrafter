import { test, expect } from '@playwright/test';

test('edits context flags and soft-deletes a score definition', async ({ page }) => {
  const id = '10000000-0000-4000-8000-000000000001';
  let score = { id, name: 'Signal', description: 'Signal description', prompt: 'Assess signal', active: true, includeTitle: true, includeContent: true, includeCategory: true, includeTagWeights: false, includeSourceWeight: false, deletedAt: null as string | null };
  const writes: string[] = [];
  const failOnce = new Set(['PATCH', 'DELETE']);
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/v1/scores' && method === 'GET') return route.fulfill({ json: { items: [score] } });
    if (path === `/api/v1/scores/${id}/category-prompts` && method === 'GET') return route.fulfill({ json: { items: [] } });
    if (path === `/api/v1/scores/${id}` && failOnce.delete(method)) return route.fulfill({ status: 500, json: { error: { message: `${method} failed` } } });
    if (path === `/api/v1/scores/${id}` && method === 'PATCH') { writes.push(method); score = { ...score, ...route.request().postDataJSON() }; return route.fulfill({ json: score }); }
    if (path === `/api/v1/scores/${id}` && method === 'DELETE') { writes.push(method); score = { ...score, active: false, deletedAt: '2026-01-01T00:00:00.000Z' }; return route.fulfill({ json: score }); }
    if (path === '/api/v1/categories' || path === '/api/v1/tags') return route.fulfill({ json: { items: [] } });
    if (path === '/api/v1/articles') return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.abort();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Catalog settings' }).click();
  const editor = page.getByRole('group', { name: 'Signal' });
  await editor.getByLabel('Include content').uncheck();
  await editor.getByLabel('Include tag weights').check();
  await editor.getByLabel('Include source weight').check();
  await editor.getByRole('button', { name: 'Save score' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('PATCH failed');
  await expect(editor.getByRole('button', { name: 'Save score' })).toBeFocused();
  await expect(editor.getByLabel('Include tag weights')).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Score saved.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Signal' }).getByRole('button', { name: 'Save score' })).toBeFocused();
  await expect(page.getByRole('group', { name: 'Signal' }).getByLabel('Include content')).not.toBeChecked();
  await expect(page.getByRole('group', { name: 'Signal' }).getByLabel('Include tag weights')).toBeChecked();
  await expect(page.getByRole('group', { name: 'Signal' }).getByLabel('Include source weight')).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(editor.getByRole('button', { name: 'Delete score' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('DELETE failed');
  await expect(editor.getByRole('button', { name: 'Delete score' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Signal (deleted)')).toBeVisible();
  await expect(page.getByRole('group', { name: 'New score' }).getByRole('button', { name: 'Create score' })).toBeFocused();
  await expect(page.getByRole('group', { name: 'Signal' })).toHaveCount(0);
  expect(writes).toEqual(['PATCH', 'DELETE']);
});

test('sets and removes an active category override without offering fallback', async ({ page }) => {
  const id = '10000000-0000-4000-8000-000000000001';
  const category = '20000000-0000-4000-8000-000000000001';
  let prompt = '';
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/v1/scores') return route.fulfill({ json: { items: [{ id, name: 'Signal', description: 'Description', prompt: 'Global', active: true, includeTitle: true, includeContent: true, includeCategory: true, includeTagWeights: false, includeSourceWeight: false, deletedAt: null }] } });
    if (path === '/api/v1/categories') return route.fulfill({ json: { items: [{ id: category, label: 'Science', archivedAt: null }, { id: '00000000-0000-4000-8000-000000000001', label: 'Fallback', archivedAt: null }, { id: '20000000-0000-4000-8000-000000000002', label: 'Old', archivedAt: '2026-01-01' }] } });
    if (path === '/api/v1/tags') return route.fulfill({ json: { items: [] } });
    if (path === `/api/v1/scores/${id}/category-prompts`) return route.fulfill({ json: { items: prompt ? [{ scoreId: id, categoryId: category, prompt }] : [] } });
    if (path === `/api/v1/scores/${id}/category-prompts/${category}`) {
      if (method === 'PUT') { prompt = route.request().postDataJSON().prompt; return route.fulfill({ json: { scoreId: id, categoryId: category, prompt } }); }
      if (method === 'DELETE') { prompt = ''; return route.fulfill({ json: { removed: true } }); }
    }
    if (path === '/api/v1/articles') return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.abort();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Catalog settings' }).click();
  const editor = page.getByRole('group', { name: 'Category prompt overrides for Signal' });
  await expect(editor.getByRole('option', { name: 'Old' })).toHaveCount(0);
  await expect(editor.getByRole('option', { name: 'Fallback' })).toHaveCount(0);
  await editor.getByRole('combobox', { name: 'Category' }).selectOption(category);
  await editor.getByLabel('Category prompt').fill('Science prompt');
  await editor.getByRole('button', { name: 'Save override' }).click();
  await expect(editor.getByRole('status')).toHaveText('Override saved.');
  expect(prompt).toBe('Science prompt');
  await expect(editor.getByRole('button', { name: 'Save override' })).toBeFocused();
  await page.reload();
  await page.getByRole('button', { name: 'Catalog settings' }).click();
  await editor.getByRole('combobox', { name: 'Category' }).selectOption(category);
  await expect(editor.getByLabel('Category prompt')).toHaveValue('Science prompt');
  await editor.getByRole('button', { name: 'Remove override' }).click();
  await expect(editor.getByRole('status')).toHaveText('Override removed.');
  await expect(editor.getByLabel('Category prompt')).toHaveValue('');
  expect(prompt).toBe('');
});
