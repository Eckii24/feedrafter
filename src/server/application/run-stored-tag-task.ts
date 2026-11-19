import { randomUUID } from 'node:crypto';
import type { TaskStore } from '../adapters/postgres/task-store.js';
import { assignTags } from './assign-tags.js';

type KernelDependencies = Parameters<typeof assignTags>[2];
type Dependencies = Omit<KernelDependencies, 'model' | 'tasks'> & {
  tasks: KernelDependencies['tasks'] & Pick<TaskStore, 'claimTaskForAction'>;
  model: KernelDependencies['model'] | (() => Promise<KernelDependencies['model']>);
};

/** Claim the expected action before resolving capabilities or reading inputs. */
export async function runStoredTagTask(taskId: string, dependencies: Dependencies) {
  const { tasks, model, now = () => new Date() } = dependencies;
  const token = randomUUID();
  if (!await tasks.claimTaskForAction(taskId, 'tags', token, now())) return { kind: 'not_claimed' } as const;
  let resolved: KernelDependencies['model'];
  try { resolved = typeof model === 'function' ? await model() : model; }
  catch {
    try {
      const at = now();
      const row = await tasks.updateOwnedTask(taskId, token, { state: 'failed', errorCode: 'tag_configuration_failure', updatedAt: at, endedAt: at });
      return { kind: row ? 'failed' : 'ownership_lost' } as const;
    } catch { throw new Error('Tag task state update failed'); }
  }
  return assignTags(taskId, token, { ...dependencies, model: resolved, now });
}
