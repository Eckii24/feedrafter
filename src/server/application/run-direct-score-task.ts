import type { ScoreStore } from '../adapters/postgres/score-store.js';
import type { TaskStore } from '../adapters/postgres/task-store.js';
import type { AiPort } from '../ports/ai.js';
import { classifyScoreEvidence, processContextChunks, type ScoreContextTask } from './process-context-chunks.js';
import type { ContextStore } from '../adapters/postgres/context-store.js';
import { copyRequestModel } from './score-context-request.js';
import { UsageAbortError, UsageAttemptError } from './usage.js';

export type DirectScoreTaskResult = { kind: 'published' | 'superseded' | 'paused_budget' | 'paused_auth' | 'needs_input' | 'failed' | 'ownership_lost' };

type Dependencies = {
  ai: AiPort;
  scores: Pick<ScoreStore, 'publishCandidate'>;
  tasks: Pick<TaskStore, 'updateOwnedTask'>;
  context?: Pick<ContextStore, 'save' | 'resume' | 'claimRepair'>;
  now?: () => Date;
};

/** Runs one already-owned task; each inference goes through usage admission. */
export async function runDirectScoreTask(input: ScoreContextTask, { ai, scores, tasks, context, now = () => new Date() }: Dependencies): Promise<DirectScoreTaskResult> {
  input = { ...input, owner: structuredClone(input.owner), article: structuredClone(input.article), fields: { ...input.fields }, classifier: copyRequestModel(input.classifier), generator: copyRequestModel(input.generator) };
  // Capture the fence before any await; caller-owned input may change during dispatch.
  const { taskId, executionToken } = input.owner;
  const settle = async (state: 'superseded' | 'paused_budget' | 'paused_auth' | 'needs_input' | 'failed', errorCode: string): Promise<DirectScoreTaskResult> => {
    try {
      const at = now();
      const row = await tasks.updateOwnedTask(taskId, executionToken, { state, errorCode, updatedAt: at, endedAt: state === 'failed' || state === 'superseded' ? at : null });
      return { kind: row ? state : 'ownership_lost' };
    } catch {
      throw new Error('Score task state update failed');
    }
  };

  let outcome: Awaited<ReturnType<typeof processContextChunks>>;
  try {
    outcome = await processContextChunks(input, ai, context);
    if (outcome.kind === 'evidence_ready') outcome = await classifyScoreEvidence(input, outcome, ai);
  } catch (error) {
    if (error instanceof UsageAbortError) return settle('failed', 'cancelled_before_dispatch');
    if (error instanceof UsageAttemptError) {
      if (error.kind === 'auth') return settle('paused_auth', 'auth_required');
      if (error.kind === 'provider') return settle('failed', 'provider_failure');
      if (error.kind === 'aborted') return settle('failed', 'cancelled_before_dispatch');
      return settle('failed', 'dispatch_uncertain');
    }
    return settle('failed', 'score_task_failure');
  }
  switch (outcome.kind) {
    case 'paused_budget': return settle('paused_budget', outcome.reason);
    case 'paused_auth': return settle('paused_auth', 'auth_required');
    case 'paused_configuration': return settle('needs_input', 'configuration_required');
    case 'needs_input': return settle('needs_input', outcome.reason);
    case 'unsupported_chunks': return settle('needs_input', 'context_too_large');
    case 'completed': {
      // Publication may have committed even if its response is lost. Never overwrite
      // task state after an ambiguous store error, and never expose database details.
      let published: boolean;
      try { published = await scores.publishCandidate(outcome.value, now()); }
      catch { throw new Error('Score publication failed'); }
      return published ? { kind: 'published' } : settle('superseded', 'stale_basis');
    }
    default: return settle('failed', 'score_task_failure');
  }
}
