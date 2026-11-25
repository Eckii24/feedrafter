import { normalizeTagLabel } from '../../shared/taxonomy.js';
import type { TagTaskInputStore } from '../adapters/postgres/tag-task-input-store.js';
import type { TagCandidate, TagPublication } from '../adapters/postgres/catalog-store.js';
import type { TaskStore } from '../adapters/postgres/task-store.js';
import type { AiPort, GenerationRequest } from '../ports/ai.js';
import type { RequestModel } from './score-context-request.js';
import { boundedArticleRequest } from './bounded-article-request.js';
import { UsageAbortError, UsageAttemptError } from './usage.js';

type Result = { kind: 'published' | 'superseded' | 'paused_budget' | 'paused_auth' | 'needs_input' | 'failed' | 'ownership_lost' };
type Dependencies = {
  inputs: Pick<TagTaskInputStore, 'loadResult'>;
  catalog: { publishTagCandidate(candidate: TagCandidate, at: Date): Promise<TagPublication | null>; tagKeysFit(labels: string[]): Promise<boolean> };
  tasks: Pick<TaskStore, 'updateOwnedTask'>;
  ai: AiPort;
  model: RequestModel | null;
  signal: AbortSignal;
  now?: () => Date;
};

/** Run one owned tags task, direct only. No claim, retry, shortlist, or successor. */
export async function assignTags(taskId: string, executionToken: string, { inputs, catalog, tasks, ai, model, signal, now = () => new Date() }: Dependencies): Promise<Result> {
  const settle = async (state: 'superseded' | 'paused_budget' | 'paused_auth' | 'needs_input' | 'failed', errorCode: string): Promise<Result> => {
    try {
      const at = now();
      const row = await tasks.updateOwnedTask(taskId, executionToken, { state, errorCode, updatedAt: at, endedAt: state === 'failed' || state === 'superseded' ? at : null });
      return { kind: row ? state : 'ownership_lost' };
    } catch { throw new Error('Tag task state update failed'); }
  };
  let loaded: Awaited<ReturnType<TagTaskInputStore['loadResult']>>;
  try { loaded = await inputs.loadResult(taskId, executionToken, model, signal); }
  catch { return settle('failed', 'tag_input_failure'); }
  if (loaded.kind === 'not_owned') return { kind: 'ownership_lost' };
  if (loaded.kind === 'stale_basis') return settle('superseded', 'stale_basis');
  if (loaded.kind !== 'loaded') return settle('needs_input', loaded.kind);
  const { title, category, content, generator } = loaded.input;
  const basis = structuredClone(loaded.input.basis);
  if (!content.trim() || basis.contentRevision <= 0) return settle('needs_input', 'missing_selected_content');
  let request: GenerationRequest | null;
  try {
    request = boundedArticleRequest(generator, content, (text, sampled): GenerationRequest => ({ model: generator.model, role: 'tags', system: 'Return only a JSON object with a tags array of at most 10 unique, nonblank tag labels appropriate for this article.' + (sampled ? ' The content consists of excerpts from the beginning, middle and end; omitted text is unknown. Use only evidence in the excerpts; do not invent details.' : ''), user: JSON.stringify({ title, category, content: text }) }));
  } catch { return settle('needs_input', 'configuration_required'); }
  if (!request) return settle('needs_input', 'context_too_large');
  let outcome: Awaited<ReturnType<AiPort['generate']>>;
  try { outcome = await ai.generate(request, { bucket: 'automatic', taskId: basis.taskId, signal }); }
  catch (error) {
    if (error instanceof UsageAbortError) return settle('failed', 'cancelled_before_dispatch');
    if (error instanceof UsageAttemptError) {
      if (error.kind === 'auth') return settle('paused_auth', 'auth_required');
      if (error.kind === 'provider') return settle('failed', 'provider_failure');
      if (error.kind === 'aborted') return settle('failed', 'cancelled_before_dispatch');
      return settle('failed', 'dispatch_uncertain');
    }
    return settle('failed', 'tag_task_failure');
  }
  if (!outcome || typeof outcome !== 'object') return settle('failed', 'invalid_tag_answer');
  if (outcome.kind === 'paused_budget') return settle('paused_budget', outcome.reason);
  if (outcome.kind === 'paused_auth') return settle('paused_auth', 'auth_required');
  if (outcome.kind === 'paused_configuration') return settle('needs_input', 'configuration_required');
  if (outcome.kind !== 'completed') return settle('failed', 'invalid_tag_answer');
  let labels: string[];
  try {
    const answer: unknown = JSON.parse(outcome.value.text);
    if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).length !== 1 || !Object.hasOwn(answer, 'tags')) throw new Error();
    const values = (answer as { tags: unknown }).tags;
    if (!Array.isArray(values) || values.length > 10) throw new Error();
    labels = values.map(normalizeTagLabel);
    if (labels.some(label => label.includes('\0') || Buffer.from(label, 'utf8').toString('utf8') !== label) || new Set(labels).size !== labels.length) throw new Error();
  } catch { return settle('failed', 'invalid_tag_answer'); }
  try {
    if (!await catalog.tagKeysFit(labels)) return settle('failed', 'invalid_tag_answer');
  } catch { return settle('failed', 'tag_validation_failure'); }
  // Publisher entry is the cutoff; do not overwrite an ambiguous committed success.
  if (signal.aborted) return settle('failed', 'cancelled_before_publication');
  let published: TagPublication | null;
  try { published = await catalog.publishTagCandidate({ ...basis, labels }, now()); }
  catch { throw new Error('Tag publication failed'); }
  return published ? { kind: 'published' } : settle('superseded', 'stale_basis');
}
