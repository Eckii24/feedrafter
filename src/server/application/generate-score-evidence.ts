import type { ChunkCompletion, ContextStore } from '../adapters/postgres/context-store.js';
import type { AiPort, GenerationRequest, JsonObject } from '../ports/ai.js';
import { isPostgresJsonText } from '../domain/postgres-json-text.js';
import { prepareContext, type ContextChunk, type ContextInput } from './prepare-context.js';
import type { ScoreContextTask } from './process-context-chunks.js';
import { UsageAttemptError } from './usage.js';
import { measureRequest, requestPlannerLimits } from './score-context-request.js';

const system = 'Extract evidence for the score question from the selected context. Return only JSON: {"items":[{"questionIndex":0,"polarity":"support|counter|uncertain","text":"compact evidence","quotes":["verbatim source quote"]}]}. Use only verbatim quotes from context.content. Return an empty items array if none. Do not report coverage or a score.';
type Store = Pick<ContextStore, 'save' | 'resume' | 'claimRepair'>;

function parseEvidence(text: string, chunk: ContextChunk): ChunkCompletion {
  if (Buffer.byteLength(text) > 500000) throw new RangeError('invalid evidence output size');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new RangeError('invalid evidence JSON'); }
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const keys = (v: Record<string, unknown>, expected: string) => Object.keys(v).sort().join(',') === expected;
  if (!object(value) || !keys(value, 'items') || !Array.isArray(value.items) || value.items.length > 32) throw new RangeError('invalid evidence output');
  const content = chunk.request.context.content!;
  const boundary = (i: number) => i <= 0 || i >= content.length || !(content.charCodeAt(i - 1) >= 0xd800 && content.charCodeAt(i - 1) <= 0xdbff && content.charCodeAt(i) >= 0xdc00 && content.charCodeAt(i) <= 0xdfff);
  const evidence = value.items.map((item: unknown) => {
    if (!object(item) || !keys(item, 'polarity,questionIndex,quotes,text') || item.questionIndex !== 0 || (item.polarity !== 'support' && item.polarity !== 'counter' && item.polarity !== 'uncertain') || typeof item.text !== 'string' || !item.text.trim() || !isPostgresJsonText(item.text) || Buffer.byteLength(item.text) > 16384 || !Array.isArray(item.quotes) || !item.quotes.length || item.quotes.length > 16) throw new RangeError('invalid evidence item');
    const refs = item.quotes.map((quote: unknown) => {
      if (typeof quote !== 'string' || !quote.length || !isPostgresJsonText(quote) || Buffer.byteLength(quote) > 16384) throw new RangeError('invalid evidence quote');
      const start = content.indexOf(quote);
      if (start < 0 || !boundary(start) || !boundary(start + quote.length)) throw new RangeError('unmatched evidence quote');
      return { chunkId: chunk.id, start: chunk.start + start, end: chunk.start + start + quote.length, quote };
    });
    return { questionId: '0', polarity: item.polarity as 'support' | 'counter' | 'uncertain', text: item.text, refs };
  });
  return { chunkId: chunk.id, evidence };
}

/** Unwired evidence stage. No reduction, final classification or publication. */
export async function generateScoreEvidence(task: ScoreContextTask, ai: AiPort, store: Store) {
  const requestFor = (context: JsonObject): GenerationRequest => ({ model: task.generator.model, role: 'context_reduction', system, user: JSON.stringify({ question: task.prompt, context }) });
  const tokenizer = (serialized: string) => {
    const envelope = JSON.parse(serialized) as { context: JsonObject };
    return measureRequest(task.generator, requestFor(envelope.context)).inputTokens;
  };
  const input: ContextInput = { taskKind: 'scores', scoreTargetId: task.scoreId, fields: task.fields, article: task.article, generation: task.generation, prompt: task.prompt, questions: [task.prompt], tools: JSON.stringify({ model: task.generator.model, system, scoreId: task.scoreId }), limits: requestPlannerLimits(task.generator), tokenizer, sizing: 'kind' in task.generator ? 'utf8-bytes' : 'provider', forceChunks: true };
  const plan = prepareContext(input);
  if (plan.kind !== 'chunks') throw new Error('expected evidence chunks');
  let saved = await store.resume(task.owner, input);
  if (!saved) saved = await store.save(task.owner, input, { completedChunkIds: [], reductionLevels: [] }, new Date(), []);
  if (!saved) throw new Error('stale context task');
  for (const chunk of plan.chunks) {
    if (saved.state.completedChunkIds.includes(chunk.id)) continue;
    if (saved.state.repairStartedChunkIds.includes(chunk.id)) throw new Error('repair opportunity already consumed for incomplete chunk');
    const request = requestFor(chunk.request.context as JsonObject);
    const measured = measureRequest(task.generator, request);
    if (measured.inputTokens !== chunk.inputTokens || !measured.fits) throw new RangeError(`generator request exceeds ${'kind' in task.generator ? 'unverified local' : 'verified'} limits`);
    let outcome;
    try { outcome = await ai.generate(request, { bucket: 'automatic', taskId: task.owner.taskId, signal: task.signal }); }
    catch (error) { if (error instanceof UsageAttemptError && error.kind === 'auth') return { kind: 'paused_auth' as const, progress: saved.state }; throw error; }
    if (outcome.kind !== 'completed') return { ...outcome, progress: saved.state };
    let completion: ChunkCompletion;
    try { completion = parseEvidence(outcome.value.text, chunk); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      const repair: GenerationRequest = { ...request, system: system.replace('Extract evidence', 'Repair evidence') };
      if (!measureRequest(task.generator, repair).fits) throw new RangeError(`repair request exceeds ${'kind' in task.generator ? 'unverified local' : 'verified'} limits`, { cause: error });
      const claimed = await store.claimRepair(task.owner, input, chunk.id, new Date());
      if (!claimed) throw new Error('repair opportunity already consumed or stale context task', { cause: error });
      saved = claimed;
      // Admitted UsageAttemptError stays an error, distinct from a pre-admission pause.
      const repaired = await ai.generate(repair, { bucket: 'automatic', taskId: task.owner.taskId, signal: task.signal });
      // A pause is non-admission, but the durable marker remains consumed: a
      // crash cannot distinguish the interval before dispatch from after it.
      if (repaired.kind !== 'completed') return { ...repaired, progress: saved.state };
      completion = parseEvidence(repaired.value.text, chunk);
    }
    const completions = [...saved.completions, completion];
    const next = await store.save(task.owner, input, { completedChunkIds: completions.map(item => item.chunkId), repairStartedChunkIds: saved.state.repairStartedChunkIds, reductionLevels: [] }, new Date(), completions);
    if (!next) throw new Error('stale context task');
    saved = next;
  }
  return { kind: 'evidence_ready' as const, progress: saved.state, completions: saved.completions };
}
