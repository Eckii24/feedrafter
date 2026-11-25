import type { ContextStore } from '../adapters/postgres/context-store.js';
import type { ScoreHandoff } from '../adapters/postgres/score-handoff.js';
import { generateScoreEvidence } from './generate-score-evidence.js';
import type { AiOutcome, AiPort, JsonObject } from '../ports/ai.js';
import { prepareContext, selectContext, type ContextInput, type ContextPlan } from './prepare-context.js';
import { copyRequestModel, measureRequest, renderFinalEvidenceState, renderScoreRequest, requestPlannerLimits, validateRequestModel, type RequestModel } from './score-context-request.js';
export type { VerifiedModel } from './score-context-request.js';
import { UsageAttemptError } from './usage.js';

export type ScoreContextTask = Readonly<{
  owner: Readonly<{ taskId: string; executionToken: string; assignmentRevision: number; catalogEpoch: number; handoff?: ScoreHandoff }>;
  scoreId: string;
  prompt: string;
  article: ContextInput['article'];
  fields: ContextInput['fields'];
  generation: number;
  classifier: RequestModel;
  generator: RequestModel;
  signal: AbortSignal;
}>;
export type ScoreCandidate = Readonly<{
  value: number;
  basis: Readonly<{ taskId: string; executionToken: string; scoreId: string; articleId: string; contentRevision: number; assignmentRevision: number; catalogEpoch: number; generation: number; condensed: boolean; limited: boolean; handoff?: ScoreHandoff }>;
  coverage: ContextPlan['coverage'];
}>;
export type ScoreExecution = AiOutcome<ScoreCandidate> | { kind: 'unsupported_chunks' } | { kind: 'needs_input'; reason: 'missing_selected_content' } | Awaited<ReturnType<typeof generateScoreEvidence>>;

/** Direct candidates or persisted evidence only. C14 must fence any publication. */
export async function processContextChunks(inputTask: ScoreContextTask, ai: AiPort, store?: Pick<ContextStore, 'save' | 'resume' | 'claimRepair'>): Promise<ScoreExecution> {
  const task = { ...inputTask, owner: { ...inputTask.owner, ...(inputTask.owner.handoff ? { handoff: structuredClone(inputTask.owner.handoff) } : {}) }, article: structuredClone(inputTask.article), fields: { ...inputTask.fields }, classifier: copyRequestModel(inputTask.classifier), generator: copyRequestModel(inputTask.generator) };
  if (!task.owner?.taskId?.trim() || !task.owner.executionToken?.trim() || !Number.isSafeInteger(task.owner.assignmentRevision) || task.owner.assignmentRevision < 0 || !Number.isInteger(task.owner.catalogEpoch) || task.owner.catalogEpoch < 0 || task.owner.catalogEpoch > 2147483647 || !task.scoreId?.trim() || !task.prompt?.trim() || !task.signal || typeof task.signal.addEventListener !== 'function') throw new RangeError('invalid score task');
  if (!task.article || typeof task.article.id !== 'string' || !task.article.id.trim() || !Number.isSafeInteger(task.article.contentRevision) || task.article.contentRevision < 0 || !Number.isSafeInteger(task.generation) || task.generation < 0 || typeof task.article.content !== 'string' || typeof task.fields?.includeContent !== 'boolean') throw new RangeError('invalid context identity');
  if (task.fields.includeContent && (!task.article.content.trim() || task.article.contentRevision === 0)) return { kind: 'needs_input', reason: 'missing_selected_content' };
  validateRequestModel(task.classifier);
  validateRequestModel(task.generator);
  const requestFor = (state: JsonObject) => renderScoreRequest(task.classifier.model, task.prompt, state);
  const selected = selectContext(task.article, task.fields);
  const direct = measureRequest(task.classifier, requestFor(selected));
  const directSize = direct.inputTokens;
  if (!direct.fits) return store && task.fields.includeContent ? generateScoreEvidence(task, ai, store) : { kind: 'unsupported_chunks' };
  // Convert the planner envelope to exactly the request passed to classify.
  // Its other fields never enter the classifier state.
  const tokenizer = (serialized: string): number => {
    const envelope = JSON.parse(serialized) as { context: JsonObject };
    return measureRequest(task.classifier, requestFor(envelope.context)).inputTokens;
  };
  const input: ContextInput = { taskKind: 'scores', fields: task.fields, article: task.article, generation: task.generation, prompt: task.prompt, questions: [task.prompt], tools: '', limits: requestPlannerLimits(task.classifier), tokenizer, sizing: 'kind' in task.classifier ? 'utf8-bytes' : 'provider' };
  const plan = prepareContext(input);
  if (plan.kind !== 'direct') return { kind: 'unsupported_chunks' };
  const request = requestFor(plan.direct.request.context as JsonObject);
  // Recount the exact immutable request immediately before dispatch.
  const measured = measureRequest(task.classifier, request);
  if (measured.inputTokens !== directSize || measured.inputTokens !== plan.direct.inputTokens || !measured.fits) throw new RangeError(`classifier request exceeds ${'kind' in task.classifier ? 'unverified local' : 'verified'} limits`);
  let outcome;
  try { outcome = await ai.classify(request, { bucket: 'classifier', taskId: task.owner.taskId, signal: task.signal }); }
  catch (error) { if (error instanceof UsageAttemptError && error.kind === 'auth') return { kind: 'paused_auth' }; throw error; }
  if (outcome.kind !== 'completed') return outcome;
  const answers = outcome.value.answers;
  const answer = answers?.score;
  if (!answers || Object.keys(answers).length !== 1 || !answer || answer.type !== 'score' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 4) throw new RangeError('invalid native score index');
  return { kind: 'completed', value: { value: 100 * answer.score / 4, basis: { taskId: task.owner.taskId, executionToken: task.owner.executionToken, scoreId: task.scoreId, articleId: task.article.id, contentRevision: task.article.contentRevision, assignmentRevision: task.owner.assignmentRevision, catalogEpoch: task.owner.catalogEpoch, generation: task.generation, condensed: false, limited: false, ...(task.owner.handoff ? { handoff: task.owner.handoff } : {}) }, coverage: plan.coverage } };
}

/** A complete chunk scan is not a complete assessment: extracted evidence can omit
 * relevant material, so the published result is both condensed and limited. */
export async function classifyScoreEvidence(task: ScoreContextTask, evidence: Extract<Awaited<ReturnType<typeof generateScoreEvidence>>, { kind: 'evidence_ready' }>, ai: AiPort): Promise<AiOutcome<ScoreCandidate> | { kind: 'unsupported_chunks' }> {
  const progress = evidence.progress;
  if (!progress.coverage.complete || progress.completedChunks !== progress.totalChunks || progress.coverage.length !== task.article.content.length || progress.coverage.missing.length || evidence.completions.length !== progress.totalChunks) throw new Error('incomplete score evidence');
  const items = evidence.completions.flatMap(c => c.evidence.map((item, index) => ({ ...item, id: `${c.chunkId}:${index}` })));
  const request = renderScoreRequest(task.classifier.model, task.prompt, renderFinalEvidenceState(task.article, task.fields, items));
  if (!measureRequest(task.classifier, request).fits) return { kind: 'unsupported_chunks' };
  const outcome = await ai.classify(request, { bucket: 'classifier', taskId: task.owner.taskId, signal: task.signal });
  if (outcome.kind !== 'completed') return outcome;
  const answers = outcome.value.answers, answer = answers?.score;
  if (!answers || Object.keys(answers).length !== 1 || !answer || answer.type !== 'score' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 4) throw new RangeError('invalid native score index');
  return { kind: 'completed', value: { value: 100 * answer.score / 4, basis: { taskId: task.owner.taskId, executionToken: task.owner.executionToken, scoreId: task.scoreId, articleId: task.article.id, contentRevision: task.article.contentRevision, assignmentRevision: task.owner.assignmentRevision, catalogEpoch: task.owner.catalogEpoch, generation: task.generation, condensed: true, limited: true, ...(task.owner.handoff ? { handoff: task.owner.handoff } : {}) }, coverage: { selected: true, length: progress.coverage.length, intervals: progress.coverage.intervals, missing: [], complete: true } } };
}
