import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createUsageDatabase } from '../helpers/usage-database.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { ScoreTaskInputStore } from '../../src/server/adapters/postgres/score-task-input-store.js';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { CatalogStore } from '../../src/server/adapters/postgres/catalog-store.js';
import { ScoreStore } from '../../src/server/adapters/postgres/score-store.js';
import { PreferenceStore } from '../../src/server/adapters/postgres/preference-store.js';
import { TagMergeStore } from '../../src/server/adapters/postgres/tag-merge-store.js';
import { processContextChunks } from '../../src/server/application/process-context-chunks.js';
import { prepareContext, selectContext } from '../../src/server/application/prepare-context.js';
import type { AiPort } from '../../src/server/ports/ai.js';

let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let store: ScoreTaskInputStore;
let article: string, other: string, source: string, tag: string, task: string, token: string;
const score = '10000000-0000-4000-8000-000000000001';
const category = '00000000-0000-4000-8000-000000000002';
const classifier = { model: { provider: 'fake', model: 'classifier' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: () => 1 };
const generator = { ...classifier, model: { provider: 'fake', model: 'generator' } };
const models = { classifier, generator };
const signal = new AbortController().signal;
const load = () => store.load(task, token, models, signal);

beforeAll(async () => {
  db = await createUsageDatabase();
  await migrateDatabase(db.pool);
  store = new ScoreTaskInputStore(db.pool);
  const context = (await db.pool.query("insert into import_contexts(instance,account) values ('score-input','test') returning id")).rows[0].id;
  source = (await db.pool.query("insert into sources(context_id,external_feed_id,manual_offset) values ($1,'feed',2) returning id", [context])).rows[0].id;
  article = (await db.pool.query("insert into articles(context_id,freshrss_id,source_id,category_id,title,imported_at) values ($1,'one',$2,$3,'Title',now()) returning id", [context, source, category])).rows[0].id;
  other = (await db.pool.query("insert into articles(context_id,freshrss_id,source_id,imported_at) values ($1,'two',$2,now()) returning id", [context, source])).rows[0].id;
  tag = (await db.pool.query("insert into tags(label,key,manual_offset) values ('Relevant','',3) returning id")).rows[0].id;
  await db.pool.query('insert into article_tags values ($1,$2)', [article, tag]);
  const votedAt = new Date(Date.now() - 30 * 86400000);
  await db.pool.query('insert into tag_votes values ($1,$2,1,$3)', [other, tag, votedAt]);
  await db.pool.query('insert into source_votes values ($1,$2,1,$3)', [other, source, votedAt]);
  await db.pool.query('insert into app_settings(id,preference_half_life_days) values (1,30) on conflict(id) do update set preference_half_life_days=30');
  await db.pool.query("update model_roles set provider='fake', model=case role when 'scores' then 'classifier' else 'generator' end where role in ('scores','context_reduction')");
  await db.pool.query("update score_definitions set prompt='global', include_title=true, include_content=true, include_category=true, include_tag_weights=true, include_source_weight=true where id=$1", [score]);
  await db.pool.query("insert into score_category_prompts(score_id,category_id,prompt) values ($1,$2,'override')", [score, category]);
  await new ContentStore(db.db).saveSuccessful(article, { text: 'Body', quality: 'usable', capturedAt: new Date() });
  token = randomUUID();
  task = (await db.pool.query("insert into processing_tasks(article_id,action,score_target_id,generation,state,execution_token,created_at,updated_at) values ($1,'scores',$2,3,'running',$3,now(),now()) returning id", [article, score, token])).rows[0].id;
}, 30000);
afterAll(async () => { if (db) await db.dispose(); });

it('captures override, selected fields, real weights at one instant, and fenced basis', async () => {
  const input = await load();
  expect(input).not.toBeNull();
  const epoch = (await db.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision;
  expect(input).toMatchObject({ owner: { taskId: task, executionToken: token, assignmentRevision: 0, catalogEpoch: epoch }, scoreId: score, generation: 3, prompt: 'override', article: { id: article, title: 'Title', category: 'KI & Agenten', content: 'Body', contentRevision: 1 }, signal });
  expect(input!.article.tagWeights).toHaveLength(1);
  expect(input!.article.tagWeights[0]!.tag).toBe('Relevant');
  expect(input!.article.tagWeights[0]!.weight).toBeCloseTo(3.5, 5);
  expect(input!.article.sourceWeight).toBeCloseTo(2.5, 5);
  expect(input!.article.tagWeights[0]!.weight - 3).toBeCloseTo(input!.article.sourceWeight! - 2, 14);
  expect(selectContext(input!.article, input!.fields)).toEqual({ title: 'Title', category: 'KI & Agenten', tagWeights: input!.article.tagWeights, sourceWeight: input!.article.sourceWeight, content: 'Body' });
});

it('uses global prompt, projects disabled fields, and handles missing content and title-only', async () => {
  await db.pool.query('delete from score_category_prompts where score_id=$1 and category_id=$2', [score, category]);
  await db.pool.query('update score_definitions set include_content=false, include_category=false, include_tag_weights=false, include_source_weight=false where id=$1', [score]);
  await db.pool.query('delete from article_contents where article_id=$1', [article]);
  await db.pool.query('update articles set content_revision=0 where id=$1', [article]);
  const input = await load();
  expect(input).toMatchObject({ prompt: 'global', article: { content: '', contentRevision: 0, tagWeights: [], sourceWeight: null } });
  expect(selectContext(input!.article, input!.fields)).toEqual({ title: 'Title' });
  expect(prepareContext({ taskKind: 'scores', fields: input!.fields, article: input!.article, generation: input!.generation, prompt: input!.prompt, questions: [input!.prompt], tools: '', limits: classifier.limits }).kind).toBe('direct');
  await db.pool.query('update score_definitions set include_content=true where id=$1', [score]);
  expect(await processContextChunks((await load())!, {} as AiPort)).toEqual({ kind: 'needs_input', reason: 'missing_selected_content' });
});

it('fails closed for ownership, target, generation, definition and model changes', async () => {
  expect(await store.load(task, randomUUID(), models, signal)).toBeNull();
  expect(await store.load(randomUUID(), token, models, signal)).toBeNull();
  expect(await store.load(task, token, { ...models, generator: { ...generator, model: { ...generator.model, model: 'wrong' } } }, signal)).toBeNull();
  await db.pool.query("update model_roles set provider=null,model=null where role='scores'");
  expect(await load()).toBeNull();
  await db.pool.query("update model_roles set provider='fake',model='classifier' where role='scores'");
  await db.pool.query('update score_definitions set active=false where id=$1', [score]);
  expect(await load()).toBeNull();
  await db.pool.query('update score_definitions set active=true,deleted_at=now() where id=$1', [score]);
  expect(await load()).toBeNull();
  await db.pool.query('update score_definitions set deleted_at=null where id=$1', [score]);
  await db.pool.query("update processing_tasks set state='queued' where id=$1", [task]);
  expect(await load()).toBeNull();
  await db.pool.query("update processing_tasks set state='running',action='tags' where id=$1", [task]);
  expect(await load()).toBeNull();
  await db.pool.query("update processing_tasks set action='scores',score_target_id=$2 where id=$1", [task, randomUUID()]);
  expect(await load()).toBeNull();
  await db.pool.query('update processing_tasks set score_target_id=$2 where id=$1', [task, score]);
  const newer = (await db.pool.query("insert into processing_tasks(article_id,action,score_target_id,generation,state,created_at,updated_at) values ($1,'scores',$2,4,'failed',now(),now()) returning id", [article, score])).rows[0].id;
  expect(await load()).toBeNull();
  await db.pool.query('delete from processing_tasks where id=$1', [newer]);
  expect(await load()).not.toBeNull();
});

it('captures assignment and epoch fences that reject subsequent changes', async () => {
  const first = (await load())!;
  const catalog = new CatalogStore(db.db);
  expect(await catalog.setCategory(article, '00000000-0000-4000-8000-000000000003')).toBe('ok');
  const second = (await load())!;
  expect(second.owner.assignmentRevision).toBe(first.owner.assignmentRevision + 1);
  const candidate = { value: 50, basis: { ...first.owner, articleId: article, scoreId: score, generation: first.generation, contentRevision: 0, condensed: false as const, limited: false as const }, coverage: { selected: false, length: 0, intervals: [], missing: [], complete: true as const } };
  expect(await new ScoreStore(db.db).publishCandidate(candidate, new Date())).toBe(false);
  await catalog.saveModelRole({ role: 'scores', primary: { provider: 'fake', model: 'new' }, fallback: null });
  expect(await load()).toBeNull();
  expect(await new ScoreStore(db.db).publishCandidate({ ...candidate, basis: { ...candidate.basis, assignmentRevision: second.owner.assignmentRevision } }, new Date())).toBe(false);
});

it('uses a fresh snapshot for all votes after waiting for the article lock', async () => {
  await db.pool.query("update model_roles set model='classifier' where role='scores'");
  await db.pool.query('update score_definitions set include_tag_weights=true, include_source_weight=true where id=$1', [score]);
  const client = await db.pool.connect();
  let pending: ReturnType<typeof load> | undefined;
  try {
    await client.query('begin');
    await client.query('select id from articles where id=$1 for update', [article]);
    pending = load();
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      waiting = !!(await db.pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select id, title, category_id%'")).rowCount;
      if (!waiting) await delay(10);
    }
    expect(waiting).toBe(true);
    expect(await new PreferenceStore(db.pool).vote(other, -1, [{ type: 'tag', id: tag }, { type: 'source', id: source }])).toBe('ok');
    await client.query('commit');
    const captured = (await pending)!;
    expect(captured.article.tagWeights[0]!.weight).toBeCloseTo(2, 5);
    expect(captured.article.sourceWeight).toBeCloseTo(1, 5);
  } finally { await client.query('rollback'); client.release(); if (pending) await pending; }
  const after = (await load())!;
  expect(after.article.tagWeights[0]!.weight).toBeCloseTo(2, 5);
  expect(after.article.sourceWeight).toBeCloseTo(1, 5);
});

it('captures the new article basis after waiting for an assignment change', async () => {
  await db.pool.query("update model_roles set model='classifier' where role='scores'");
  const client = await db.pool.connect();
  let pending: ReturnType<typeof load> | undefined;
  try {
    await client.query('begin');
    await client.query('update articles set assignment_revision=assignment_revision+1 where id=$1', [article]);
    pending = load();
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      waiting = !!(await db.pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select id, title, category_id%'")).rowCount;
      if (!waiting) await delay(10);
    }
    expect(waiting).toBe(true);
    await client.query('commit');
    const captured = await pending;
    expect(captured).not.toBeNull();
    expect(captured!.owner.assignmentRevision).toBe((await db.pool.query('select assignment_revision from articles where id=$1', [article])).rows[0].assignment_revision);
  } finally { await client.query('rollback'); client.release(); if (pending) await pending; }
});

it('serializes merge against capture and fences the pre-merge basis', async () => {
  const target = (await db.pool.query("insert into tags(label,key) values ('Merged','') returning id")).rows[0].id;
  const client = await db.pool.connect();
  let pending: ReturnType<typeof load> | undefined;
  let merging: ReturnType<TagMergeStore['merge']> | undefined;
  try {
    await client.query('begin');
    await client.query('select id from articles where id=$1 for update', [article]);
    pending = load();
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      waiting = !!(await db.pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select id, title, category_id%'")).rowCount;
      if (!waiting) await delay(10);
    }
    expect(waiting).toBe(true);
    merging = new TagMergeStore(db.pool).merge(target, [tag]);
    waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      waiting = !!(await db.pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select revision from catalog_epoch%for update'")).rowCount;
      if (!waiting) await delay(10);
    }
    expect(waiting).toBe(true);
    await client.query('commit');
    const before = (await pending)!;
    expect(before.article.tagWeights[0]!.tag).toBe('Relevant');
    expect(await merging).toBe('ok');
    const after = (await load())!;
    expect(after.article.tagWeights[0]!.tag).toBe('Merged');
    expect(after.owner.catalogEpoch).toBe(before.owner.catalogEpoch + 1);
    expect(after.owner.assignmentRevision).toBe(before.owner.assignmentRevision + 1);
  } finally { await client.query('rollback'); client.release(); if (pending) await pending; if (merging) await merging; }
});

it('rejects a newer generation inserted while waiting for the article lock', async () => {
  const client = await db.pool.connect();
  let pending: ReturnType<typeof load> | undefined;
  try {
    await client.query('begin');
    await client.query('select id from articles where id=$1 for update', [article]);
    await client.query("insert into processing_tasks(article_id,action,score_target_id,generation,state,created_at,updated_at) values ($1,'scores',$2,5,'failed',now(),now())", [article, score]);
    pending = load();
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      waiting = !!(await db.pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select id, title, category_id%'")).rowCount;
      if (!waiting) await delay(10);
    }
    expect(waiting).toBe(true);
    await client.query('commit');
    expect(await pending).toBeNull();
  } finally { await client.query('rollback'); client.release(); if (pending) await pending; }
});
