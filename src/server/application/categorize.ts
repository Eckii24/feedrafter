import { fallbackCategoryId } from '../../shared/taxonomy.js';
import type { CategoryTaskInputStore } from '../adapters/postgres/category-task-input-store.js';
import type { CatalogStore } from '../adapters/postgres/catalog-store.js';
import type { TaskStore } from '../adapters/postgres/task-store.js';
import type { AiPort, ClassificationRequest } from '../ports/ai.js';
import { measureVerifiedRequest, type VerifiedModel } from './score-context-request.js';
import { UsageAbortError, UsageAttemptError } from './usage.js';

type Result = { kind: 'published' | 'superseded' | 'paused_budget' | 'paused_auth' | 'needs_input' | 'failed' | 'ownership_lost' };
type Dependencies = {
  inputs: Pick<CategoryTaskInputStore, 'loadResult'>;
  catalog: Pick<CatalogStore, 'publishCategoryCandidate'>;
  tasks: Pick<TaskStore, 'updateOwnedTask'>;
  ai: AiPort;
  model: VerifiedModel | null;
  signal: AbortSignal;
  now?: () => Date;
};

/** Run one already-owned category task. Publication may atomically activate its successor. */
export async function categorize(taskId: string, executionToken: string, { inputs, catalog, tasks, ai, model, signal, now = () => new Date() }: Dependencies): Promise<Result> {
  const settle = async (state: 'superseded' | 'paused_budget' | 'paused_auth' | 'needs_input' | 'failed', errorCode: string): Promise<Result> => {
    try {
      const at = now();
      const row = await tasks.updateOwnedTask(taskId, executionToken, { state, errorCode, updatedAt: at, endedAt: state === 'failed' || state === 'superseded' ? at : null });
      return { kind: row ? state : 'ownership_lost' };
    } catch { throw new Error('Category task state update failed'); }
  };
  let loaded: Awaited<ReturnType<CategoryTaskInputStore['loadResult']>>;
  try { loaded = await inputs.loadResult(taskId, executionToken, model, signal); }
  catch { return settle('failed', 'category_input_failure'); }
  if (loaded.kind === 'not_owned') return { kind: 'ownership_lost' };
  if (loaded.kind === 'stale_basis') return settle('superseded', 'stale_basis');
  if (loaded.kind === 'configuration_required' || loaded.kind === 'prerequisite_required' || loaded.kind === 'missing_selected_content' || loaded.kind === 'content_not_usable' || loaded.kind === 'invalid_handoff') return settle('needs_input', loaded.kind);
  const { basis, title, content, categories, classifier } = loaded.input;
  if (!content?.trim() || basis.contentRevision === 0) return settle('needs_input', 'missing_selected_content');
  const categoryIds = categories.map(c => c.id);
  const allowed = new Set(categoryIds);
  const criteria = Object.fromEntries(categories.map(c => [c.id, c.label]));
  const request: ClassificationRequest = { model: classifier.model, role: 'category', state: { title, content }, questions: { category: { type: 'choice', instructions: 'Choose the most appropriate category for this article.', criteria } } };
  try {
    if (!measureVerifiedRequest(classifier, request).fits) return settle('needs_input', 'context_too_large');
  } catch { return settle('needs_input', 'configuration_required'); }
  let outcome: Awaited<ReturnType<AiPort['classify']>>;
  try { outcome = await ai.classify(request, { bucket: 'classifier', taskId: basis.taskId, signal }); }
  catch (error) {
    if (error instanceof UsageAbortError) return settle('failed', 'cancelled_before_dispatch');
    if (error instanceof UsageAttemptError) {
      if (error.kind === 'auth') return settle('paused_auth', 'auth_required');
      if (error.kind === 'provider') return settle('failed', 'provider_failure');
      if (error.kind === 'aborted') return settle('failed', 'cancelled_before_dispatch');
      return settle('failed', 'dispatch_uncertain');
    }
    return settle('failed', 'category_task_failure');
  }
  if (!outcome || typeof outcome !== 'object') return settle('failed', 'invalid_category_answer');
  if (outcome.kind === 'paused_budget') return settle('paused_budget', outcome.reason);
  if (outcome.kind === 'paused_auth') return settle('paused_auth', 'auth_required');
  if (outcome.kind === 'paused_configuration') return settle('needs_input', 'configuration_required');
  if (outcome.kind !== 'completed') return settle('failed', 'invalid_category_answer');
  const answers = outcome.value?.answers;
  const answer = answers?.category;
  const probability = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== 1 || !Object.hasOwn(answers, 'category') || !answer || answer.type !== 'choice' || typeof answer.choice !== 'string' || !allowed.has(answer.choice) || !probability(answer.confidence) || !answer.probabilities || typeof answer.probabilities !== 'object' || Array.isArray(answer.probabilities) || Object.keys(answer.probabilities).length !== categoryIds.length || categoryIds.some(id => !Object.hasOwn(answer.probabilities, id)) || !Object.values(answer.probabilities).every(probability)) return settle('failed', 'invalid_category_answer');
  const categoryId = answer.probabilities[answer.choice]! >= 0.7 && answer.confidence >= 0.7 ? answer.choice : fallbackCategoryId;
  // Publisher entry is the cancellation cutoff; usage from the completed call remains settled.
  if (signal.aborted) return settle('failed', 'cancelled_before_publication');
  // A lost publication response is ambiguous: do not overwrite a possibly committed task.
  let published: Awaited<ReturnType<CatalogStore['publishCategoryCandidate']>>;
  try { published = await catalog.publishCategoryCandidate({ ...basis, categoryId }, now()); }
  catch { throw new Error('Category publication failed'); }
  return published ? { kind: 'published' } : settle('superseded', 'stale_basis');
}
