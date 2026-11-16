import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { prepareContext, type ContextInput, type ContextPlan } from '../../application/prepare-context.js';
import type { ChunkCompletion, ChunkEvidence } from '../../domain/context-reduction.js';
import { isPostgresJsonText } from '../../domain/postgres-json-text.js';
import type { Database } from './client.js';
import { articleContents, chunkResults, contentChunks, contextCheckpoints, contextPlans } from './schema/enrichment.js';
import { articles } from './schema/import.js';
import { processingTasks } from './schema/processing.js';

type ChunkPlan = Extract<ContextPlan, { kind: 'chunks' }>;
export type ContextOwner = { taskId: string; executionToken: string; assignmentRevision: number };
export type ContextProgress = {
  completedChunkIds: string[];
  repairStartedChunkIds?: string[];
  reductionLevels: { level: number; evidence: string[] }[];
};
type Interval = { start: number; end: number };
export type { ChunkCompletion, ChunkEvidence } from '../../domain/context-reduction.js';
export type ContextCheckpoint = ContextProgress & {
  version: 3;
  repairStartedChunkIds: string[];
  evidenceDigest: string;
  totalChunks: number;
  completedChunks: number;
  coverage: { length: number; intervals: Interval[]; missing: Interval[]; complete: boolean };
};

// The digest is operational identity, not prompt/model history. Include the exact
// planned envelopes and limits, task and assignment basis; never store the inputs.
function planned(owner: ContextOwner, input: ContextInput) {
  const plan = prepareContext(input);
  if (plan.kind !== 'chunks') throw new RangeError('context persistence requires a chunk plan');
  if (!Number.isInteger(owner.assignmentRevision) || owner.assignmentRevision < 0 || owner.assignmentRevision > 2147483647 || !owner.executionToken) throw new RangeError('invalid context owner');
  const id = createHash('sha256').update(JSON.stringify([owner.taskId, owner.assignmentRevision, input.limits, plan])).digest('hex');
  return { id, plan };
}

function checkpoint(plan: ChunkPlan, progress: ContextProgress, evidenceDigest: string): ContextCheckpoint {
  if (typeof evidenceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(evidenceDigest)) throw new RangeError('invalid evidence digest');
  if (!progress || !['completedChunkIds,reductionLevels', 'completedChunkIds,reductionLevels,repairStartedChunkIds'].includes(Object.keys(progress).sort().join(',')) || !Array.isArray(progress.completedChunkIds) || !Array.isArray(progress.reductionLevels) || progress.reductionLevels.length > 8 || (progress.repairStartedChunkIds !== undefined && !Array.isArray(progress.repairStartedChunkIds))) throw new RangeError('invalid context progress');
  const allowed = new Set(plan.chunks.map(chunk => chunk.id));
  const done = new Set(progress.completedChunkIds);
  if (done.size !== progress.completedChunkIds.length || [...done].some(id => typeof id !== 'string' || !allowed.has(id))) throw new RangeError('invalid completed chunks');
  const repairs = progress.repairStartedChunkIds ?? [];
  if (new Set(repairs).size !== repairs.length || repairs.some(id => typeof id !== 'string' || !allowed.has(id))) throw new RangeError('invalid repair markers');
  for (const [index, level] of progress.reductionLevels.entries()) {
    if (!level || Object.keys(level).sort().join(',') !== 'evidence,level' || level.level !== index + 1 || !Array.isArray(level.evidence) || level.evidence.length > 4096 || level.evidence.some(value => typeof value !== 'string' || !isPostgresJsonText(value) || Buffer.byteLength(value) > 65536)) throw new RangeError('invalid reduction state');
  }
  const intervals: Interval[] = [], missing: Interval[] = [];
  for (const chunk of plan.chunks) {
    const target = done.has(chunk.id) ? intervals : missing;
    const last = target.at(-1);
    if (last && last.end === chunk.start) last.end = chunk.end;
    else target.push({ start: chunk.start, end: chunk.end });
  }
  const state: ContextCheckpoint = { version: 3, evidenceDigest, completedChunkIds: [...progress.completedChunkIds], repairStartedChunkIds: [...repairs], reductionLevels: progress.reductionLevels.map(level => ({ level: level.level, evidence: [...level.evidence] })), totalChunks: plan.chunks.length, completedChunks: done.size, coverage: { length: plan.coverage.length, intervals, missing, complete: missing.length === 0 } };
  // Leave room for PostgreSQL jsonb's whitespace and escaping.
  if (Buffer.byteLength(JSON.stringify(state)) > 500000) throw new RangeError('context checkpoint too large');
  return state;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function verifyChunks(tx: Transaction, id: string, plan: ChunkPlan, input: ContextInput, owner: ContextOwner) {
  const [storedPlan] = await tx.select().from(contextPlans).where(eq(contextPlans.id, id));
  if (!storedPlan || storedPlan.taskId !== owner.taskId || storedPlan.articleId !== input.article.id || storedPlan.contentRevision !== input.article.contentRevision || storedPlan.assignmentRevision !== owner.assignmentRevision || storedPlan.generation !== input.generation || storedPlan.taskKind !== input.taskKind) throw new Error('invalid stored context plan');
  const rows = await tx.select().from(contentChunks).where(eq(contentChunks.planId, id)).orderBy(contentChunks.ordinal);
  if (rows.length !== plan.chunks.length || rows.some((row, ordinal) => {
    const chunk = plan.chunks[ordinal]!;
    return row.articleId !== input.article.id || row.contentRevision !== input.article.contentRevision || row.ordinal !== ordinal || row.plannerChunkId !== chunk.id || row.startOffset !== chunk.start || row.endOffset !== chunk.end || row.overlap !== chunk.overlap || row.startSeconds !== chunk.startSeconds || row.endSeconds !== chunk.endSeconds || row.text !== input.article.content.slice(chunk.start, chunk.end);
  })) throw new Error('invalid stored context chunks');
  return rows;
}

const purpose = 'context-evidence-v2';
const boundary = (text: string, offset: number) => offset <= 0 || offset >= text.length || !(text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff);

// questionId is the decimal zero-based index in the immutable planned questions.
// Ref offsets are absolute UTF-16 offsets in the selected original article.
function validateCompletions(plan: ChunkPlan, input: ContextInput, completions: ChunkCompletion[]) {
  if (!Array.isArray(completions) || completions.length > plan.chunks.length || Buffer.byteLength(JSON.stringify(completions)) > 500000) throw new RangeError('invalid evidence size');
  const seen = new Set<string>();
  for (const completion of completions) {
    if (!completion || Object.keys(completion).sort().join(',') !== 'chunkId,evidence' || typeof completion.chunkId !== 'string' || seen.has(completion.chunkId) || !Array.isArray(completion.evidence) || completion.evidence.length > 32) throw new RangeError('invalid completion');
    const chunk = plan.chunks.find(item => item.id === completion.chunkId);
    if (!chunk) throw new RangeError('invalid completion chunk');
    seen.add(completion.chunkId);
    for (const item of completion.evidence) {
      if (!item || Object.keys(item).sort().join(',') !== 'polarity,questionId,refs,text' || typeof item.questionId !== 'string' || !/^(0|[1-9][0-9]*)$/.test(item.questionId) || Number(item.questionId) >= input.questions.length || !['support', 'counter', 'uncertain'].includes(item.polarity) || typeof item.text !== 'string' || !item.text.trim() || !isPostgresJsonText(item.text) || Buffer.byteLength(item.text) > 16384 || !Array.isArray(item.refs) || !item.refs.length || item.refs.length > 16) throw new RangeError('invalid evidence');
      for (const ref of item.refs) {
        if (!ref || Object.keys(ref).sort().join(',') !== 'chunkId,end,quote,start' || ref.chunkId !== chunk.id || !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < chunk.start || ref.end > chunk.end || ref.start >= ref.end || !boundary(input.article.content, ref.start) || !boundary(input.article.content, ref.end) || typeof ref.quote !== 'string' || !isPostgresJsonText(ref.quote) || Buffer.byteLength(ref.quote) > 16384 || input.article.content.slice(ref.start, ref.end) !== ref.quote) throw new RangeError('invalid evidence reference');
      }
    }
  }
}

function evidenceDigest(plan: ChunkPlan, completions: ChunkCompletion[]) {
  const byId = new Map(completions.map(item => [item.chunkId, item]));
  const canonical = plan.chunks.flatMap(chunk => {
    const item = byId.get(chunk.id);
    return item ? [[item.chunkId, item.evidence.map(e => [e.questionId, e.polarity, e.text, e.refs.map(r => [r.chunkId, r.start, r.end, r.quote])])]] : [];
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function validateState(plan: ChunkPlan, saved: ContextCheckpoint) {
  const version = (saved as { version?: unknown })?.version;
  // The original v2 evidence stage never dispatched repairs. Its exact codec is
  // accepted, but no unknown v2 fields may be silently dropped.
  const keys = version === 2 ? 'completedChunkIds,completedChunks,coverage,evidenceDigest,reductionLevels,totalChunks,version' : 'completedChunkIds,completedChunks,coverage,evidenceDigest,reductionLevels,repairStartedChunkIds,totalChunks,version';
  if (!saved || (version !== 2 && version !== 3) || Object.keys(saved).sort().join(',') !== keys || (version === 3 && !Array.isArray(saved.repairStartedChunkIds))) throw new Error('invalid stored context checkpoint');
  const state = checkpoint(plan, { completedChunkIds: saved.completedChunkIds, reductionLevels: saved.reductionLevels, repairStartedChunkIds: version === 2 ? [] : saved.repairStartedChunkIds }, saved.evidenceDigest);
  if (JSON.stringify(saved) !== JSON.stringify(state)) {
    // JSONB does not preserve object key order.
    if (saved.totalChunks !== state.totalChunks || saved.completedChunks !== state.completedChunks || !saved.coverage || saved.coverage.length !== state.coverage.length || saved.coverage.complete !== state.coverage.complete || !Array.isArray(saved.coverage.intervals) || !Array.isArray(saved.coverage.missing) || JSON.stringify(saved.coverage.intervals.map(item => [item?.start, item?.end])) !== JSON.stringify(state.coverage.intervals.map(item => [item.start, item.end])) || JSON.stringify(saved.coverage.missing.map(item => [item?.start, item?.end])) !== JSON.stringify(state.coverage.missing.map(item => [item.start, item.end])) || Object.keys(saved.coverage).sort().join(',') !== 'complete,intervals,length,missing' || [...saved.coverage.intervals, ...saved.coverage.missing].some(item => !item || Object.keys(item).sort().join(',') !== 'end,start')) throw new Error('invalid stored context coverage');
  }
  return state;
}

async function loadCompletions(tx: Transaction, id: string, plan: ChunkPlan, input: ContextInput, state: ContextCheckpoint) {
  const rows = await tx.select({ chunkId: contentChunks.plannerChunkId, generation: chunkResults.generation, result: chunkResults.result }).from(chunkResults).innerJoin(contentChunks, eq(chunkResults.chunkId, contentChunks.id)).where(and(eq(contentChunks.planId, id), eq(chunkResults.purpose, purpose))).orderBy(contentChunks.ordinal);
  const completions = rows.map(row => ({ chunkId: row.chunkId!, evidence: row.result as ChunkEvidence[] }));
  if (rows.some(row => row.generation !== input.generation)) throw new Error('invalid stored evidence generation');
  validateCompletions(plan, input, completions);
  if (completions.length !== state.completedChunkIds.length || completions.some(item => !state.completedChunkIds.includes(item.chunkId)) || evidenceDigest(plan, completions) !== state.evidenceDigest) throw new Error('invalid stored evidence completion');
  return completions;
}

export class ContextStore {
  constructor(private readonly db: Database) {}

  // Both save and resume hold article -> task locks, matching task creation and
  // publication. Newer generations supersede even when terminal.
  private async fenced<T>(owner: ContextOwner, input: ContextInput, action: (tx: Transaction, id: string, plan: ChunkPlan) => Promise<T>): Promise<T | null> {
    const { id, plan } = planned(owner, input);
    return this.db.transaction(async tx => {
      const [article] = await tx.select().from(articles).where(eq(articles.id, input.article.id)).for('update');
      if (!article || article.contentRevision !== input.article.contentRevision || article.assignmentRevision !== owner.assignmentRevision) return null;
      const [task] = await tx.select().from(processingTasks).where(eq(processingTasks.id, owner.taskId)).for('update');
      if (!task || task.articleId !== article.id || task.action !== input.taskKind || task.generation !== input.generation || task.state !== 'running' || task.executionToken !== owner.executionToken || (input.scoreTargetId !== undefined && task.scoreTargetId !== input.scoreTargetId)) return null;
      const [newer] = await tx.select({ id: processingTasks.id }).from(processingTasks).where(and(eq(processingTasks.articleId, article.id), eq(processingTasks.action, task.action), task.scoreTargetId === null ? isNull(processingTasks.scoreTargetId) : eq(processingTasks.scoreTargetId, task.scoreTargetId), gt(processingTasks.generation, task.generation))).limit(1);
      if (newer) return null;
      const [content] = await tx.select().from(articleContents).where(eq(articleContents.articleId, article.id));
      if (!content || content.revision !== article.contentRevision || content.text !== input.article.content) return null;
      return action(tx, id, plan);
    });
  }

  async save(owner: ContextOwner, input: ContextInput, progress: ContextProgress, at: Date, completions: ChunkCompletion[] = []) {
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new RangeError('invalid timestamp');
    return this.fenced(owner, input, async (tx, id, plan) => {
      validateCompletions(plan, input, completions);
      const state = checkpoint(plan, progress, evidenceDigest(plan, completions));
      if (completions.length !== state.completedChunks || completions.some(item => !state.completedChunkIds.includes(item.chunkId))) throw new RangeError('completion evidence required');
      const inserted = await tx.insert(contextPlans).values({ id, taskId: owner.taskId, articleId: input.article.id, contentRevision: input.article.contentRevision, assignmentRevision: owner.assignmentRevision, generation: input.generation, taskKind: input.taskKind }).onConflictDoNothing().returning({ id: contextPlans.id });
      if (inserted.length) await tx.insert(contentChunks).values(plan.chunks.map((chunk, ordinal) => ({ planId: id, plannerChunkId: chunk.id, articleId: input.article.id, contentRevision: input.article.contentRevision, ordinal, startOffset: chunk.start, endOffset: chunk.end, overlap: chunk.overlap, startSeconds: chunk.startSeconds, endSeconds: chunk.endSeconds, text: input.article.content.slice(chunk.start, chunk.end) })));
      const chunks = await verifyChunks(tx, id, plan, input, owner);
      const [previous] = await tx.select().from(contextCheckpoints).where(eq(contextCheckpoints.planId, id));
      let oldCompletions: ChunkCompletion[] = [];
      if (previous) {
        const saved = previous.state as ContextCheckpoint;
        if ((saved as { version?: unknown })?.version === 1) {
          if (state.reductionLevels.length) throw new RangeError('legacy checkpoint requires recomputation');
        } else {
          const oldState = validateState(plan, saved);
          oldCompletions = await loadCompletions(tx, id, plan, input, oldState);
          if (oldState.completedChunkIds.some(chunkId => !state.completedChunkIds.includes(chunkId))) throw new RangeError('cannot discard completed chunks');
          if (oldState.repairStartedChunkIds.some(chunkId => !state.repairStartedChunkIds.includes(chunkId))) throw new RangeError('cannot discard repair markers');
          if (oldState.evidenceDigest !== state.evidenceDigest && oldState.reductionLevels.length && state.reductionLevels.length) throw new RangeError('changed evidence requires reduction reset');
        }
      }
      const oldById = new Map(oldCompletions.map(completion => [completion.chunkId, completion]));
      for (const completion of completions) {
        if (isDeepStrictEqual(oldById.get(completion.chunkId), completion)) continue;
        const chunk = chunks.find(row => row.plannerChunkId === completion.chunkId)!;
        await tx.insert(chunkResults).values({ chunkId: chunk.id, generation: input.generation, purpose, result: completion.evidence, completedAt: at }).onConflictDoUpdate({ target: [chunkResults.chunkId, chunkResults.generation, chunkResults.purpose], set: { result: completion.evidence, completedAt: at } });
      }
      await tx.insert(contextCheckpoints).values({ planId: id, state, updatedAt: at }).onConflictDoUpdate({ target: contextCheckpoints.planId, set: { state, updatedAt: at } });
      await loadCompletions(tx, id, plan, input, state);
      return { planId: id, state, completions: [...completions].sort((a, b) => plan.chunks.findIndex(chunk => chunk.id === a.chunkId) - plan.chunks.findIndex(chunk => chunk.id === b.chunkId)) };
    });
  }

  // The article/task locks serialize claimers, including concurrent invocations
  // with the same execution token. Never clear a claim, even on non-admission.
  async claimRepair(owner: ContextOwner, input: ContextInput, chunkId: string, at: Date) {
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new RangeError('invalid timestamp');
    return this.fenced(owner, input, async (tx, id, plan) => {
      const [row] = await tx.select().from(contextCheckpoints).where(eq(contextCheckpoints.planId, id));
      if (!row) throw new Error('missing context checkpoint');
      await verifyChunks(tx, id, plan, input, owner);
      const state = validateState(plan, row.state as ContextCheckpoint);
      const completions = await loadCompletions(tx, id, plan, input, state);
      if (!plan.chunks.some(chunk => chunk.id === chunkId)) throw new RangeError('invalid repair chunk');
      if (state.completedChunkIds.includes(chunkId) || state.repairStartedChunkIds.includes(chunkId)) return null;
      const next = checkpoint(plan, { completedChunkIds: state.completedChunkIds, reductionLevels: state.reductionLevels, repairStartedChunkIds: [...state.repairStartedChunkIds, chunkId] }, state.evidenceDigest);
      await tx.update(contextCheckpoints).set({ state: next, updatedAt: at }).where(eq(contextCheckpoints.planId, id));
      return { planId: id, state: next, completions };
    });
  }

  async resume(owner: ContextOwner, input: ContextInput) {
    return this.fenced(owner, input, async (tx, id, plan) => {
      const [row] = await tx.select().from(contextCheckpoints).where(eq(contextCheckpoints.planId, id));
      if (!row) return null;
      await verifyChunks(tx, id, plan, input, owner);
      const saved = row.state as ContextCheckpoint;
      // v1 completion bits have no associated validated evidence and cannot resume.
      if ((saved as { version?: unknown })?.version === 1) return null;
      const state = validateState(plan, saved);
      const completions = await loadCompletions(tx, id, plan, input, state);
      return { planId: id, state, completions };
    });
  }
}
