import { randomUUID } from 'node:crypto';
import type { ScoreTaskInputStore, ScoreTaskModels } from '../adapters/postgres/score-task-input-store.js';
import type { ScoreStore } from '../adapters/postgres/score-store.js';
import type { TaskStore } from '../adapters/postgres/task-store.js';
import type { AiPort } from '../ports/ai.js';
import { runDirectScoreTask, type DirectScoreTaskResult } from './run-direct-score-task.js';

type Dependencies = {
  ai: AiPort;
  inputs: Pick<ScoreTaskInputStore, 'loadResult'>;
  scores: Pick<ScoreStore, 'publishCandidate'>;
  tasks: Pick<TaskStore, 'claimTaskForAction' | 'updateOwnedTask'>;
  models: ScoreTaskModels | null | (() => Promise<ScoreTaskModels | null>);
  signal: AbortSignal;
  now?: () => Date;
};

/** Execute one persisted task; scheduling and retries belong to a later caller. */
export async function runStoredScoreTask(taskId: string, { ai, inputs, scores, tasks, models, signal, now = () => new Date() }: Dependencies): Promise<DirectScoreTaskResult | { kind: 'not_claimed' }> {
  const executionToken = randomUUID();
  if (!await tasks.claimTaskForAction(taskId, 'scores', executionToken, now())) return { kind: 'not_claimed' };
  let resolvedModels: ScoreTaskModels | null;
  try {
    resolvedModels = typeof models === 'function' ? await models() : models;
  } catch {
    try {
      const at = now();
      const row = await tasks.updateOwnedTask(taskId, executionToken, { state: 'failed', errorCode: 'score_configuration_failure', updatedAt: at, endedAt: at });
      return { kind: row ? 'failed' : 'ownership_lost' };
    } catch {
      throw new Error('Score task state update failed');
    }
  }
  let loaded: Awaited<ReturnType<ScoreTaskInputStore['loadResult']>>;
  try {
    loaded = await inputs.loadResult(taskId, executionToken, resolvedModels, signal);
  } catch {
    try {
      const at = now();
      const row = await tasks.updateOwnedTask(taskId, executionToken, { state: 'failed', errorCode: 'score_input_failure', updatedAt: at, endedAt: at });
      return { kind: row ? 'failed' : 'ownership_lost' };
    } catch {
      throw new Error('Score task state update failed');
    }
  }
  if (loaded.kind === 'loaded') return runDirectScoreTask(loaded.input, { ai, scores, tasks, now });
  const state = loaded.kind === 'stale_basis' ? 'superseded' : 'needs_input';
  const at = now();
  try {
    const row = await tasks.updateOwnedTask(taskId, executionToken, { state, errorCode: loaded.kind, updatedAt: at, endedAt: state === 'superseded' ? at : null });
    return { kind: row ? state : 'ownership_lost' };
  } catch {
    throw new Error('Score task state update failed');
  }
}
