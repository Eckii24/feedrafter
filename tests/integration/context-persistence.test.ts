import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ContextStore } from '../../src/server/adapters/postgres/context-store.js';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { prepareContext, type ContextInput } from '../../src/server/application/prepare-context.js';
import { buildHttpApp } from '../../src/server/http/app.js';

const seed = async (database: Awaited<ReturnType<typeof createUsageDatabase>>) => {
  const context = (await database.pool.query("insert into import_contexts(instance,account) values ('context','account') returning id")).rows[0].id as string;
  const article = (await database.pool.query("insert into articles(context_id,freshrss_id,imported_at,content_revision,assignment_revision) values ($1,'article',now(),1,2) returning id", [context])).rows[0].id as string;
  const content = 'abcde'.repeat(150);
  await database.pool.query("insert into article_contents(article_id,revision,text,quality,captured_at) values ($1,1,$2,'usable',now())", [article, content]);
  const token = randomUUID();
  const task = (await database.pool.query("insert into processing_tasks(article_id,action,generation,execution_token,state,created_at,updated_at) values ($1,'scores',1,$2,'running',now(),now()) returning id", [article, token])).rows[0].id as string;
  const input: ContextInput = { taskKind: 'scores', generation: 1, fields: { includeTitle: true, includeContent: true, includeCategory: false, includeTagWeights: false, includeSourceWeight: false }, article: { id: article, contentRevision: 1, title: 'title', content, category: null, tagWeights: [], sourceWeight: null }, prompt: 'score', questions: ['why'], tools: '{}', limits: { contextTokens: 180, outputTokens: 20, framingTokens: 10 } };
  return { article, task, token, input, owner: { taskId: task, executionToken: token, assignmentRevision: 2 } };
};

describe('context persistence', () => {
  it('upgrades 0006 with legacy chunks, scores and tasks intact and readiness tracks migration', async () => {
    const db = await createUsageDatabase();
    const folder = await mkdtemp(join(tmpdir(), 'context-old-'));
    const app = await buildHttpApp({ db: db.db, pool: db.pool, origin: 'http://localhost:3000', trustedProxies: [] });
    try {
      await mkdir(join(folder, 'meta'));
      const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')) as { entries: { tag: string }[] };
      journal.entries = journal.entries.slice(0, 7);
      await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
      for (const entry of journal.entries) await copyFile(`drizzle/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`));
      await migrateDatabase(db.pool, folder);
      const ready = async () => (await app.inject({ url: '/api/v1/health/ready', headers: { host: 'localhost:3000' } })).statusCode;
      expect(await ready()).toBe(503);
      const fixture = await seed(db);
      await db.pool.query("insert into content_chunks(article_id,content_revision,ordinal,start_offset,end_offset,text) values ($1,1,0,0,3,'abc')", [fixture.article]);
      await db.pool.query("insert into article_scores(article_id,score_id,value,calculated_at,content_revision,assignment_revision) values ($1,'10000000-0000-4000-8000-000000000001',42,now(),1,2)", [fixture.article]);
      const before = await Promise.all(['content_chunks', 'article_scores', 'processing_tasks'].map(table => db.pool.query(`select * from ${table}`)));
      await migrateDatabase(db.pool);
      expect(await ready()).toBe(200);
      const legacy = (await db.pool.query('select id,article_id,content_revision,ordinal,start_offset,end_offset,text from content_chunks')).rows;
      expect(legacy).toEqual(before[0]!.rows);
      expect((await db.pool.query('select * from article_scores')).rows).toEqual(before[1]!.rows);
      expect((await db.pool.query('select * from processing_tasks')).rows).toEqual(before[2]!.rows);
      expect(await new ContentStore(db.db).listChunks(fixture.article, 1)).toHaveLength(1);
      await expect(db.pool.query("insert into content_chunks(article_id,content_revision,ordinal,start_offset,end_offset,text) values ($1,1,0,0,3,'abc')", [fixture.article])).rejects.toThrow();
      await migrateDatabase(db.pool);
      expect((await db.pool.query('select count(*)::int n from drizzle.__drizzle_migrations')).rows[0].n).toBe(10);
    } finally { await app.close(); await rm(folder, { recursive: true, force: true }); await db.dispose(); }
  }, 30000);

  it('persists exact planner identities and resumes only with live matching basis and generation', async () => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const { article, task, token, input, owner } = await seed(db);
      const plan = prepareContext(input);
      if (plan.kind !== 'chunks') throw new Error('expected chunks');
      const store = new ContextStore(db.db);
      const first = await store.save(owner, input, { completedChunkIds: [plan.chunks[0]!.id], reductionLevels: [] }, new Date(), [{ chunkId: plan.chunks[0]!.id, evidence: [] }]);
      expect(first?.state).toMatchObject({ version: 3, repairStartedChunkIds: [], totalChunks: plan.chunks.length, completedChunks: 1, coverage: { complete: false } });
      const rows = (await db.pool.query('select id,planner_chunk_id,ordinal,start_offset,end_offset,text from content_chunks where plan_id=$1 order by ordinal', [first!.planId])).rows;
      expect(rows.map(row => [row.planner_chunk_id, row.ordinal, row.start_offset, row.end_offset, row.text])).toEqual(plan.chunks.map((chunk, i) => [chunk.id, i, chunk.start, chunk.end, input.article.content.slice(chunk.start, chunk.end)]));
      expect(rows[0]!.id).not.toBe(plan.chunks[0]!.id);
      const progress = { completedChunkIds: plan.chunks.map(chunk => chunk.id), reductionLevels: [{ level: 1, evidence: ['bounded evidence'] }] };
      const saved = await store.save(owner, input, progress, new Date(), plan.chunks.map(chunk => ({ chunkId: chunk.id, evidence: [] })));
      expect(saved?.state.coverage).toEqual({ length: input.article.content.length, intervals: [{ start: 0, end: input.article.content.length }], missing: [], complete: true });
      expect(await store.resume(owner, input)).toEqual(saved);
      await expect(store.save(owner, input, { completedChunkIds: ['not-a-chunk'], reductionLevels: [] }, new Date())).rejects.toThrow(/invalid completed/);
      await expect(store.save(owner, input, { completedChunkIds: [], reductionLevels: [{ level: 1, evidence: ['x'.repeat(65537)] }] }, new Date())).rejects.toThrow(/invalid reduction/);
      for (const bad of ['bad\0text', 'bad\ud800', 'bad\udfff']) await expect(store.save(owner, input, { completedChunkIds: [], reductionLevels: [{ level: 1, evidence: [bad] }] }, new Date())).rejects.toThrow(/invalid reduction/);
      expect(await store.resume(owner, input)).toEqual(saved);
      await db.pool.query("update context_checkpoints set state=jsonb_set(state,'{version}','4') where plan_id=$1", [first!.planId]);
      await expect(store.resume(owner, input)).rejects.toThrow(/invalid stored context checkpoint/);
      await db.pool.query('update context_checkpoints set state=$2 where plan_id=$1', [first!.planId, JSON.stringify(saved!.state)]);
      expect(await store.resume(owner, input)).toEqual(saved);
      await db.pool.query("update context_checkpoints set state=jsonb_set(state - 'repairStartedChunkIds','{version}','2') where plan_id=$1", [first!.planId]);
      expect(await store.resume(owner, input)).toEqual(saved);
      await db.pool.query("update context_checkpoints set state=state || '{\"unexpected\":true}'::jsonb where plan_id=$1", [first!.planId]);
      await expect(store.resume(owner, input)).rejects.toThrow(/invalid stored context checkpoint/);
      await db.pool.query('update context_checkpoints set state=$2 where plan_id=$1', [first!.planId, JSON.stringify(saved!.state)]);
      const changedInput = { ...input, prompt: 'different' };
      expect(await store.resume(owner, changedInput)).toBeNull();
      const other = await store.save(owner, changedInput, { completedChunkIds: [], reductionLevels: [] }, new Date());
      expect(other!.planId).not.toBe(first!.planId);
      expect((await db.pool.query('select count(*)::int n from content_chunks where article_id=$1 and content_revision=1 and ordinal=0', [article])).rows[0].n).toBe(2);
      await expect(db.pool.query("insert into content_chunks(article_id,content_revision,ordinal,start_offset,end_offset,text,plan_id,planner_chunk_id,overlap) select article_id,content_revision,ordinal,start_offset,end_offset,text,plan_id,repeat('f',64),overlap from content_chunks where plan_id=$1 limit 1", [first!.planId])).rejects.toThrow();
      await expect(db.pool.query('insert into content_chunks(article_id,content_revision,ordinal,start_offset,end_offset,text,plan_id,planner_chunk_id,overlap) select article_id,content_revision,999999,start_offset,end_offset,text,plan_id,planner_chunk_id,overlap from content_chunks where plan_id=$1 limit 1', [first!.planId])).rejects.toThrow();
      const nextToken = randomUUID();
      const nextTask = (await db.pool.query("insert into processing_tasks(article_id,action,generation,state,execution_token,created_at,updated_at) values ($1,'scores',2,'running',$2,now(),now()) returning id", [article, nextToken])).rows[0].id as string;
      const next = await store.save({ taskId: nextTask, executionToken: nextToken, assignmentRevision: 2 }, { ...input, generation: 2 }, { completedChunkIds: [], reductionLevels: [] }, new Date());
      expect(next!.planId).not.toBe(first!.planId);
      expect((await db.pool.query('select count(*)::int n from content_chunks where article_id=$1 and content_revision=1 and ordinal=0', [article])).rows[0].n).toBe(3);
      expect(await store.resume(owner, input)).toBeNull();
      await db.pool.query('delete from processing_tasks where id=$1', [nextTask]);
      const allCompletions = plan.chunks.map(chunk => ({ chunkId: chunk.id, evidence: [] }));
      expect(await store.save({ ...owner, executionToken: randomUUID() }, input, progress, new Date(), allCompletions)).toBeNull();
      await db.pool.query('update articles set assignment_revision=3 where id=$1', [article]);
      expect(await store.resume(owner, input)).toBeNull();
      expect(await store.save(owner, input, progress, new Date(), allCompletions)).toBeNull();
      await db.pool.query('update articles set assignment_revision=2,content_revision=2 where id=$1', [article]);
      expect(await store.save(owner, input, progress, new Date(), allCompletions)).toBeNull();
      await db.pool.query('update articles set content_revision=1 where id=$1', [article]);
      expect(await store.save(owner, { ...input, generation: 2 }, progress, new Date(), allCompletions)).toBeNull();
      await db.pool.query("insert into processing_tasks(article_id,action,generation,state,created_at,updated_at) values ($1,'scores',2,'failed',now(),now())", [article]);
      expect(await store.resume(owner, input)).toBeNull();
      expect(await store.save(owner, input, progress, new Date(), allCompletions)).toBeNull();
      await db.pool.query("delete from processing_tasks where article_id=$1 and generation=2", [article]);
      await db.pool.query("update processing_tasks set state='paused_budget' where id=$1", [task]);
      expect(await store.resume(owner, input)).toBeNull();
      const resumedToken = randomUUID();
      await db.pool.query("update processing_tasks set state='running', execution_token=$2 where id=$1", [task, resumedToken]);
      expect(await store.resume({ ...owner, executionToken: token }, input)).toBeNull();
      expect(await store.resume({ ...owner, executionToken: resumedToken }, input)).toEqual(saved);
    } finally { await db.dispose(); }
  }, 30000);

  it('writes only new or changed completions across incremental checkpoints', async () => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const { input, owner } = await seed(db);
      const plan = prepareContext(input);
      if (plan.kind !== 'chunks' || plan.chunks.length < 3) throw new Error('expected multiple chunks');
      await db.pool.query('create table completion_write_log (operation text not null)');
      await db.pool.query(`create function log_completion_write() returns trigger language plpgsql as $$ begin insert into completion_write_log values (TG_OP); return NEW; end $$`);
      await db.pool.query('create trigger completion_write after insert or update on chunk_results for each row execute function log_completion_write()');
      const store = new ContextStore(db.db);
      const completions = plan.chunks.map(chunk => ({ chunkId: chunk.id, evidence: [] }));
      for (let count = 1; count <= completions.length; count++) {
        const prefix = completions.slice(0, count);
        await store.save(owner, input, { completedChunkIds: prefix.map(item => item.chunkId), reductionLevels: [] }, new Date(), prefix);
      }
      const writes = (await db.pool.query('select operation from completion_write_log')).rows;
      expect(writes).toHaveLength(completions.length);
      expect(writes.every(row => row.operation === 'INSERT')).toBe(true);
      expect((await store.resume(owner, input))?.completions).toEqual(completions);
      const chunk = plan.chunks[0]!;
      const changed = [{ chunkId: chunk.id, evidence: [{ questionId: '0', polarity: 'counter' as const, text: 'changed', refs: [{ chunkId: chunk.id, start: chunk.start, end: chunk.start + 3, quote: input.article.content.slice(chunk.start, chunk.start + 3) }] }] }, ...completions.slice(1)];
      const progress = { completedChunkIds: changed.map(item => item.chunkId), reductionLevels: [] };
      await store.save(owner, input, progress, new Date(), changed);
      await store.save(owner, input, progress, new Date(), changed);
      expect((await db.pool.query('select operation from completion_write_log')).rows.map(row => row.operation)).toEqual([...writes.map(row => row.operation), 'UPDATE']);
      expect((await store.resume(owner, input))?.completions).toEqual(changed);
    } finally { await db.dispose(); }
  }, 30000);

  it('rechecks ownership after waiting for the article lock', async () => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const { article, task, input, owner } = await seed(db);
      const plan = prepareContext(input);
      if (plan.kind !== 'chunks') throw new Error('expected chunks');
      const blocker = await db.pool.connect();
      try {
        await blocker.query('begin');
        await blocker.query('select id from articles where id=$1 for update', [article]);
        const pending = new ContextStore(db.db).save(owner, input, { completedChunkIds: [plan.chunks[0]!.id], reductionLevels: [] }, new Date(), [{ chunkId: plan.chunks[0]!.id, evidence: [] }]);
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          const result = await db.pool.query("select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%from \"articles\"%for update%' and pid <> pg_backend_pid()");
          if (result.rowCount) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        await blocker.query('update processing_tasks set execution_token=$2 where id=$1', [task, randomUUID()]);
        await blocker.query('commit');
        expect(await pending).toBeNull();
        expect((await db.pool.query('select count(*)::int n from context_plans')).rows[0].n).toBe(0);
      } finally { await blocker.query('rollback'); blocker.release(); }
    } finally { await db.dispose(); }
  }, 30000);

  it('validates, upserts and reloads evidence bound to the original chunk UUID and checkpoint', async () => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const { input, owner } = await seed(db);
      const plan = prepareContext(input);
      if (plan.kind !== 'chunks') throw new Error('expected chunks');
      const chunk = plan.chunks[0]!;
      const store = new ContextStore(db.db);
      const progress = { completedChunkIds: [chunk.id], reductionLevels: [] };
      const evidence = [{ questionId: '0', polarity: 'support' as const, text: 'relevant point', refs: [{ chunkId: chunk.id, start: chunk.start, end: chunk.start + 3, quote: input.article.content.slice(chunk.start, chunk.start + 3) }] }];
      const completion = [{ chunkId: chunk.id, evidence }];
      await expect(store.save(owner, input, progress, new Date())).rejects.toThrow(/evidence required/);
      await expect(store.save(owner, input, { completedChunkIds: [], reductionLevels: [] }, new Date(), completion)).rejects.toThrow(/evidence required/);
      const saved = await store.save(owner, input, progress, new Date(), completion);
      const rows = (await db.pool.query('select r.chunk_id,c.planner_chunk_id,r.result from chunk_results r join content_chunks c on c.id=r.chunk_id where c.plan_id=$1', [saved!.planId])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ planner_chunk_id: chunk.id, result: evidence });
      expect(rows[0].chunk_id).not.toBe(chunk.id);
      expect(await store.resume(owner, input)).toEqual(saved);
      const replacement = [{ chunkId: chunk.id, evidence: [{ ...evidence[0]!, polarity: 'counter' as const }] }];
      const updated = await store.save(owner, input, progress, new Date(), replacement);
      expect(await store.resume(owner, input)).toEqual(updated);
      expect((await db.pool.query('select count(*)::int n from chunk_results')).rows[0].n).toBe(1);
      for (const bad of [
        { ...evidence[0]!, questionId: '1' },
        { ...evidence[0]!, text: 'x'.repeat(16385) },
        { ...evidence[0]!, text: 'bad\0text' },
        { ...evidence[0]!, text: 'bad\ud800' },
        { ...evidence[0]!, text: 'bad\udfff' },
        { ...evidence[0]!, refs: [] },
        { ...evidence[0]!, refs: [{ ...evidence[0]!.refs[0]!, quote: 'wrong' }] },
        { ...evidence[0]!, refs: [{ ...evidence[0]!.refs[0]!, start: chunk.start - 1 }] },
        { ...evidence[0]!, refs: [{ ...evidence[0]!.refs[0]!, end: chunk.end + 1 }] },
        { ...evidence[0]!, refs: [{ ...evidence[0]!.refs[0]!, chunkId: plan.chunks[1]!.id }] },
      ]) await expect(store.save(owner, input, progress, new Date(), [{ chunkId: chunk.id, evidence: [bad] }])).rejects.toThrow();
      await expect(store.save(owner, input, progress, new Date(), [completion[0]!, completion[0]!])).rejects.toThrow();
      expect(await store.resume(owner, input)).toEqual(updated);
      await db.pool.query("update context_checkpoints set state=jsonb_set(state,'{coverage,complete}','true') where plan_id=$1", [saved!.planId]);
      await expect(store.resume(owner, input)).rejects.toThrow(/coverage/);
      await db.pool.query('update context_checkpoints set state=$2 where plan_id=$1', [saved!.planId, JSON.stringify(updated!.state)]);
      await db.pool.query("update content_chunks set text='tampered' where id=$1", [rows[0].chunk_id]);
      await expect(store.resume(owner, input)).rejects.toThrow(/stored context chunks/);
      await db.pool.query('update content_chunks set text=$2 where id=$1', [rows[0].chunk_id, input.article.content.slice(chunk.start, chunk.end)]);
      const reducedProgress = { ...progress, reductionLevels: [{ level: 1, evidence: ['reduced 😀'] }] };
      const reduced = await store.save(owner, input, reducedProgress, new Date(), replacement);
      expect(await store.resume(owner, input)).toEqual(reduced);
      await expect(store.save(owner, input, reducedProgress, new Date(), completion)).rejects.toThrow(/reduction reset/);
      await store.save(owner, input, progress, new Date(), replacement);
      await db.pool.query("update chunk_results set result=jsonb_set(result,'{0,text}', '\"tampered\"') where chunk_id=$1", [rows[0].chunk_id]);
      await expect(store.resume(owner, input)).rejects.toThrow(/stored evidence/);
      await expect(store.save(owner, input, progress, new Date(), replacement)).rejects.toThrow(/stored evidence/);
      await db.pool.query('delete from chunk_results where chunk_id=$1', [rows[0].chunk_id]);
      await expect(store.resume(owner, input)).rejects.toThrow(/stored evidence/);
    } finally { await db.dispose(); }
  }, 30000);

  it('enforces UTF-16 boundaries and aggregate evidence and checkpoint limits', async () => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const fixture = await seed(db);
      const { article, owner } = fixture;
      const input = { ...fixture.input, article: { ...fixture.input.article, content: '😀' + fixture.input.article.content } };
      await db.pool.query('update article_contents set text=$2 where article_id=$1', [article, input.article.content]);
      const plan = prepareContext(input);
      if (plan.kind !== 'chunks') throw new Error('expected chunks');
      const chunk = plan.chunks[0]!;
      const progress = { completedChunkIds: [chunk.id], reductionLevels: [] };
      const evidence = { questionId: '0', polarity: 'uncertain' as const, text: 'emoji 😀', refs: [{ chunkId: chunk.id, start: 0, end: 2, quote: '😀' }] };
      const store = new ContextStore(db.db);
      const saved = await store.save(owner, input, progress, new Date(), [{ chunkId: chunk.id, evidence: [evidence] }]);
      await expect(store.save(owner, input, progress, new Date(), [{ chunkId: chunk.id, evidence: [{ ...evidence, refs: [{ ...evidence.refs[0]!, start: 1, quote: input.article.content.slice(1, 2) }] }] }])).rejects.toThrow(/reference/);
      await expect(store.save(owner, input, progress, new Date(), [{ chunkId: chunk.id, evidence: Array(33).fill(evidence) }])).rejects.toThrow(/completion/);
      await expect(store.save(owner, input, progress, new Date(), [{ chunkId: chunk.id, evidence: Array(32).fill({ ...evidence, text: 'x'.repeat(16000) }) }])).rejects.toThrow(/evidence size/);
      await expect(store.save(owner, input, { ...progress, reductionLevels: [{ level: 1, evidence: Array(9).fill('x'.repeat(60000)) }] }, new Date(), [{ chunkId: chunk.id, evidence: [evidence] }])).rejects.toThrow(/checkpoint too large/);
      expect(await store.resume(owner, input)).toEqual(saved);
    } finally { await db.dispose(); }
  }, 30000);

  it('rolls back evidence upserts and checkpoint updates on either write failure', async () => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const { input, owner } = await seed(db);
      const plan = prepareContext(input);
      if (plan.kind !== 'chunks') throw new Error('expected chunks');
      const chunk = plan.chunks[0]!;
      const store = new ContextStore(db.db);
      const progress = { completedChunkIds: [chunk.id], reductionLevels: [] };
      const initial = await store.save(owner, input, progress, new Date(), [{ chunkId: chunk.id, evidence: [] }]);
      const evidence = [{ chunkId: chunk.id, evidence: [{ questionId: '0', polarity: 'support' as const, text: 'point', refs: [{ chunkId: chunk.id, start: chunk.start, end: chunk.start + 1, quote: input.article.content.slice(chunk.start, chunk.start + 1) }] }] }];
      await db.pool.query("create function reject_update() returns trigger language plpgsql as $$ begin raise exception 'write failure'; end $$; create trigger reject_checkpoint before update on context_checkpoints for each row execute function reject_update()");
      await expect(store.save(owner, input, progress, new Date(), evidence)).rejects.toThrow();
      expect(await store.resume(owner, input)).toEqual(initial);
      await db.pool.query('drop trigger reject_checkpoint on context_checkpoints; create trigger reject_evidence before update on chunk_results for each row execute function reject_update()');
      await expect(store.save(owner, input, progress, new Date(), evidence)).rejects.toThrow();
      expect(await store.resume(owner, input)).toEqual(initial);
    } finally { await db.dispose(); }
  }, 30000);

  it('rejects v1 completion bits on resume and permits explicit recomputation', async () => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const { input, owner } = await seed(db);
      const plan = prepareContext(input);
      if (plan.kind !== 'chunks') throw new Error('expected chunks');
      const store = new ContextStore(db.db);
      const initial = await store.save(owner, input, { completedChunkIds: [], reductionLevels: [] }, new Date());
      const legacy = { version: 1, completedChunkIds: [plan.chunks[0]!.id], reductionLevels: [{ level: 1, evidence: ['unverified'] }], totalChunks: plan.chunks.length, completedChunks: 1, coverage: { length: input.article.content.length, intervals: [], missing: [], complete: true } };
      await db.pool.query('update context_checkpoints set state=$2 where plan_id=$1', [initial!.planId, JSON.stringify(legacy)]);
      expect(await store.resume(owner, input)).toBeNull();
      await expect(store.save(owner, input, { completedChunkIds: [], reductionLevels: legacy.reductionLevels }, new Date())).rejects.toThrow(/recomputation/);
      const reset = await store.save(owner, input, { completedChunkIds: [], reductionLevels: [] }, new Date());
      expect(reset!.state).toMatchObject({ version: 3, repairStartedChunkIds: [], completedChunks: 0, coverage: { complete: false } });
      expect(await store.resume(owner, input)).toEqual(reset);
    } finally { await db.dispose(); }
  }, 30000);

  it('rolls back plan and chunks when checkpoint write fails', async () => {
    const db = await createUsageDatabase();
    try {
      await migrateDatabase(db.pool);
      const { input, owner } = await seed(db);
      await db.pool.query("create function fail_checkpoint() returns trigger language plpgsql as $$ begin raise exception 'checkpoint failure'; end $$; create trigger fail_checkpoint before insert on context_checkpoints for each row execute function fail_checkpoint()");
      const plan = prepareContext(input);
      if (plan.kind !== 'chunks') throw new Error('expected chunks');
      await expect(new ContextStore(db.db).save(owner, input, { completedChunkIds: [plan.chunks[0]!.id], reductionLevels: [] }, new Date(), [{ chunkId: plan.chunks[0]!.id, evidence: [] }])).rejects.toThrow();
      expect((await db.pool.query('select (select count(*) from context_plans)::int plans, (select count(*) from content_chunks)::int chunks, (select count(*) from chunk_results)::int results')).rows[0]).toEqual({ plans: 0, chunks: 0, results: 0 });
    } finally { await db.dispose(); }
  }, 30000);
});
