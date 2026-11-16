import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ContextStore } from '../../src/server/adapters/postgres/context-store.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { processContextChunks, type ScoreContextTask } from '../../src/server/application/process-context-chunks.js';
import type { AiPort } from '../../src/server/ports/ai.js';
import { createUsageDatabase } from '../helpers/usage-database.js';

const countTokens = (text: string) => Buffer.byteLength(text);
const classifier = { model: { provider: 'fixture', model: 'classify' }, limits: { contextTokens: 600, outputTokens: 20, framingTokens: 10 }, countTokens };
const generator = { model: { provider: 'fixture', model: 'generate' }, limits: { contextTokens: 750, outputTokens: 20, framingTokens: 10 }, countTokens };
const success = { kind: 'completed' as const, value: { text: '{"items":[{"questionIndex":0,"polarity":"support","text":"evidence","quotes":["abc"]}]}', usage: null } };

async function seed(db: Awaited<ReturnType<typeof createUsageDatabase>>): Promise<ScoreContextTask> {
  const context = (await db.pool.query("insert into import_contexts(instance,account) values ('recovery','account') returning id")).rows[0].id as string;
  const article = (await db.pool.query("insert into articles(context_id,freshrss_id,imported_at,content_revision,assignment_revision) values ($1,'article',now(),1,2) returning id", [context])).rows[0].id as string;
  const content = Array.from({ length: 180 }, (_, i) => `abc ${i} `).join(''), token = randomUUID(), score = randomUUID();
  await db.pool.query("insert into article_contents(article_id,revision,text,quality,captured_at) values ($1,1,$2,'usable',now())", [article, content]);
  const id = (await db.pool.query("insert into processing_tasks(article_id,action,score_target_id,generation,execution_token,state,created_at,updated_at) values ($1,'scores',$2,1,$3,'running',now(),now()) returning id", [article, score, token])).rows[0].id as string;
  return { owner: { taskId: id, executionToken: token, assignmentRevision: 2, catalogEpoch: 0 }, scoreId: score, prompt: 'relevance?', article: { id: article, contentRevision: 1, title: 'title', content, category: 'excluded', tagWeights: [], sourceWeight: null }, fields: { includeTitle: true, includeContent: true, includeCategory: false, includeTagWeights: false, includeSourceWeight: false }, generation: 1, classifier, generator, signal: new AbortController().signal };
}
function fake() {
  return { classify: vi.fn<AiPort['classify']>(), generate: vi.fn<AiPort['generate']>(), createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() };
}

describe('score evidence recovery', () => {
  it.each(['text', 'quote'] as const)('repairs JSONB-incompatible NUL in evidence %s before saving', async field => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const task = await seed(db), store = new ContextStore(db.db), ai = fake();
      const item = { questionIndex: 0, polarity: 'support', text: field === 'text' ? 'bad\0text' : 'evidence', quotes: [field === 'quote' ? 'abc\0' : 'abc'] };
      ai.generate.mockResolvedValueOnce({ kind: 'completed', value: { text: JSON.stringify({ items: [item] }), usage: null } }).mockResolvedValue(success);
      const result = await processContextChunks(task, ai, store);
      expect(result).toMatchObject({ kind: 'evidence_ready', progress: { coverage: { complete: true }, repairStartedChunkIds: [expect.any(String)] } });
      expect(ai.generate.mock.calls[1]![0].system).toContain('Repair evidence');
      expect((await db.pool.query('select count(*)::int n from chunk_results')).rows[0].n).toBeGreaterThan(0);
    } finally { await db.dispose(); }
  }, 30000);

  it.each(['\ud800', '\udfff'] as const)('durably repairs lone surrogate evidence before PostgreSQL storage', async bad => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const task = await seed(db), store = new ContextStore(db.db), ai = fake();
      ai.generate.mockResolvedValueOnce({ kind: 'completed', value: { text: JSON.stringify({ items: [{ questionIndex: 0, polarity: 'support', text: `bad${bad}`, quotes: ['abc'] }] }), usage: null } }).mockResolvedValueOnce(success).mockResolvedValue({ kind: 'paused_auth' });
      const first = await processContextChunks(task, ai, store);
      expect(first).toMatchObject({ kind: 'paused_auth', progress: { completedChunks: 1, repairStartedChunkIds: [expect.any(String)] } });
      expect(ai.generate.mock.calls[1]![0].system).toContain('Repair evidence');
      const state = (await db.pool.query('select state from context_checkpoints')).rows[0].state;
      expect(state.repairStartedChunkIds).toEqual(state.completedChunkIds);
      expect((await db.pool.query('select result from chunk_results')).rows[0].result[0].text).toBe('evidence');
      const token = randomUUID();
      await db.pool.query('update processing_tasks set execution_token=$2 where id=$1', [task.owner.taskId, token]);
      ai.generate.mockResolvedValue(success);
      const before = ai.generate.mock.calls.length;
      const resumed = await processContextChunks({ ...task, owner: { ...task.owner, executionToken: token } }, ai, store);
      expect(resumed).toMatchObject({ kind: 'evidence_ready', progress: { coverage: { complete: true }, repairStartedChunkIds: state.repairStartedChunkIds } });
      expect(ai.generate.mock.calls.slice(before).every(([request]) => !request.system.startsWith('Repair'))).toBe(true);
    } finally { await db.dispose(); }
  }, 30000);

  it.each(['\0', '\ud800', '\udfff'] as const)('does not retry again when repaired evidence still contains invalid text %s', async bad => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const task = await seed(db), store = new ContextStore(db.db), ai = fake();
      ai.generate.mockResolvedValue({ kind: 'completed', value: { text: JSON.stringify({ items: [{ questionIndex: 0, polarity: 'support', text: `bad${bad}text`, quotes: ['abc'] }] }), usage: null } });
      await expect(processContextChunks(task, ai, store)).rejects.toThrow('invalid evidence item');
      expect(ai.generate).toHaveBeenCalledTimes(2);
      expect((await db.pool.query('select count(*)::int n from chunk_results')).rows[0].n).toBe(0);
      await expect(processContextChunks(task, ai, store)).rejects.toThrow('repair opportunity already consumed');
      expect(ai.generate).toHaveBeenCalledTimes(2);
    } finally { await db.dispose(); }
  }, 30000);

  it.each([{ kind: 'paused_budget' as const, reason: 'daily_limit' as const }, { kind: 'paused_auth' as const }, { kind: 'paused_configuration' as const }])('retains evidence on $kind and generates only unfinished chunks', async pause => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const task = await seed(db), store = new ContextStore(db.db), ai = fake();
      ai.generate.mockResolvedValueOnce(success).mockResolvedValueOnce(pause).mockResolvedValue(success);
      const first = await processContextChunks(task, ai, store);
      expect(first).toMatchObject({ kind: pause.kind, progress: { completedChunks: 1, coverage: { complete: false } } });
      const firstRequest = ai.generate.mock.calls[0]![0];
      const secondRequest = ai.generate.mock.calls[1]![0];
      const resumed = await processContextChunks(task, ai, store);
      expect(resumed).toMatchObject({ kind: 'evidence_ready', progress: { coverage: { complete: true } } });
      expect(ai.generate.mock.calls[2]![0]).toEqual(secondRequest);
      expect(ai.generate.mock.calls.slice(2).map(call => call[0])).not.toContainEqual(firstRequest);
      for (const [, scope] of ai.generate.mock.calls) expect(scope).toEqual({ bucket: 'automatic', taskId: task.owner.taskId, signal: task.signal });
      expect(ai.classify).not.toHaveBeenCalled();
    } finally { await db.dispose(); }
  }, 30000);

  it('fails closed after a marker commits and ownership is reacquired before dispatch', async () => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const task = await seed(db), store = new ContextStore(db.db), ai = fake();
      ai.generate.mockResolvedValue({ kind: 'completed', value: { text: 'invalid', usage: null } });
      let claimArgs: Parameters<ContextStore['claimRepair']> | undefined;
      const crashing = { resume: store.resume.bind(store), save: store.save.bind(store), claimRepair: async (...args: Parameters<ContextStore['claimRepair']>) => { claimArgs = args; await store.claimRepair(...args); throw new Error('simulated crash'); } };
      await expect(processContextChunks(task, ai, crashing)).rejects.toThrow('simulated crash');
      expect(ai.generate).toHaveBeenCalledOnce();
      const state = (await db.pool.query('select state from context_checkpoints')).rows[0].state;
      expect(state).toMatchObject({ version: 3, completedChunks: 0, repairStartedChunkIds: [expect.any(String)] });
      if (!claimArgs) throw new Error('missing claim');
      await expect(store.save(claimArgs[0], claimArgs[1], { completedChunkIds: [], reductionLevels: [] }, new Date())).rejects.toThrow(/cannot discard repair markers/);
      await db.pool.query("update context_checkpoints set state=state - 'repairStartedChunkIds'");
      await expect(store.resume(claimArgs[0], claimArgs[1])).rejects.toThrow(/invalid stored context checkpoint/);
      await db.pool.query('update context_checkpoints set state=$1', [JSON.stringify(state)]);
      const token = randomUUID();
      await db.pool.query('update processing_tasks set execution_token=$2 where id=$1', [task.owner.taskId, token]);
      await expect(processContextChunks({ ...task, owner: { ...task.owner, executionToken: token } }, ai, store)).rejects.toThrow(/repair opportunity/);
      expect(ai.generate).toHaveBeenCalledOnce();
    } finally { await db.dispose(); }
  }, 30000);

  it('persists repaired evidence and its marker across ownership changes', async () => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const task = await seed(db), store = new ContextStore(db.db), ai = fake();
      ai.generate.mockResolvedValueOnce({ kind: 'completed', value: { text: 'invalid', usage: null } }).mockResolvedValueOnce(success).mockResolvedValue({ kind: 'paused_budget', reason: 'daily_limit' });
      const first = await processContextChunks(task, ai, store);
      expect(first).toMatchObject({ kind: 'paused_budget', progress: { completedChunks: 1, repairStartedChunkIds: [expect.any(String)] } });
      if (first.kind !== 'paused_budget' || !('progress' in first)) throw new Error('expected evidence pause');
      expect(first.progress.repairStartedChunkIds[0]).toBe(first.progress.completedChunkIds[0]);
      const token = randomUUID();
      await db.pool.query('update processing_tasks set execution_token=$2 where id=$1', [task.owner.taskId, token]);
      ai.generate.mockResolvedValue(success);
      const before = ai.generate.mock.calls.length;
      const resumed = await processContextChunks({ ...task, owner: { ...task.owner, executionToken: token } }, ai, store);
      expect(resumed).toMatchObject({ kind: 'evidence_ready', progress: { repairStartedChunkIds: first.progress.repairStartedChunkIds, coverage: { complete: true } } });
      expect(ai.generate.mock.calls.slice(before).every(([request]) => !request.system.startsWith('Repair'))).toBe(true);
      const state = (await db.pool.query('select state from context_checkpoints')).rows[0].state;
      expect(state.repairStartedChunkIds).toEqual(first.progress.repairStartedChunkIds);
    } finally { await db.dispose(); }
  }, 30000);

  it('serializes concurrent repair claims with the same owner', async () => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const task = await seed(db), store = new ContextStore(db.db), ai = fake();
      let initialCalls = 0;
      let release!: () => void;
      const both = new Promise<void>(resolve => { release = resolve; });
      ai.generate.mockImplementation(async request => {
        if (request.system.startsWith('Repair')) return { kind: 'completed', value: { text: '{"items":[]}', usage: null } };
        if (++initialCalls > 2) return { kind: 'paused_auth' };
        if (initialCalls === 2) release();
        await both;
        return { kind: 'completed', value: { text: 'invalid', usage: null } };
      });
      const results = await Promise.allSettled([processContextChunks(task, ai, store), processContextChunks(task, ai, store)]);
      expect(results.some(result => result.status === 'rejected')).toBe(true);
      expect(ai.generate.mock.calls.filter(([request]) => request.system.startsWith('Repair'))).toHaveLength(1);
    } finally { await db.dispose(); }
  }, 30000);

  it('rejects stale basis, token and target; newer generation does not reuse evidence', async () => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const task = await seed(db), store = new ContextStore(db.db), ai = fake();
      ai.generate.mockResolvedValueOnce(success).mockResolvedValue({ kind: 'paused_auth' });
      expect(await processContextChunks(task, ai, store)).toMatchObject({ kind: 'paused_auth', progress: { completedChunks: 1 } });
      const beforeChangedPrompt = ai.generate.mock.calls.length;
      expect(await processContextChunks({ ...task, prompt: 'other score question' }, ai, store)).toMatchObject({ kind: 'paused_auth', progress: { completedChunks: 0 } });
      expect(ai.generate).toHaveBeenCalledTimes(beforeChangedPrompt + 1);
      for (const stale of [{ ...task, owner: { ...task.owner, executionToken: randomUUID() } }, { ...task, owner: { ...task.owner, assignmentRevision: 3 } }, { ...task, scoreId: randomUUID() }, { ...task, article: { ...task.article, contentRevision: 2 } }, { ...task, article: { ...task.article, content: task.article.content + 'abc' } }]) {
        const calls = ai.generate.mock.calls.length;
        await expect(processContextChunks(stale, ai, store)).rejects.toThrow(/stale/);
        expect(ai.generate).toHaveBeenCalledTimes(calls);
      }
      const token = randomUUID();
      await db.pool.query("update processing_tasks set state='superseded' where id=$1", [task.owner.taskId]);
      const nextId = (await db.pool.query("insert into processing_tasks(article_id,action,score_target_id,generation,execution_token,state,created_at,updated_at) values ($1,'scores',$2,2,$3,'running',now(),now()) returning id", [task.article.id, task.scoreId, token])).rows[0].id as string;
      const next = { ...task, generation: 2, owner: { ...task.owner, taskId: nextId, executionToken: token } };
      const calls = ai.generate.mock.calls.length;
      expect(await processContextChunks(next, ai, store)).toMatchObject({ kind: 'paused_auth', progress: { completedChunks: 0 } });
      expect(ai.generate).toHaveBeenCalledTimes(calls + 1);
      await expect(processContextChunks(task, ai, store)).rejects.toThrow(/stale/);
    } finally { await db.dispose(); }
  }, 30000);
});
