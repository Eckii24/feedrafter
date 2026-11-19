import { expect, it, vi } from 'vitest';
import { runStoredCategoryTask } from '../../src/server/application/run-stored-category-task.js';
import { runStoredTagTask } from '../../src/server/application/run-stored-tag-task.js';

it.each(['category', 'tags'] as const)('%s rejects an unclaimable delivery before resolving configuration or loading inputs', async action => {
  const tasks = { claimTaskForAction: vi.fn().mockResolvedValue(null), updateOwnedTask: vi.fn() };
  const inputs = { loadResult: vi.fn() };
  const model = vi.fn();
  const catalog = { publishCategoryCandidate: vi.fn(), publishTagCandidate: vi.fn(), tagKeysFit: vi.fn() };
  const ai = { classify: vi.fn(), generate: vi.fn(), createRestrictedSession: vi.fn() };
  const dependencies = { tasks, inputs, catalog, ai, model, signal: new AbortController().signal };
  const result = action === 'category' ? await runStoredCategoryTask('task', dependencies) : await runStoredTagTask('task', dependencies);
  expect(result).toEqual({ kind: 'not_claimed' });
  expect(tasks.claimTaskForAction).toHaveBeenCalledWith('task', action, expect.any(String), expect.any(Date));
  expect(model).not.toHaveBeenCalled(); expect(inputs.loadResult).not.toHaveBeenCalled(); expect(tasks.updateOwnedTask).not.toHaveBeenCalled();
});

it.each(['category', 'tags'] as const)('%s records resolver failures only after ownership', async action => {
  const tasks = { claimTaskForAction: vi.fn().mockResolvedValue({}), updateOwnedTask: vi.fn().mockResolvedValue({}) };
  const inputs = { loadResult: vi.fn() };
  const model = vi.fn().mockRejectedValue(new Error('unavailable'));
  const catalog = { publishCategoryCandidate: vi.fn(), publishTagCandidate: vi.fn(), tagKeysFit: vi.fn() };
  const ai = { classify: vi.fn(), generate: vi.fn(), createRestrictedSession: vi.fn() };
  const dependencies = { tasks, inputs, catalog, ai, model, signal: new AbortController().signal };
  const result = action === 'category' ? await runStoredCategoryTask('task', dependencies) : await runStoredTagTask('task', dependencies);
  expect(result).toEqual({ kind: 'failed' });
  expect(tasks.updateOwnedTask).toHaveBeenCalledWith('task', expect.any(String), expect.objectContaining({ state: 'failed', errorCode: action === 'category' ? 'category_configuration_failure' : 'tag_configuration_failure' }));
  expect(inputs.loadResult).not.toHaveBeenCalled();
});
