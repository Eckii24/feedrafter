import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/server/adapters/postgres/client.js";
import { migrateDatabase } from "../../src/server/adapters/postgres/migrate.js";
import { ScoreStore } from "../../src/server/adapters/postgres/score-store.js";
import { ScoreTaskInputStore } from "../../src/server/adapters/postgres/score-task-input-store.js";
import { linkedScoreFixture } from "../helpers/linked-score-fixture.js";
import { ContentStore } from "../../src/server/adapters/postgres/content-store.js";
import { CatalogStore, RejectTagCandidate } from "../../src/server/adapters/postgres/catalog-store.js";
import { TaskStore } from "../../src/server/adapters/postgres/task-store.js";
import { readHandoffReceipt } from "../../src/server/domain/article-handoff.js";
import { UsageStore } from "../../src/server/adapters/postgres/usage-store.js";
import { processContextChunks, type ScoreContextTask } from "../../src/server/application/process-context-chunks.js";
import { runDirectScoreTask } from "../../src/server/application/run-direct-score-task.js";
import type { AiPort } from "../../src/server/ports/ai.js";

const docker = (...args: string[]) => execFileSync("docker", ["--host", "unix:///var/run/docker.sock", ...args], { encoding: "utf8" }).trim();
let container = "";
let database: ReturnType<typeof createDatabase>;
let connectionString: string;
let migration: string;
let articleId: string;
const fallback = "00000000-0000-4000-8000-000000000001";
const score = "10000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  container = docker("run", "--detach", "--rm", "--pull=never", "--name", `feedrafter-enrichment-${randomUUID()}`,
    "-e", "POSTGRES_PASSWORD=disposable-test-only", "-e", "POSTGRES_DB=feedrafter_test", "-p", "127.0.0.1::5432", "postgres:18");
  const port = /^127\.0\.0\.1:(\d+)$/.exec(docker("port", container, "5432/tcp"));
  if (!port) throw new Error("Unexpected PostgreSQL port");
  connectionString = `postgresql://postgres:disposable-test-only@127.0.0.1:${port[1]}/feedrafter_test`;
  database = createDatabase(connectionString);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await database.pool.query("select 1"); ready = true; break; } catch { await delay(200); }
  }
  if (!ready) throw new Error("PostgreSQL not ready");
  const version = await database.pool.query<{ server_version_num: string }>("show server_version_num");
  expect(Number(version.rows[0]!.server_version_num)).toBeGreaterThanOrEqual(180000);
  expect(Number(version.rows[0]!.server_version_num)).toBeLessThan(190000);
  // Apply the actual D1 migration, then mark it applied for the real migrator.
  const d1 = await readFile("drizzle/0000_import.sql", "utf8");
  await database.pool.query(d1);
  const context = await database.pool.query<{ id: string }>("insert into import_contexts(instance, account) values ('legacy', 'account') returning id");
  const article = await database.pool.query<{ id: string }>("insert into articles(context_id, freshrss_id, imported_at) values ($1, 'legacy', now()) returning id", [context.rows[0]!.id]);
  articleId = article.rows[0]!.id;
  // Use the migrator's hash/time record as if D1 had been migrated previously.
  const { createHash } = await import("node:crypto");
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as { entries: { when: number }[] };
  await database.pool.query("create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)");
  await database.pool.query("insert into drizzle.__drizzle_migrations(hash, created_at) values ($1, $2)", [createHash("sha256").update(d1).digest("hex"), journal.entries[0]!.when]);
  migration = await readFile("drizzle/0001_enrichment.sql", "utf8");
  await migrateDatabase(database.pool);
}, 30000);

afterAll(async () => {
  try { if (database) await database.close(); } finally { if (container) docker("rm", "--force", container); }
});

describe("D2 enrichment migration", () => {
  it("upgrades an existing C10 schema without changing its edited seeds", async () => {
    const name = `upgrade_${randomUUID().replaceAll('-', '')}`;
    await database.pool.query(`create database "${name}"`);
    const url = new URL(connectionString);
    url.pathname = `/${name}`;
    const old = createDatabase(url.toString());
    try {
      const d1 = await readFile('drizzle/0000_import.sql', 'utf8');
      const { createHash } = await import('node:crypto');
      const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')) as { entries: { when: number }[] };
      await old.pool.query(d1);
      await old.pool.query(migration);
      await old.pool.query("update categories set label='preserved' where id=$1", [fallback]);
      await old.pool.query('create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)');
      for (const [index, source] of [d1, migration].entries()) {
        await old.pool.query('insert into drizzle.__drizzle_migrations(hash, created_at) values ($1, $2)', [createHash('sha256').update(source).digest('hex'), journal.entries[index]!.when]);
      }
      await migrateDatabase(old.pool);
      expect((await old.pool.query('select label from categories where id=$1', [fallback])).rows[0].label).toBe('preserved');
      expect((await old.pool.query('select daily_requests from budget_settings where bucket=$1', ['classifier'])).rows[0].daily_requests).toBe(2000);
    } finally {
      await old.close();
      await database.pool.query(`drop database "${name}"`);
    }
  });

  it("assigns fallback to D1 and new articles without scheduling enrichment", async () => {
    expect((await database.pool.query("select category_id from articles where id=$1", [articleId])).rows).toEqual([{ category_id: fallback }]);
    const fresh = await database.pool.query("insert into articles(context_id, freshrss_id, imported_at) select context_id, 'new', now() from articles where id=$1 returning category_id", [articleId]);
    expect(fresh.rows).toEqual([{ category_id: fallback }]);
    expect((await database.pool.query("select count(*)::int n from processing_tasks")).rows[0].n).toBe(0);
  });

  it("seeds exact labels, prompts and context, without overwriting edits", async () => {
    const labels = await database.pool.query("select label from categories order by id");
    expect(labels.rows.map(r => r.label)).toEqual(['Nicht zugeordnet', 'KI & Agenten', 'Softwarearchitektur & Engineering', 'Entwicklerwerkzeuge & Plattformen', 'Homelab, DevOps & Smart Home', 'Produktivität & Wissensmanagement', 'Haus & Wohnen', 'Gesundheit & Fitness', 'Hobbys & Allgemeinwissen']);
    const scores = await database.pool.query("select name, prompt, include_title, include_content, include_category, include_tag_weights, include_source_weight from score_definitions order by id");
    expect(scores.rows.map(r => r.name)).toEqual(['Hype', 'Facts', 'Signal', 'Persönliche Relevanz']);
    const spec = await readFile("docs/dev-agentic-news-reader-spec.md", "utf8");
    for (const row of scores.rows) {
      expect(spec).toContain(`„${row.prompt}“`);
      expect([row.include_title, row.include_content, row.include_category]).toEqual([true, true, true]);
      expect([row.include_tag_weights, row.include_source_weight]).toEqual([row.name === 'Persönliche Relevanz', row.name === 'Persönliche Relevanz']);
    }
    await database.pool.query("update categories set label='edited category' where id=$1", [fallback]);
    await database.pool.query("update score_definitions set prompt='edited prompt' where id=$1", [score]);
    await database.pool.query("update model_roles set provider='other', model='edited' where role='category'");
    const seedStatements = migration.split('--> statement-breakpoint').filter(s => /INSERT INTO (categories|score_definitions|model_roles)/.test(s));
    expect(seedStatements).toHaveLength(3);
    for (const statement of seedStatements) await database.pool.query(statement);
    await migrateDatabase(database.pool);
    expect((await database.pool.query("select label from categories where id=$1", [fallback])).rows[0].label).toBe('edited category');
    expect((await database.pool.query("select prompt from score_definitions where id=$1", [score])).rows[0].prompt).toBe('edited prompt');
    expect((await database.pool.query("select provider, model from model_roles where role='category'")).rows[0]).toEqual({ provider: 'other', model: 'edited' });
    expect((await database.pool.query("select count(*)::int n from score_definitions")).rows[0].n).toBe(4);
  });

  it("protects fallback and retains archived categories", async () => {
    await expect(database.pool.query("update categories set archived_at=now() where id=$1", [fallback])).rejects.toThrow();
    await expect(database.pool.query("delete from categories where id=$1", [fallback])).rejects.toThrow();
    await expect(database.pool.query("insert into score_category_prompts(score_id, category_id, prompt) values ($1,$2,'override')", [score, fallback])).rejects.toThrow();
    await database.pool.query("update categories set archived_at=now() where id='00000000-0000-4000-8000-000000000002'");
  });

  it("persists only explicit complete model mappings", async () => {
    const roles = await database.pool.query("select role, provider, model, fallback_provider, fallback_model from model_roles order by role");
    expect(roles.rows).toHaveLength(9);
    expect(roles.rows.find(r => r.role === 'quality')).toMatchObject({ provider: 'typesafe', model: 'jev-latest', fallback_provider: null, fallback_model: null });
    expect(roles.rows.find(r => r.role === 'chat')).toMatchObject({ provider: null, model: null, fallback_provider: null, fallback_model: null });
    await expect(database.pool.query("update model_roles set provider='p' where role='chat'")).rejects.toThrow();
    await expect(database.pool.query("update model_roles set fallback_provider='p', fallback_model='m' where role='chat'")).rejects.toThrow();
    await database.pool.query("update model_roles set provider='p', model='m', fallback_provider='p2', fallback_model='m2' where role='chat'");
  });

  it("normalizes tag identity and rejects collisions", async () => {
    const row = await database.pool.query("insert into tags(label) values ($1) returning label, key", ['  ＡI\u00a0  Tools  ']);
    expect(row.rows[0]).toEqual({ label: 'AI Tools', key: 'ai tools' });
    await expect(database.pool.query("insert into tags(label, key) values ($1, 'fake')", ['ai\ttools'])).rejects.toThrow();
    await database.pool.query("insert into tags(label) values ('Straße')");
    await expect(database.pool.query("insert into tags(label) values ('STRASSE')")).rejects.toThrow();
    await expect(database.pool.query("insert into tags(label) values ('   ')")).rejects.toThrow();
    const unusual = await new CatalogStore(database.db).createTag('  Mixed\u0085\u2003Space  ');
    expect(unusual).toMatchObject({ label: 'Mixed Space', key: 'mixed space' });
    const direct = await database.pool.query("insert into tags(label) values ($1) returning label, key", ['  Direct\u0085\u2028Space  ']);
    expect(direct.rows[0]).toEqual({ label: 'Direct Space', key: 'direct space' });
  });

  it("replaces content atomically and rolls back a failed write", async () => {
    const store = new ContentStore(database.db);
    const content = { text: 'full original', sourceUrl: 'https://example.test', quality: 'usable', capturedAt: new Date('2026-01-01Z') };
    expect(await store.saveSuccessful(articleId, content)).toBe(1);
    await expect(store.saveSuccessful(articleId, { ...content, text: null as unknown as string })).rejects.toThrow();
    const rows = await database.pool.query("select c.text, c.revision, a.content_revision from articles a join article_contents c on c.article_id=a.id where a.id=$1", [articleId]);
    expect(rows.rows).toEqual([{ text: 'full original', revision: 1, content_revision: 1 }]);
    expect(await store.saveSuccessful(articleId, { ...content, text: 'replacement' })).toBe(2);
  });

  it("clears omitted metadata when replacing limited content and preserves it on write failure", async () => {
    const store = new ContentStore(database.db);
    const created = await database.pool.query<{ id: string }>("insert into articles(context_id, freshrss_id, imported_at) select context_id, $2, now() from articles where id=$1 returning id", [articleId, randomUUID()]);
    const id = created.rows[0]!.id;
    const capturedAt = new Date('2026-01-01Z');
    expect(await store.saveSuccessful(id, { text: 'limited', quality: 'limited', sourceUrl: 'https://example.test', limitation: 'partial', failureCode: 'fetch_failed', capturedAt })).toBe(1);
    expect(await store.saveSuccessful(id, { text: 'complete', quality: 'usable', capturedAt })).toBe(2);
    expect(await store.get(id)).toMatchObject({ revision: 2, text: 'complete', quality: 'usable', sourceUrl: null, limitation: null, failureCode: null });
    await expect(store.saveSuccessful(id, { text: null as unknown as string, quality: 'limited', sourceUrl: 'https://other.test', limitation: 'failed', failureCode: 'failed', capturedAt })).rejects.toThrow();
    expect(await store.get(id)).toMatchObject({ revision: 2, text: 'complete', quality: 'usable', sourceUrl: null, limitation: null, failureCode: null });
    expect((await database.pool.query('select content_revision from articles where id=$1', [id])).rows).toEqual([{ content_revision: 2 }]);
  });

  it("stores editable catalogs and preserves historical archived tag associations", async () => {
    const store = new CatalogStore(database.db);
    const tag = await store.createTag('  Ｓtraßenbahn  ');
    expect(tag.key).toBe('strassenbahn');
    await expect(store.createTag('STRASSENBAHN')).rejects.toThrow();
    expect(await store.attachTag(articleId, tag.id)).toBe(true);
    await store.archiveTag(tag.id, new Date('2026-01-01Z'));
    expect(await store.attachTag(articleId, tag.id)).toBe(false);
    expect((await store.listSuggestedTags()).some(t => t.id === tag.id)).toBe(false);
    expect((await store.listTags()).some(t => t.id === tag.id)).toBe(true);
    expect((await store.listArticleTags(articleId)).find(t => t.id === tag.id)?.archivedAt).not.toBeNull();
    expect((await database.pool.query('select count(*)::int n from article_tags where tag_id=$1', [tag.id])).rows[0].n).toBe(1);
    await expect(database.pool.query('delete from tags where id=$1', [tag.id])).rejects.toThrow();
    const input = { name: 'Custom', description: '', prompt: 'starter', active: true, includeTitle: true, includeContent: true, includeCategory: true, includeTagWeights: false, includeSourceWeight: false };
    const definition = await store.createScoreDefinition(input);
    await store.saveScoreDefinition(definition.id, { ...input, prompt: 'edited' });
    await store.saveScoreCategoryPrompt(definition.id, '00000000-0000-4000-8000-000000000003', 'override');
    expect((await store.listScoreDefinitions()).find(s => s.id === definition.id)?.prompt).toBe('edited');
    expect((await store.listScoreCategoryPrompts()).find(p => p.scoreId === definition.id)?.prompt).toBe('override');
    await store.deleteScoreCategoryPrompt(definition.id, '00000000-0000-4000-8000-000000000003');
    expect((await store.deleteScoreDefinition(definition.id, new Date('2026-01-01Z')))?.active).toBe(false);
    await store.saveModelRole({ role: 'summary', primary: { provider: 'p', model: 'm' }, fallback: null });
    expect((await store.listModelRoles()).find(r => r.role === 'summary')).toMatchObject({ provider: 'p', model: 'm', fallbackProvider: null });
  });

  it("persists chunks and independently replaceable chunk results", async () => {
    const store = new ContentStore(database.db);
    const created = await database.pool.query<{ id: string }>("insert into articles(context_id, freshrss_id, imported_at) select context_id, $2, now() from articles where id=$1 returning id", [articleId, randomUUID()]);
    const chunkArticleId = created.rows[0]!.id;
    await store.saveSuccessful(chunkArticleId, { text: 'replacement', quality: 'usable', capturedAt: new Date('2026-01-01Z') });
    expect((await store.get(chunkArticleId))?.text).toBe('replacement');
    const chunk = await store.saveChunk({ articleId: chunkArticleId, contentRevision: 1, ordinal: 0, startOffset: 0, endOffset: 11, text: 'replacement' });
    await store.saveChunkResult({ chunkId: chunk.id, generation: 1, purpose: 'score', result: { evidence: 'one' }, completedAt: new Date('2026-01-01Z') });
    await store.saveChunkResult({ chunkId: chunk.id, generation: 1, purpose: 'score', result: { evidence: 'two' }, completedAt: new Date('2026-01-02Z') });
    expect(await store.listChunks(chunkArticleId, 1)).toHaveLength(1);
    expect(await store.listChunkResults(chunk.id)).toMatchObject([{ result: { evidence: 'two' } }]);
    await expect(store.saveChunk({ articleId: chunkArticleId, contentRevision: 1, ordinal: 0, startOffset: 0, endOffset: 11, text: 'duplicate' })).rejects.toThrow();
  });

  it("persists budgets, ledger and UTC counters without reseeding user edits", async () => {
    const store = new UsageStore(database.db);
    expect(await store.listBudgets()).toEqual(expect.arrayContaining([
      expect.objectContaining({ bucket: 'automatic', dailyRequests: 50, concurrency: 1 }),
      expect.objectContaining({ bucket: 'classifier', dailyRequests: 2000, concurrency: 2 }),
      expect.objectContaining({ bucket: 'transcription', dailyRequests: null, dailyAudioSeconds: null }),
    ]));
    await store.saveBudget({ bucket: 'automatic', dailyRequests: 7, concurrency: 1, dailyAudioSeconds: null });
    const budgetMigration = await readFile('drizzle/0002_budget_settings.sql', 'utf8');
    await database.pool.query(budgetMigration.split('--> statement-breakpoint')[1]!);
    await migrateDatabase(database.pool);
    expect((await store.listBudgets()).find(b => b.bucket === 'automatic')?.dailyRequests).toBe(7);
    const entry = await database.pool.query<{ id: string }>("insert into usage_ledger(bucket,role,provider,model,occurred_at,status,input_tokens) values ('automatic','summary','p','m','2026-01-01','succeeded',3) returning id");
    expect(await store.getEntry(entry.rows[0]!.id)).toMatchObject({ status: 'succeeded', inputTokens: 3, outputTokens: null });
    await expect(database.pool.query("insert into usage_ledger(bucket,role,provider,model,occurred_at,status,audio_seconds) values ('automatic','summary','p','m',now(),'succeeded','NaN')")).rejects.toThrow();
    await database.pool.query("insert into request_counters(day_utc,bucket,requests) values ('2026-01-01','automatic',20)");
    expect((await store.getCounter('2026-01-01', 'automatic'))?.requests).toBe(20);
    expect(await store.getCounter('2026-01-02', 'automatic')).toBeNull();
  });

  it("keeps missing scores null and enforces finite range and soft delete", async () => {
    const missing = await database.pool.query("select s.value from articles a left join article_scores s on s.article_id=a.id and s.score_id=$2 where a.id=$1", [articleId, score]);
    expect(missing.rows[0].value).toBeNull();
    const insert = "insert into article_scores(article_id,score_id,value,calculated_at,content_revision,assignment_revision) values ($1,$2,$3,now(),0,0)";
    for (const value of [-1, 101, 'NaN', 'Infinity', '-Infinity', null]) await expect(database.pool.query(insert, [articleId, score, value])).rejects.toThrow();
    const store = new ScoreStore(database.db);
    const result = { articleId, scoreId: score, value: 75, calculatedAt: new Date('2026-01-01Z'), contentRevision: 2, assignmentRevision: 1 };
    expect(await store.saveSuccessful(result)).toBe(true);
    await expect(store.saveSuccessful({ ...result, value: NaN })).rejects.toThrow();
    await expect(store.saveSuccessful({ ...result, value: 80, contentRevision: -1 })).rejects.toThrow();
    expect(await store.get(articleId, score)).toMatchObject({ value: 75, contentRevision: 2 });
    await expect(database.pool.query("update article_scores set value='NaN' where article_id=$1", [articleId])).rejects.toThrow();
    expect((await database.pool.query("select value from article_scores where article_id=$1", [articleId])).rows[0].value).toBe(75);
    await database.pool.query("update score_definitions set active=false, deleted_at=now() where id=$1", [score]);
    await expect(database.pool.query("delete from score_definitions where id=$1", [score])).rejects.toThrow();
    const unreferenced = await database.pool.query("insert into score_definitions(name, description, prompt) values ('temporary', '', 'prompt') returning id");
    await expect(database.pool.query("delete from score_definitions where id=$1", [unreferenced.rows[0].id])).rejects.toThrow();
    expect((await database.pool.query("select value from article_scores where article_id=$1", [articleId])).rows[0].value).toBe(75);
  });
});

async function scoreFixture() {
  const id = (await database.pool.query<{ id: string }>('insert into articles(context_id, freshrss_id, imported_at) select context_id, $2, now() from articles where id=$1 returning id', [articleId, randomUUID()])).rows[0]!.id;
  const scoreId = (await database.pool.query<{ id: string }>("insert into score_definitions(name, description, prompt) values ('race', '', 'prompt') returning id")).rows[0]!.id;
  const at = new Date('2026-01-01Z');
  const content = new ContentStore(database.db);
  const catalog = new CatalogStore(database.db);
  const scores = new ScoreStore(database.db);
  const tasks = new TaskStore(database.db);
  await content.saveSuccessful(id, { text: 'original', quality: 'usable', capturedAt: at });
  const task = await tasks.createTask({ articleId: id, action: 'prepare', generation: 1, createdAt: at, updatedAt: at });
  const executionToken = randomUUID();
  await tasks.claimTask(task.id, executionToken, at);
  const tag = await catalog.createTag(`race-${randomUUID()}`);
  const category = await catalog.createCategory(`race-${randomUUID()}`);
  const result = { articleId: id, scoreId, value: 20, calculatedAt: at, contentRevision: 1, assignmentRevision: 0 };
  const edits = {
    content: () => content.publishTask({ taskId: task.id, articleId: id, action: 'prepare', generation: 1, executionToken, expectedContentRevision: 1 }, { kind: 'success', content: { text: 'new', quality: 'usable', capturedAt: at }, at }),
    category: () => catalog.setCategory(id, category.id),
    tag: () => catalog.changeTag(id, tag.id, true),
  };
  return { id, scoreId, scores, result, edits };
}

async function waitForLockWaiters(count: number) {
  for (let i = 0; i < 100; i++) {
    const rows = await database.pool.query<{ n: number }>("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'");
    if (rows.rows[0]!.n >= count) return;
    await delay(20);
  }
  throw new Error(`expected ${count} PostgreSQL lock waiters`);
}

describe('score publication revision fence', () => {
  it('inserts and replaces only matching bases, preserving the whole previous score on stale results', async () => {
    const f = await scoreFixture();
    expect(await f.scores.saveSuccessful({ ...f.result, contentRevision: 0 })).toBe(false);
    expect(await f.scores.saveSuccessful({ ...f.result, assignmentRevision: 1 })).toBe(false);
    expect(await f.scores.get(f.id, f.scoreId)).toBeNull();
    expect(await f.scores.saveSuccessful(f.result)).toBe(true);
    const replacement = { ...f.result, value: 80, calculatedAt: new Date('2026-02-01Z'), condensed: true, limited: true };
    expect(await f.scores.saveSuccessful(replacement)).toBe(true);
    const before = await f.scores.get(f.id, f.scoreId);
    expect(before).toMatchObject(replacement);
    expect(await f.edits.content()).toBe(2);
    expect(await f.scores.saveSuccessful({ ...replacement, value: 90 })).toBe(false);
    expect(await f.edits.tag()).toBe('ok');
    expect(await f.scores.saveSuccessful({ ...replacement, value: 91, contentRevision: 2 })).toBe(false);
    expect(await f.scores.get(f.id, f.scoreId)).toEqual(before);
    expect(await f.scores.saveSuccessful({ ...replacement, value: 95, contentRevision: 2, assignmentRevision: 1 })).toBe(true);
    expect(await f.scores.get(f.id, f.scoreId)).toMatchObject({ value: 95, contentRevision: 2, assignmentRevision: 1 });
    expect(await f.scores.saveSuccessful({ ...f.result, articleId: randomUUID() })).toBe(false);
    for (const invalid of [-1, 1.5, NaN, Infinity, 2147483648]) {
      await expect(f.scores.saveSuccessful({ ...f.result, contentRevision: invalid })).rejects.toThrow('invalid score basis revision');
      await expect(f.scores.saveSuccessful({ ...f.result, assignmentRevision: invalid })).rejects.toThrow('invalid score basis revision');
    }
    expect(await f.scores.get(f.id, f.scoreId)).toMatchObject({ value: 95 });
  });

  it.each(['content', 'category', 'tag'] as const)('serializes %s edits before and after publication without deadlock', async kind => {
    // Hold the article so the real edit queues before the publisher.
    const first = await scoreFixture();
    expect(await first.scores.saveSuccessful(first.result)).toBe(true);
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      await client.query('select id from articles where id=$1 for update', [first.id]);
      const edit = first.edits[kind]();
      await waitForLockWaiters(1);
      const publication = first.scores.saveSuccessful({ ...first.result, value: 70 });
      await waitForLockWaiters(2);
      await client.query('commit');
      expect(await edit).toBe(kind === 'content' ? 2 : 'ok');
      expect(await publication).toBe(false);
      expect(await first.scores.get(first.id, first.scoreId)).toMatchObject({ value: 20 });
    } finally {
      await client.query('rollback');
      client.release();
    }

    // Block the score upsert after it has locked the article; the real edit must wait.
    const second = await scoreFixture();
    expect(await second.scores.saveSuccessful(second.result)).toBe(true);
    const blocker = await database.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select article_id from article_scores where article_id=$1 and score_id=$2 for update', [second.id, second.scoreId]);
      const publication = second.scores.saveSuccessful({ ...second.result, value: 70 });
      await waitForLockWaiters(1);
      const edit = second.edits[kind]();
      await waitForLockWaiters(2);
      await blocker.query('commit');
      expect(await publication).toBe(true);
      expect(await edit).toBe(kind === 'content' ? 2 : 'ok');
      expect(await second.scores.get(second.id, second.scoreId)).toMatchObject({ value: 70, contentRevision: 1, assignmentRevision: 0 });
      expect(await second.scores.saveSuccessful({ ...second.result, value: 90 })).toBe(false);
      expect(await second.scores.get(second.id, second.scoreId)).toMatchObject({ value: 70 });
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  }, 15000);
});

async function directCandidateFixture(setup?: (scoreId: string) => Promise<void>) {
  const f = await scoreFixture();
  const at = new Date('2026-03-01Z');
  await f.scores.saveSuccessful(f.result);
  await setup?.(f.scoreId);
  const tasks = new TaskStore(database.db);
  const task = await tasks.createTask({ articleId: f.id, action: 'scores', scoreTargetId: f.scoreId, generation: 1, createdAt: at, updatedAt: at });
  const token = randomUUID();
  await tasks.claimTask(task.id, token, at);
  const epoch = (await database.pool.query<{ revision: number }>('select revision from catalog_epoch where id=1')).rows[0]!.revision;
  const model = { model: { provider: 'fixture', model: 'fixture' }, limits: { contextTokens: 10000, outputTokens: 10, framingTokens: 10 }, countTokens: (s: string) => Buffer.byteLength(s) };
  const ai: AiPort = {
    classify: async () => ({ kind: 'completed', value: { answers: { score: { type: 'score', score: 3, confidence: 1, criteria: ['0', '25', '50', '75', '100'] } }, usage: null } }),
    generate: async () => { throw new Error('unexpected generate'); },
    createRestrictedSession: async () => { throw new Error('unexpected session'); },
  };
  const input: ScoreContextTask = { owner: { taskId: task.id, executionToken: token, assignmentRevision: 0, catalogEpoch: epoch }, scoreId: f.scoreId, prompt: 'relevance', article: { id: f.id, contentRevision: 1, title: 'title', content: 'original', category: '', tagWeights: [], sourceWeight: null }, fields: { includeTitle: true, includeContent: false, includeCategory: false, includeTagWeights: false, includeSourceWeight: false }, generation: 1, classifier: model, generator: model, signal: new AbortController().signal };
  const output = await processContextChunks(input, ai);
  if (output.kind !== 'completed') throw new Error('expected direct score');
  return { ...f, tasks, task, candidate: output.value, at, input, ai };
}

async function categoryCandidateFixture() {
  const f = await scoreFixture();
  const catalog = new CatalogStore(database.db);
  const tasks = new TaskStore(database.db);
  const category = await catalog.createCategory(`candidate-${randomUUID()}`);
  const at = new Date('2026-03-01Z');
  const task = await tasks.createTask({ articleId: f.id, action: 'category', generation: 1, createdAt: at, updatedAt: at });
  const executionToken = randomUUID();
  await tasks.claimTask(task.id, executionToken, at);
  const catalogEpoch = (await database.pool.query<{ revision: number }>('select revision from catalog_epoch where id=1')).rows[0]!.revision;
  const candidate = { taskId: task.id, executionToken, articleId: f.id, generation: 1, prerequisiteId: null, contentRevision: 1, contentText: 'original', assignmentRevision: 0, catalogEpoch, categoryId: category.id };
  const article = async () => (await database.pool.query('select category_id, content_revision, assignment_revision from articles where id=$1', [f.id])).rows[0];
  return { ...f, catalog, tasks, task, category, at, candidate, article };
}

describe('category candidate publication', () => {
  it('lets the caller roll back category publication with its other work', async () => {
    const f = await categoryCandidateFixture();
    const before = await f.article(), task = await f.tasks.getTask(f.task.id);
    await expect(database.db.transaction(async tx => {
      const published = await f.catalog.publishCategoryCandidateInTransaction(tx, f.candidate, f.at);
      expect(published).toMatchObject({ assignmentRevision: 1, receipt: { taskId: f.task.id, action: 'category' } });
      throw new Error('caller rollback');
    })).rejects.toThrow('caller rollback');
    expect(await f.article()).toEqual(before);
    expect(await f.tasks.getTask(f.task.id)).toEqual(task);
  });

  it('publishes a change and completes the task atomically', async () => {
    const f = await categoryCandidateFixture();
    expect(await f.catalog.publishCategoryCandidate(f.candidate, f.at)).toMatchObject({ assignmentRevision: 1 });
    expect(await f.article()).toMatchObject({ category_id: f.category.id, assignment_revision: 1 });
    expect(await f.tasks.getTask(f.task.id)).toMatchObject({ state: 'succeeded', updatedAt: f.at, endedAt: f.at, errorCode: null });
    expect(await f.catalog.publishCategoryCandidate(f.candidate, f.at)).toBeNull();
  });

  it('succeeds without incrementing the revision for the same category', async () => {
    const f = await categoryCandidateFixture();
    expect(await f.catalog.publishCategoryCandidate({ ...f.candidate, categoryId: fallback.toUpperCase() }, f.at)).toMatchObject({ assignmentRevision: 0 });
    expect(await f.article()).toMatchObject({ category_id: fallback, assignment_revision: 0 });
    expect(await f.tasks.getTask(f.task.id)).toMatchObject({ state: 'succeeded' });
  });

  it('rejects invalid, missing or stale bases without changing either row', async () => {
    const f = await categoryCandidateFixture();
    const beforeArticle = await f.article(), beforeTask = await f.tasks.getTask(f.task.id), b = f.candidate;
    const bad = [
      { ...b, taskId: randomUUID() }, { ...b, executionToken: randomUUID() }, { ...b, articleId: randomUUID() },
      { ...b, categoryId: randomUUID() }, { ...b, contentRevision: 2 }, { ...b, assignmentRevision: 1 },
      { ...b, generation: 2 }, { ...b, catalogEpoch: b.catalogEpoch + 1 }, { ...b, executionToken: 'invalid' },
      { ...b, generation: -1 }, { ...b, assignmentRevision: NaN },
    ];
    for (const candidate of bad) expect(await f.catalog.publishCategoryCandidate(candidate, f.at)).toBeNull();
    expect(await f.catalog.publishCategoryCandidate(b, new Date(NaN))).toBeNull();
    expect(await f.article()).toEqual(beforeArticle);
    expect(await f.tasks.getTask(f.task.id)).toEqual(beforeTask);
  });

  it.each(['newer', 'action', 'state', 'task-article', 'archived', 'epoch', 'content', 'assignment'] as const)('rejects changed %s and preserves current state', async change => {
    const f = await categoryCandidateFixture();
    if (change === 'newer') await f.tasks.createTask({ articleId: f.id, action: 'category', generation: 2, state: 'failed', createdAt: f.at, updatedAt: f.at });
    if (change === 'action') await database.pool.query("update processing_tasks set action='summary' where id=$1", [f.task.id]);
    if (change === 'state') await database.pool.query("update processing_tasks set state='failed' where id=$1", [f.task.id]);
    if (change === 'task-article') await database.pool.query('update processing_tasks set article_id=$2 where id=$1', [f.task.id, articleId]);
    if (change === 'archived') await database.pool.query('update categories set archived_at=now() where id=$1', [f.category.id]);
    if (change === 'epoch') await f.catalog.createCategory(`new-${randomUUID()}`);
    if (change === 'content') await f.edits.content();
    if (change === 'assignment') await f.edits.tag();
    const beforeArticle = await f.article(), beforeTask = await f.tasks.getTask(f.task.id);
    expect(await f.catalog.publishCategoryCandidate(f.candidate, f.at)).toBeNull();
    expect(await f.article()).toEqual(beforeArticle);
    expect(await f.tasks.getTask(f.task.id)).toEqual(beforeTask);
  });

  it('rolls back the assignment when task success fails', async () => {
    const f = await categoryCandidateFixture();
    const beforeArticle = await f.article(), beforeTask = await f.tasks.getTask(f.task.id);
    await database.pool.query(`create function fail_category_success() returns trigger language plpgsql as $$ begin if new.id = '${f.task.id}'::uuid and new.state = 'succeeded' then raise exception 'test category task failure'; end if; return new; end $$`);
    await database.pool.query('create trigger fail_category_success before update on processing_tasks for each row execute function fail_category_success()');
    try {
      await expect(f.catalog.publishCategoryCandidate(f.candidate, f.at)).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'test category task failure' }) });
      expect(await f.article()).toEqual(beforeArticle);
      expect(await f.tasks.getTask(f.task.id)).toEqual(beforeTask);
    } finally {
      await database.pool.query('drop trigger fail_category_success on processing_tasks');
      await database.pool.query('drop function fail_category_success()');
    }
  });

  it('advances the epoch only for successful category creation', async () => {
    const f = await categoryCandidateFixture();
    await expect(f.catalog.createCategory(f.category.label)).rejects.toThrow();
    expect((await database.pool.query<{ revision: number }>('select revision from catalog_epoch where id=1')).rows[0]!.revision).toBe(f.candidate.catalogEpoch);
    await f.catalog.createCategory(`new-${randomUUID()}`);
    expect((await database.pool.query<{ revision: number }>('select revision from catalog_epoch where id=1')).rows[0]!.revision).toBe(f.candidate.catalogEpoch + 1);
    expect(await f.catalog.publishCategoryCandidate(f.candidate, f.at)).toBeNull();
  });

  it('serializes competing publications and newer task creation', async () => {
    const f = await categoryCandidateFixture();
    const blocker = await database.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select id from articles where id=$1 for update', [f.id]);
      const newer = f.tasks.createTask({ articleId: f.id, action: 'category', generation: 2, state: 'failed', createdAt: f.at, updatedAt: f.at });
      await waitForLockWaiters(1);
      const publication = f.catalog.publishCategoryCandidate(f.candidate, f.at);
      await waitForLockWaiters(2);
      await blocker.query('commit');
      await newer;
      expect(await publication).toBeNull();
      expect(await f.article()).toMatchObject({ category_id: fallback, assignment_revision: 0 });
      expect(await f.tasks.getTask(f.task.id)).toMatchObject({ state: 'running' });
    } finally { await blocker.query('rollback'); blocker.release(); }

    const second = await categoryCandidateFixture();
    const results = await Promise.all([second.catalog.publishCategoryCandidate(second.candidate, second.at), second.catalog.publishCategoryCandidate(second.candidate, second.at)]);
    expect(results.filter(result => result !== null)).toMatchObject([{ assignmentRevision: 1 }]);
    expect(results.filter(result => result === null)).toHaveLength(1);
    expect(await second.article()).toMatchObject({ category_id: second.category.id, assignment_revision: 1 });
    expect(await second.tasks.getTask(second.task.id)).toMatchObject({ state: 'succeeded' });
  }, 15000);

  it.each(['create', 'archive'] as const)('serializes category %s and publication in both orders', async kind => {
    const first = await categoryCandidateFixture();
    const blocker = await database.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select id from catalog_epoch where id=1 for update');
      const mutation = kind === 'create' ? first.catalog.createCategory(`race-${randomUUID()}`) : first.catalog.archiveCategory(first.category.id, first.at);
      await waitForLockWaiters(1);
      const publication = first.catalog.publishCategoryCandidate(first.candidate, first.at);
      await waitForLockWaiters(2);
      await blocker.query('commit');
      await mutation;
      expect(await publication).toBeNull();
      expect(await first.article()).toMatchObject({ category_id: fallback, assignment_revision: 0 });
      expect(await first.tasks.getTask(first.task.id)).toMatchObject({ state: 'running' });
    } finally { await blocker.query('rollback'); blocker.release(); }

    const second = await categoryCandidateFixture();
    const taskBlocker = await database.pool.connect();
    try {
      await taskBlocker.query('begin');
      await taskBlocker.query('select id from processing_tasks where id=$1 for update', [second.task.id]);
      const publication = second.catalog.publishCategoryCandidate(second.candidate, second.at);
      await waitForLockWaiters(1);
      const mutation = kind === 'create' ? second.catalog.createCategory(`race-${randomUUID()}`) : second.catalog.archiveCategory(second.category.id, second.at);
      await waitForLockWaiters(2);
      await taskBlocker.query('commit');
      expect(await publication).toMatchObject({ assignmentRevision: 1 });
      await mutation;
      expect(await second.article()).toMatchObject({ category_id: second.category.id, assignment_revision: 1 });
      expect(await second.tasks.getTask(second.task.id)).toMatchObject({ state: 'succeeded' });
    } finally { await taskBlocker.query('rollback'); taskBlocker.release(); }
  }, 15000);
});

async function tagCandidateFixture(setup?: (catalog: CatalogStore, id: string) => Promise<void>) {
  const f = await categoryCandidateFixture();
  const published = await f.catalog.publishCategoryCandidate(f.candidate, f.at);
  expect(published).toMatchObject({ assignmentRevision: 1 });
  if (!published) throw new Error('Expected category publication');
  await setup?.(f.catalog, f.id);
  const task = await f.tasks.createTask({ articleId: f.id, action: 'tags', generation: 1, prerequisiteId: f.task.id, createdAt: f.at, updatedAt: f.at });
  const executionToken = randomUUID();
  await f.tasks.claimTask(task.id, executionToken, f.at);
  const catalogEpoch = (await database.pool.query<{ revision: number }>('select revision from catalog_epoch where id=1')).rows[0]!.revision;
  const candidate = { taskId: task.id, executionToken, articleId: f.id, generation: 1, title: null, contentRevision: 1, contentText: 'original', categoryId: f.category.id, assignmentRevision: (await f.article()).assignment_revision as number, catalogEpoch, prerequisiteTaskId: f.task.id, prerequisiteGeneration: 1, categoryPrerequisiteId: null, articleInputHash: published.receipt.basis.articleInputHash, prerequisiteReceipt: published.receipt, labels: [] as string[] };
  return { ...f, categoryTask: f.task, task, candidate };
}

describe('tag candidate publication', () => {
  it('standalone tag publication persists its receipt', async () => {
    const f = await tagCandidateFixture();
    const published = await f.catalog.publishTagCandidate(f.candidate, f.at);
    const saved = await f.tasks.getTask(f.task.id);
    expect(saved).toMatchObject({ state: 'succeeded' });
    const receipt = readHandoffReceipt(saved?.result);
    expect(receipt).toMatchObject({ taskId: f.task.id, action: 'tags', generation: f.candidate.generation });
    expect(published).toEqual({ assignmentRevision: 1, catalogEpoch: f.candidate.catalogEpoch, receipt });
  });

  it.each(['child null', 'child malformed', 'root null', 'root malformed'] as const)('rejects %s namespace through both tag publishers', async kind => {
    const f = await tagCandidateFixture();
    const id = kind.startsWith('child') ? f.task.id : f.categoryTask.id;
    await database.pool.query("update processing_tasks set result=jsonb_set(coalesce(result,'{}'::jsonb),'{articleChain}',$2::jsonb) where id=$1", [id, kind.endsWith('null') ? 'null' : '{}']);
    const before = await f.tasks.getTask(f.task.id), article = await f.article();
    expect(await f.catalog.publishTagCandidate(f.candidate, f.at)).toBeNull();
    expect(await database.db.transaction(tx => f.catalog.publishTagCandidateInTransaction(tx, f.candidate, f.at))).toBeNull();
    expect(await f.tasks.getTask(f.task.id)).toEqual(before);
    expect(await f.article()).toEqual(article);
    expect(await f.catalog.listArticleTags(f.id)).toEqual([]);
    expect((await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision).toBe(f.candidate.catalogEpoch);
  });

  it.each([['wrapper', 0], ['wrapper', 1], ['transaction', 0], ['transaction', 1]] as const)('persists standalone %s receipt at generation %i', async (entry, generation) => {
    const f = await tagCandidateFixture();
    await database.pool.query('update processing_tasks set generation=$2,result=$3 where id=$1', [f.task.id, generation, { other: 'preserved' }]);
    const candidate = { ...f.candidate, generation, labels: [`receipt-${randomUUID()}`] };
    const published = entry === 'wrapper' ? await f.catalog.publishTagCandidate(candidate, f.at) : await database.db.transaction(tx => f.catalog.publishTagCandidateInTransaction(tx, candidate, f.at));
    expect(published).toMatchObject({ assignmentRevision: 2, catalogEpoch: candidate.catalogEpoch + 1, receipt: { taskId: f.task.id, generation, action: 'tags', prerequisiteId: f.categoryTask.id, basis: { contentRevision: 1, assignmentRevision: 2, articleInputHash: candidate.articleInputHash }, catalogEpoch: candidate.catalogEpoch + 1 } });
    const task = await f.tasks.getTask(f.task.id);
    expect(task).toMatchObject({ state: 'succeeded', generation, result: { other: 'preserved', handoffReceipt: published?.receipt } });
    expect(readHandoffReceipt(task?.result)).toEqual(published?.receipt);
  });

  it.each(['wrapper', 'transaction'] as const)('rolls back written tag receipt on deferred commit through %s', async entry => {
    const f = await tagCandidateFixture();
    const before = await f.tasks.getTask(f.task.id), article = await f.article();
    const label = `deferred-${randomUUID()}`;
    await database.pool.query(`create function fail_tag_receipt_commit() returns trigger language plpgsql as $$ begin if new.id='${f.task.id}'::uuid and new.result ? 'handoffReceipt' then raise exception 'tag receipt commit failure'; end if; return new; end $$`);
    await database.pool.query('create constraint trigger fail_tag_receipt_commit after update on processing_tasks deferrable initially deferred for each row execute function fail_tag_receipt_commit()');
    try {
      const candidate = { ...f.candidate, labels: [label] };
      await expect(entry === 'wrapper' ? f.catalog.publishTagCandidate(candidate, f.at) : database.db.transaction(tx => f.catalog.publishTagCandidateInTransaction(tx, candidate, f.at))).rejects.toMatchObject({ cause: { message: 'tag receipt commit failure' } });
      expect(await f.tasks.getTask(f.task.id)).toEqual(before);
      expect(await f.article()).toEqual(article);
      expect(await f.catalog.listArticleTags(f.id)).toEqual([]);
      expect((await database.pool.query('select id from tags where label=$1', [label])).rowCount).toBe(0);
      expect((await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision).toBe(f.candidate.catalogEpoch);
    } finally { await database.pool.query('drop trigger fail_tag_receipt_commit on processing_tasks; drop function fail_tag_receipt_commit()'); }
  });

  it('rolls back caller-owned publication and propagates late rejection out of the transaction', async () => {
    let archived = '';
    const f = await tagCandidateFixture(async catalog => {
      archived = `archived-${randomUUID()}`;
      const tag = await catalog.createTag(archived);
      await catalog.archiveTag(tag.id, new Date());
    });
    const label = `rollback-${randomUUID()}`;
    const before = await f.article(), task = await f.tasks.getTask(f.task.id);
    await expect(database.db.transaction(async tx => {
      await f.catalog.publishTagCandidateInTransaction(tx, { ...f.candidate, labels: [label, archived] }, f.at);
    })).rejects.toBeInstanceOf(RejectTagCandidate);
    await expect(database.db.transaction(async tx => {
      expect(await f.catalog.publishTagCandidateInTransaction(tx, { ...f.candidate, labels: [label] }, f.at)).toMatchObject({ assignmentRevision: 2, catalogEpoch: f.candidate.catalogEpoch + 1, receipt: expect.any(Object) });
      throw new Error('caller rollback');
    })).rejects.toThrow('caller rollback');
    expect((await database.pool.query('select id from tags where label=$1', [label])).rowCount).toBe(0);
    expect(await f.article()).toEqual(before);
    expect(await f.tasks.getTask(f.task.id)).toEqual(task);
    expect(await f.catalog.listArticleTags(f.id)).toHaveLength(0);
    expect((await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision).toBe(f.candidate.catalogEpoch);
  });

  it('accepts an empty list without changing revisions', async () => {
    const f = await tagCandidateFixture();
    expect(await f.catalog.publishTagCandidate(f.candidate, f.at)).toMatchObject({ assignmentRevision: 1, catalogEpoch: f.candidate.catalogEpoch, receipt: expect.any(Object) });
    expect(await f.tasks.getTask(f.task.id)).toMatchObject({ state: 'succeeded', endedAt: f.at });
  });

  it('preserves existing labels, offsets and feedback, deduplicates using PostgreSQL casefold and increments once', async () => {
    const suffix = randomUUID();
    let existingId = '';
    const f = await tagCandidateFixture(async (catalog, id) => {
      const tag = await catalog.createTag(`Straße ${suffix}`);
      existingId = tag.id;
      await database.pool.query('update tags set manual_offset=3 where id=$1', [tag.id]);
      await database.pool.query('insert into tag_votes(article_id, tag_id, value, voted_at) values ($1,$2,1,now())', [id, tag.id]);
    });
    const labels = [`STRASSE ${suffix}`, `new ${suffix}`, `NEW ${suffix}`, `Straße ${suffix}`];
    expect(await f.catalog.publishTagCandidate({ ...f.candidate, labels }, f.at)).toMatchObject({ assignmentRevision: 2, catalogEpoch: f.candidate.catalogEpoch + 1, receipt: expect.any(Object) });
    expect(await f.catalog.listArticleTags(f.id)).toHaveLength(2);
    expect((await database.pool.query('select label, manual_offset from tags where id=$1', [existingId])).rows[0]).toEqual({ label: `Straße ${suffix}`, manual_offset: 3 });
    expect((await database.pool.query('select value from tag_votes where article_id=$1 and tag_id=$2', [f.id, existingId])).rows).toEqual([{ value: 1 }]);
    const second = await f.tasks.createTask({ articleId: f.id, action: 'tags', generation: 2, prerequisiteId: f.categoryTask.id, createdAt: f.at, updatedAt: f.at });
    const token = randomUUID(); await f.tasks.claimTask(second.id, token, f.at);
    expect(await f.catalog.publishTagCandidate({ ...f.candidate, taskId: second.id, executionToken: token, generation: 2, assignmentRevision: 2, catalogEpoch: f.candidate.catalogEpoch + 1, labels }, f.at)).toMatchObject({ assignmentRevision: 2, catalogEpoch: f.candidate.catalogEpoch + 1, receipt: expect.any(Object) });
  });

  it('keeps manual associations when publishing other tags', async () => {
    let manualId = '';
    const f = await tagCandidateFixture(async (catalog, id) => {
      const manual = await catalog.createTag(`manual-${randomUUID()}`);
      manualId = manual.id;
      expect(await catalog.attachTag(id, manualId)).toBe(true);
    });
    expect(await f.catalog.publishTagCandidate({ ...f.candidate, labels: [`generated-${randomUUID()}`] }, f.at)).toMatchObject({ assignmentRevision: 3, catalogEpoch: f.candidate.catalogEpoch + 1, receipt: expect.any(Object) });
    const assigned = await f.catalog.listArticleTags(f.id);
    expect(assigned).toHaveLength(2);
    expect(assigned.some(tag => tag.id === manualId)).toBe(true);
  });

  it('rejects invalid and stale candidates without writes', async () => {
    const f = await tagCandidateFixture();
    const b = { ...f.candidate, labels: [`never-${randomUUID()}`] };
    const before = await f.article(), task = await f.tasks.getTask(f.task.id);
    const bad = [
      { ...b, taskId: randomUUID() }, { ...b, executionToken: randomUUID() }, { ...b, articleId: randomUUID() },
      { ...b, prerequisiteTaskId: randomUUID() }, { ...b, generation: 2 }, { ...b, contentRevision: 2 },
      { ...b, assignmentRevision: 2 }, { ...b, catalogEpoch: b.catalogEpoch + 1 }, { ...b, executionToken: 'bad' },
      { ...b, labels: Array(11).fill('x') }, { ...b, labels: ['  '] }, { ...b, labels: [1] as unknown as string[] }, { ...b, labels: Array(1) as string[] },
    ];
    for (const candidate of bad) expect(await f.catalog.publishTagCandidate(candidate, f.at)).toBeNull();
    expect(await f.article()).toEqual(before);
    expect(await f.tasks.getTask(f.task.id)).toEqual(task);
    expect(await f.catalog.listArticleTags(f.id)).toHaveLength(0);
  });

  it.each(['newer', 'task-article', 'action', 'state', 'prerequisite-missing', 'prerequisite-action', 'prerequisite-failed', 'prerequisite-article', 'content', 'assignment', 'epoch'] as const)('rejects changed %s', async change => {
    const f = await tagCandidateFixture();
    if (change === 'newer') await f.tasks.createTask({ articleId: f.id, action: 'tags', generation: 2, state: 'failed', createdAt: f.at, updatedAt: f.at });
    if (change === 'task-article') await database.pool.query('update processing_tasks set article_id=$2 where id=$1', [f.task.id, articleId]);
    if (change === 'action') await database.pool.query("update processing_tasks set action='summary' where id=$1", [f.task.id]);
    if (change === 'state') await database.pool.query("update processing_tasks set state='failed' where id=$1", [f.task.id]);
    if (change === 'prerequisite-missing') await database.pool.query('update processing_tasks set prerequisite_id=null where id=$1', [f.task.id]);
    if (change === 'prerequisite-action') await database.pool.query("update processing_tasks set action='summary' where id=$1", [f.categoryTask.id]);
    if (change === 'prerequisite-failed') await database.pool.query("update processing_tasks set state='failed' where id=$1", [f.categoryTask.id]);
    if (change === 'prerequisite-article') await database.pool.query('update processing_tasks set article_id=$2 where id=$1', [f.categoryTask.id, articleId]);
    if (change === 'content') await f.edits.content();
    if (change === 'assignment') await f.edits.tag();
    if (change === 'epoch') await f.catalog.createTag(`epoch-${randomUUID()}`);
    const before = await f.article(), task = await f.tasks.getTask(f.task.id);
    expect(await f.catalog.publishTagCandidate({ ...f.candidate, labels: [`never-${randomUUID()}`] }, f.at)).toBeNull();
    expect(await f.article()).toEqual(before);
    expect(await f.tasks.getTask(f.task.id)).toEqual(task);
  });

  it('rolls back new tags and associations on archived identity or task update failure', async () => {
    let archived = '';
    const f = await tagCandidateFixture(async catalog => {
      archived = `archived-${randomUUID()}`;
      const tag = await catalog.createTag(archived);
      await catalog.archiveTag(tag.id, new Date());
    });
    const label = `rollback-${randomUUID()}`;
    const before = await f.article(), task = await f.tasks.getTask(f.task.id);
    expect(await f.catalog.publishTagCandidate({ ...f.candidate, labels: [label, archived.toUpperCase()] }, f.at)).toBeNull();
    expect((await database.pool.query('select id from tags where label=$1', [label])).rowCount).toBe(0);
    await database.pool.query(`create function fail_tag_success() returns trigger language plpgsql as $$ begin if new.id = '${f.task.id}'::uuid and new.state = 'succeeded' then raise exception 'test tag task failure'; end if; return new; end $$`);
    await database.pool.query('create trigger fail_tag_success before update on processing_tasks for each row execute function fail_tag_success()');
    try {
      await expect(f.catalog.publishTagCandidate({ ...f.candidate, labels: [label] }, f.at)).rejects.toThrow();
      expect((await database.pool.query('select id from tags where label=$1', [label])).rowCount).toBe(0);
      expect(await f.article()).toEqual(before);
      expect(await f.tasks.getTask(f.task.id)).toEqual(task);
      expect(await f.catalog.listArticleTags(f.id)).toHaveLength(0);
      expect((await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision).toBe(f.candidate.catalogEpoch);
    } finally {
      await database.pool.query('drop trigger fail_tag_success on processing_tasks');
      await database.pool.query('drop function fail_tag_success()');
    }
  });

  it.each(['newer', 'assignment', 'content'] as const)('serializes a concurrent %s before publication', async change => {
    const f = await tagCandidateFixture();
    const blocker = await database.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select id from articles where id=$1 for update', [f.id]);
      const mutation = change === 'newer' ? f.tasks.createTask({ articleId: f.id, action: 'tags', generation: 2, state: 'failed', createdAt: f.at, updatedAt: f.at }) : f.edits[change === 'assignment' ? 'tag' : 'content']();
      await waitForLockWaiters(1);
      const publication = f.catalog.publishTagCandidate({ ...f.candidate, labels: [`race-${randomUUID()}`] }, f.at);
      await waitForLockWaiters(2);
      await blocker.query('commit');
      await mutation;
      expect(await publication).toBeNull();
      expect(await f.tasks.getTask(f.task.id)).toMatchObject({ state: 'running' });
    } finally { await blocker.query('rollback'); blocker.release(); }
  }, 15000);

  it.each(['newer', 'assignment', 'content'] as const)('serializes publication before a concurrent %s', async change => {
    const f = await tagCandidateFixture();
    const blocker = await database.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select id from processing_tasks where id=$1 for update', [f.task.id]);
      const publication = f.catalog.publishTagCandidate({ ...f.candidate, labels: [`race-${randomUUID()}`] }, f.at);
      await waitForLockWaiters(1);
      const mutation = change === 'newer' ? f.tasks.createTask({ articleId: f.id, action: 'tags', generation: 2, state: 'failed', createdAt: f.at, updatedAt: f.at }) : f.edits[change === 'assignment' ? 'tag' : 'content']();
      await waitForLockWaiters(2);
      await blocker.query('commit');
      expect(await publication).toMatchObject({ assignmentRevision: 2, catalogEpoch: f.candidate.catalogEpoch + 1, receipt: expect.any(Object) });
      await mutation;
      expect(await f.tasks.getTask(f.task.id)).toMatchObject({ state: 'succeeded' });
    } finally { await blocker.query('rollback'); blocker.release(); }
  }, 15000);

  it('does not deadlock a concurrent manual attachment of the same tag', async () => {
    let tag: Awaited<ReturnType<CatalogStore['createTag']>>;
    const f = await tagCandidateFixture(async catalog => { tag = await catalog.createTag(`same-${randomUUID()}`); });
    const blocker = await database.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select id from processing_tasks where id=$1 for update', [f.task.id]);
      const publication = f.catalog.publishTagCandidate({ ...f.candidate, labels: [tag!.label] }, f.at);
      await waitForLockWaiters(1);
      const edit = f.catalog.changeTag(f.id, tag!.id, true);
      await waitForLockWaiters(2);
      await blocker.query('commit');
      expect(await publication).toMatchObject({ assignmentRevision: 2, catalogEpoch: f.candidate.catalogEpoch, receipt: expect.any(Object) });
      expect(await edit).toBe('ok');
      expect(await f.article()).toMatchObject({ assignment_revision: 2 });
    } finally { await blocker.query('rollback'); blocker.release(); }
  }, 15000);

  it.each(['create', 'archive'] as const)('serializes tag %s and publication in both orders', async change => {
    const tag = await new CatalogStore(database.db).createTag(`catalog-race-${randomUUID()}`);
    const first = await tagCandidateFixture();
    const blocker = await database.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select id from catalog_epoch where id=1 for update');
      const mutation = change === 'create' ? first.catalog.createTag(`race-${randomUUID()}`) : first.catalog.archiveTag(tag.id, first.at);
      await waitForLockWaiters(1);
      const publication = first.catalog.publishTagCandidate(first.candidate, first.at);
      await waitForLockWaiters(2);
      await blocker.query('commit');
      await mutation;
      expect(await publication).toBeNull();
    } finally { await blocker.query('rollback'); blocker.release(); }

    const other = await new CatalogStore(database.db).createTag(`catalog-race-${randomUUID()}`);
    const second = await tagCandidateFixture();
    const taskBlocker = await database.pool.connect();
    try {
      await taskBlocker.query('begin');
      await taskBlocker.query('select id from processing_tasks where id=$1 for update', [second.task.id]);
      const publication = second.catalog.publishTagCandidate(second.candidate, second.at);
      await waitForLockWaiters(1);
      const mutation = change === 'create' ? second.catalog.createTag(`race-${randomUUID()}`) : second.catalog.archiveTag(other.id, second.at);
      await waitForLockWaiters(2);
      await taskBlocker.query('commit');
      expect(await publication).toMatchObject({ assignmentRevision: 1, catalogEpoch: second.candidate.catalogEpoch, receipt: expect.any(Object) });
      await mutation;
    } finally { await taskBlocker.query('rollback'); taskBlocker.release(); }
  }, 15000);

  it('rolls back tag creation and archival when the epoch update fails', async () => {
    const f = await tagCandidateFixture();
    const existing = await f.catalog.createTag(`archive-rollback-${randomUUID()}`);
    const label = `create-rollback-${randomUUID()}`;
    const before = (await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision;
    await database.pool.query("create function fail_tag_epoch() returns trigger language plpgsql as $$ begin raise exception 'test tag epoch failure'; end $$");
    await database.pool.query('create trigger fail_tag_epoch before update on catalog_epoch for each row execute function fail_tag_epoch()');
    try {
      await expect(f.catalog.createTag(label)).rejects.toThrow();
      await expect(f.catalog.archiveTag(existing.id, f.at)).rejects.toThrow();
      expect((await database.pool.query('select id from tags where label=$1', [label])).rowCount).toBe(0);
      expect((await database.pool.query('select archived_at from tags where id=$1', [existing.id])).rows[0].archived_at).toBeNull();
      expect((await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision).toBe(before);
    } finally {
      await database.pool.query('drop trigger fail_tag_epoch on catalog_epoch');
      await database.pool.query('drop function fail_tag_epoch()');
    }
  });

  it('advances epoch exactly once for creation and archival, not failed or repeated mutations', async () => {
    const f = await tagCandidateFixture();
    const tag = await f.catalog.createTag(`epoch-${randomUUID()}`);
    await expect(f.catalog.createTag(tag.label)).rejects.toThrow();
    expect((await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision).toBe(f.candidate.catalogEpoch + 1);
    await f.catalog.archiveTag(tag.id, f.at);
    await f.catalog.archiveTag(tag.id, f.at);
    expect((await database.pool.query('select revision from catalog_epoch where id=1')).rows[0].revision).toBe(f.candidate.catalogEpoch + 2);
    expect(await f.catalog.publishTagCandidate(f.candidate, f.at)).toBeNull();
  });
});

describe('direct score candidate publication', () => {
  it('runs a synthetic direct task through atomic score publication', async () => {
    const f = await directCandidateFixture();
    expect(await runDirectScoreTask(f.input, { ai: f.ai, scores: f.scores, tasks: f.tasks, now: () => f.at })).toEqual({ kind: 'published' });
    expect(await f.scores.get(f.id, f.scoreId)).toMatchObject({ value: 75, calculatedAt: f.at, contentRevision: 1, assignmentRevision: 0 });
    expect(await f.tasks.getTask(f.task.id)).toMatchObject({ state: 'succeeded', endedAt: f.at });
  });

  it('rolls back the runner publication if task success fails', async () => {
    const f = await directCandidateFixture();
    const previousScore = await f.scores.get(f.id, f.scoreId);
    await database.pool.query(`create function fail_runner_success() returns trigger language plpgsql as $$ begin if new.id = '${f.task.id}'::uuid and new.state = 'succeeded' then raise exception 'synthetic failure'; end if; return new; end $$`);
    await database.pool.query('create trigger fail_runner_success before update on processing_tasks for each row execute function fail_runner_success()');
    try {
      await expect(runDirectScoreTask(f.input, { ai: f.ai, scores: f.scores, tasks: f.tasks, now: () => f.at })).rejects.toThrow('Score publication failed');
      expect(await f.scores.get(f.id, f.scoreId)).toEqual(previousScore);
      expect(await f.tasks.getTask(f.task.id)).toMatchObject({ state: 'running' });
    } finally {
      await database.pool.query('drop trigger fail_runner_success on processing_tasks');
      await database.pool.query('drop function fail_runner_success()');
    }
  });

  it('publishes score and task together, and refuses a second publication', async () => {
    const f = await directCandidateFixture();
    expect(await f.scores.publishCandidate(f.candidate, f.at)).toBe(true);
    expect(await f.scores.get(f.id, f.scoreId)).toMatchObject({ value: 75, calculatedAt: f.at, contentRevision: 1, assignmentRevision: 0, condensed: false, limited: false });
    expect(await f.tasks.getTask(f.task.id)).toMatchObject({ state: 'succeeded', endedAt: f.at, updatedAt: f.at, errorCode: null });
    expect(await f.scores.publishCandidate(f.candidate, f.at)).toBe(false);
  });

  it('rejects stale or invalid captured bases without changing either row', async () => {
    const f = await directCandidateFixture();
    const beforeScore = await f.scores.get(f.id, f.scoreId);
    const beforeTask = await f.tasks.getTask(f.task.id);
    const b = f.candidate.basis;
    const bad = [
      { ...b, taskId: randomUUID() }, { ...b, executionToken: randomUUID() }, { ...b, articleId: randomUUID() },
      { ...b, scoreId: randomUUID() }, { ...b, contentRevision: 2 }, { ...b, assignmentRevision: 1 },
      { ...b, generation: 2 }, { ...b, catalogEpoch: b.catalogEpoch + 1 }, { ...b, executionToken: 'invalid' },
    ];
    for (const basis of bad) expect(await f.scores.publishCandidate({ ...f.candidate, basis }, f.at)).toBe(false);
    expect(await f.scores.publishCandidate({ ...f.candidate, value: NaN }, f.at)).toBe(false);
    expect(await f.scores.get(f.id, f.scoreId)).toEqual(beforeScore);
    expect(await f.tasks.getTask(f.task.id)).toEqual(beforeTask);
  });

  it.each(['newer', 'target', 'action', 'state', 'disabled', 'deleted', 'epoch', 'content', 'assignment'] as const)('preserves old score when %s changes', async change => {
    const f = await directCandidateFixture();
    const beforeScore = await f.scores.get(f.id, f.scoreId);
    if (change === 'newer') await f.tasks.createTask({ articleId: f.id, action: 'scores', scoreTargetId: f.scoreId, generation: 2, state: 'failed', createdAt: f.at, updatedAt: f.at });
    if (change === 'target') await database.pool.query('update processing_tasks set score_target_id=$2 where id=$1', [f.task.id, randomUUID()]);
    if (change === 'action') await database.pool.query("update processing_tasks set action='summary' where id=$1", [f.task.id]);
    if (change === 'state') await database.pool.query("update processing_tasks set state='failed' where id=$1", [f.task.id]);
    if (change === 'disabled') await database.pool.query('update score_definitions set active=false where id=$1', [f.scoreId]);
    if (change === 'deleted') await database.pool.query('update score_definitions set deleted_at=now() where id=$1', [f.scoreId]);
    if (change === 'epoch') await database.pool.query('update catalog_epoch set revision=revision+1 where id=1');
    if (change === 'content') await f.edits.content();
    if (change === 'assignment') await f.edits.tag();
    const beforeTask = await f.tasks.getTask(f.task.id);
    expect(await f.scores.publishCandidate(f.candidate, f.at)).toBe(false);
    expect(await f.scores.get(f.id, f.scoreId)).toEqual(beforeScore);
    expect(await f.tasks.getTask(f.task.id)).toEqual(beforeTask);
  });

  it.each(['create', 'save', 'update', 'delete', 'prompt-insert', 'prompt-update', 'prompt-delete', 'model-role', 'category-rename', 'category-archive', 'tag-rename'] as const)('fences publication after catalog writer %s', async kind => {
    const catalog = new CatalogStore(database.db);
    const category = await catalog.createCategory(`epoch-${randomUUID()}`);
    const tag = await catalog.createTag(`epoch-${randomUUID()}`);
    const f = await directCandidateFixture(async scoreId => {
      if (kind === 'prompt-update' || kind === 'prompt-delete') {
        expect(await catalog.saveScoreCategoryPrompt(scoreId, category.id, 'before')).toBe('ok');
      }
    });
    const beforeScore = await f.scores.get(f.id, f.scoreId), beforeTask = await f.tasks.getTask(f.task.id);
    const definition = (await catalog.listScoreDefinitions()).find(row => row.id === f.scoreId)!;
    const input = { name: definition.name, description: definition.description, prompt: 'changed', active: definition.active, includeTitle: definition.includeTitle, includeContent: definition.includeContent, includeCategory: definition.includeCategory, includeTagWeights: definition.includeTagWeights, includeSourceWeight: definition.includeSourceWeight };
    if (kind === 'create') await catalog.createScoreDefinition(input);
    if (kind === 'save') await catalog.saveScoreDefinition(f.scoreId, input);
    if (kind === 'update') await catalog.updateScoreDefinition(f.scoreId, { prompt: 'changed' });
    if (kind === 'delete') await catalog.deleteScoreDefinition(f.scoreId, f.at);
    if (kind === 'prompt-insert' || kind === 'prompt-update') expect(await catalog.saveScoreCategoryPrompt(f.scoreId, category.id, 'changed')).toBe('ok');
    if (kind === 'prompt-delete') expect(await catalog.deleteScoreCategoryPrompt(f.scoreId, category.id)).toBe('ok');
    if (kind === 'model-role') await catalog.saveModelRole({ role: 'scores', primary: { provider: 'fixture', model: randomUUID() }, fallback: null });
    if (kind === 'category-rename') await catalog.renameCategory(category.id, `changed-${randomUUID()}`);
    if (kind === 'category-archive') await catalog.archiveCategory(category.id, f.at);
    if (kind === 'tag-rename') await catalog.renameTag(tag.id, `changed-${randomUUID()}`);
    expect((await database.pool.query<{ revision: number }>('select revision from catalog_epoch where id=1')).rows[0]!.revision).toBe(f.candidate.basis.catalogEpoch + 1);
    expect(await f.scores.publishCandidate(f.candidate, f.at)).toBe(false);
    expect(await f.scores.get(f.id, f.scoreId)).toEqual(beforeScore);
    expect(await f.tasks.getTask(f.task.id)).toEqual(beforeTask);
  });

  it('does not advance the epoch for no-ops, missing targets, or rejected mutations', async () => {
    const catalog = new CatalogStore(database.db);
    const f = await directCandidateFixture();
    const category = await catalog.createCategory(`noop-${randomUUID()}`);
    const duplicate = await catalog.createCategory(`collision-${randomUUID()}`);
    const tag = await catalog.createTag(`noop-${randomUUID()}`);
    const definition = (await catalog.listScoreDefinitions()).find(row => row.id === f.scoreId)!;
    const input = { name: definition.name, description: definition.description, prompt: definition.prompt, active: definition.active, includeTitle: definition.includeTitle, includeContent: definition.includeContent, includeCategory: definition.includeCategory, includeTagWeights: definition.includeTagWeights, includeSourceWeight: definition.includeSourceWeight };
    const role = { role: 'scores' as const, primary: { provider: 'fixture', model: randomUUID() }, fallback: null };
    await catalog.saveModelRole(role);
    await catalog.saveScoreCategoryPrompt(f.scoreId, category.id, 'same');
    const stillValid = await directCandidateFixture();
    const epoch = (await database.pool.query<{ revision: number }>('select revision from catalog_epoch where id=1')).rows[0]!.revision;
    await catalog.saveScoreDefinition(f.scoreId, input);
    await catalog.updateScoreDefinition(f.scoreId, { prompt: input.prompt });
    expect(await catalog.updateScoreDefinition(randomUUID(), { prompt: 'changed' })).toBeNull();
    expect(await catalog.deleteScoreDefinition(randomUUID(), f.at)).toBeNull();
    await catalog.saveScoreCategoryPrompt(f.scoreId, category.id, 'same');
    expect(await catalog.saveScoreCategoryPrompt(randomUUID(), category.id, 'missing')).toBe('not_found');
    expect(await catalog.saveScoreCategoryPrompt(f.scoreId, fallback, 'invalid')).toBe('invalid_category');
    await catalog.saveModelRole(role);
    await catalog.renameCategory(category.id, category.label);
    await catalog.renameTag(tag.id, tag.label);
    expect(await catalog.renameCategory(randomUUID(), 'missing')).toBeNull();
    expect(await catalog.renameTag(randomUUID(), 'missing')).toBeNull();
    expect(await catalog.archiveCategory(randomUUID(), f.at)).toBeNull();
    await expect(catalog.renameCategory(category.id, duplicate.label)).rejects.toThrow();
    expect((await database.pool.query<{ revision: number }>('select revision from catalog_epoch where id=1')).rows[0]!.revision).toBe(epoch);
    expect(await stillValid.scores.publishCandidate(stillValid.candidate, stillValid.at)).toBe(true);
    await catalog.deleteScoreCategoryPrompt(f.scoreId, category.id);
    await catalog.deleteScoreDefinition(f.scoreId, f.at);
    await catalog.archiveCategory(category.id, f.at);
    const after = (await database.pool.query<{ revision: number }>('select revision from catalog_epoch where id=1')).rows[0]!.revision;
    await catalog.deleteScoreDefinition(f.scoreId, f.at);
    await catalog.archiveCategory(category.id, f.at);
    expect(await catalog.saveScoreCategoryPrompt(f.scoreId, category.id, 'deleted')).toBe('deleted');
    expect((await database.pool.query<{ revision: number }>('select revision from catalog_epoch where id=1')).rows[0]!.revision).toBe(after);
    const other = await catalog.createCategory(`noop-delete-${randomUUID()}`);
    const last = (await database.pool.query<{ revision: number }>('select revision from catalog_epoch where id=1')).rows[0]!.revision;
    const active = await catalog.createScoreDefinition({ ...input, name: 'other' });
    const created = last + 1;
    expect(await catalog.deleteScoreCategoryPrompt(active.id, other.id)).toBe('ok');
    expect((await database.pool.query<{ revision: number }>('select revision from catalog_epoch where id=1')).rows[0]!.revision).toBe(created);
  });

  it('rolls back a configuration mutation when the epoch update fails', async () => {
    const catalog = new CatalogStore(database.db);
    const f = await directCandidateFixture();
    const before = (await catalog.listScoreDefinitions()).find(row => row.id === f.scoreId);
    await database.pool.query("create function fail_epoch_update() returns trigger language plpgsql as $$ begin raise exception 'test epoch failure'; end $$");
    await database.pool.query('create trigger fail_epoch_update before update on catalog_epoch for each row execute function fail_epoch_update()');
    try {
      await expect(catalog.updateScoreDefinition(f.scoreId, { prompt: 'rolled back' })).rejects.toThrow();
      expect((await catalog.listScoreDefinitions()).find(row => row.id === f.scoreId)).toEqual(before);
      expect((await database.pool.query<{ revision: number }>('select revision from catalog_epoch where id=1')).rows[0]!.revision).toBe(f.candidate.basis.catalogEpoch);
      expect(await f.scores.publishCandidate(f.candidate, f.at)).toBe(true);
    } finally {
      await database.pool.query('drop trigger fail_epoch_update on catalog_epoch');
      await database.pool.query('drop function fail_epoch_update()');
    }
  });

  it('takes the epoch before a definition lock for real writers', async () => {
    const f = await directCandidateFixture();
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      await client.query('select id from score_definitions where id=$1 for update', [f.scoreId]);
      const mutation = new CatalogStore(database.db).updateScoreDefinition(f.scoreId, { prompt: 'concurrent' });
      await waitForLockWaiters(1);
      const publication = f.scores.publishCandidate(f.candidate, f.at);
      await waitForLockWaiters(2);
      await client.query('commit');
      await mutation;
      expect(await publication).toBe(false);
      expect(await f.scores.get(f.id, f.scoreId)).toMatchObject({ value: 20 });
      expect(await f.tasks.getTask(f.task.id)).toMatchObject({ state: 'running' });
    } finally { await client.query('rollback'); client.release(); }
  }, 15000);

  it('ignores a newer generation for a different score target', async () => {
    const f = await directCandidateFixture();
    await f.tasks.createTask({ articleId: f.id, action: 'scores', scoreTargetId: randomUUID(), generation: 2, createdAt: f.at, updatedAt: f.at });
    expect(await f.scores.publishCandidate(f.candidate, f.at)).toBe(true);
  });

  it('rejects a different existing active target', async () => {
    const f = await directCandidateFixture();
    const other = (await database.pool.query<{ id: string }>("insert into score_definitions(name,description,prompt) values ('other','','prompt') returning id")).rows[0]!.id;
    const before = await f.tasks.getTask(f.task.id);
    expect(await f.scores.publishCandidate({ ...f.candidate, basis: { ...f.candidate.basis, scoreId: other } }, f.at)).toBe(false);
    expect(await f.scores.get(f.id, f.scoreId)).toMatchObject({ value: 20 });
    expect(await f.scores.get(f.id, other)).toBeNull();
    expect(await f.tasks.getTask(f.task.id)).toEqual(before);
  });

  it('rolls back the score if the task success update fails', async () => {
    const f = await directCandidateFixture();
    const beforeScore = await f.scores.get(f.id, f.scoreId), beforeTask = await f.tasks.getTask(f.task.id);
    await database.pool.query(`create function fail_candidate_success() returns trigger language plpgsql as $$ begin if new.id = '${f.task.id}'::uuid and new.state = 'succeeded' then raise exception 'test task failure'; end if; return new; end $$`);
    await database.pool.query('create trigger fail_candidate_success before update on processing_tasks for each row execute function fail_candidate_success()');
    try {
      await expect(f.scores.publishCandidate(f.candidate, f.at)).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'test task failure' }) });
      expect(await f.scores.get(f.id, f.scoreId)).toEqual(beforeScore);
      expect(await f.tasks.getTask(f.task.id)).toEqual(beforeTask);
    } finally {
      await database.pool.query('drop trigger fail_candidate_success on processing_tasks');
      await database.pool.query('drop function fail_candidate_success()');
    }
  });

  it('serializes newer task creation on the article lock in both orders', async () => {
    const first = await directCandidateFixture();
    const blocker = await database.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select id from articles where id=$1 for update', [first.id]);
      const newer = first.tasks.createTask({ articleId: first.id, action: 'scores', scoreTargetId: first.scoreId, generation: 2, createdAt: first.at, updatedAt: first.at });
      await waitForLockWaiters(1);
      const publication = first.scores.publishCandidate(first.candidate, first.at);
      await waitForLockWaiters(2);
      await blocker.query('commit');
      await newer;
      expect(await publication).toBe(false);
      expect(await first.scores.get(first.id, first.scoreId)).toMatchObject({ value: 20 });
      expect(await first.tasks.getTask(first.task.id)).toMatchObject({ state: 'running' });
    } finally { await blocker.query('rollback'); blocker.release(); }

    const second = await directCandidateFixture();
    const scoreBlocker = await database.pool.connect();
    try {
      await scoreBlocker.query('begin');
      await scoreBlocker.query('select article_id from article_scores where article_id=$1 and score_id=$2 for update', [second.id, second.scoreId]);
      const publication = second.scores.publishCandidate(second.candidate, second.at);
      await waitForLockWaiters(1);
      const newer = second.tasks.createTask({ articleId: second.id, action: 'scores', scoreTargetId: second.scoreId, generation: 2, createdAt: second.at, updatedAt: second.at });
      await waitForLockWaiters(2);
      await scoreBlocker.query('commit');
      expect(await publication).toBe(true);
      await newer;
      expect(await second.scores.get(second.id, second.scoreId)).toMatchObject({ value: 75 });
      expect(await second.tasks.getTask(second.task.id)).toMatchObject({ state: 'succeeded' });
    } finally { await scoreBlocker.query('rollback'); scoreBlocker.release(); }
  }, 15000);

  it('serializes target deactivation before publication', async () => {
    const f = await directCandidateFixture();
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      await client.query('update score_definitions set active=false where id=$1', [f.scoreId]);
      const publication = f.scores.publishCandidate(f.candidate, f.at);
      await waitForLockWaiters(1);
      await client.query('commit');
      expect(await publication).toBe(false);
      expect(await f.scores.get(f.id, f.scoreId)).toMatchObject({ value: 20 });
      expect(await f.tasks.getTask(f.task.id)).toMatchObject({ state: 'running' });
    } finally { await client.query('rollback'); client.release(); }
  }, 15000);

  it('serializes epoch changes before publication', async () => {
    const f = await directCandidateFixture();
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      await client.query('update catalog_epoch set revision=revision+1 where id=1');
      const publication = f.scores.publishCandidate(f.candidate, f.at);
      await waitForLockWaiters(1);
      await client.query('commit');
      expect(await publication).toBe(false);
      expect(await f.scores.get(f.id, f.scoreId)).toMatchObject({ value: 20 });
      expect(await f.tasks.getTask(f.task.id)).toMatchObject({ state: 'running' });
    } finally { await client.query('rollback'); client.release(); }
  }, 15000);
});

it('consumer-only real receipt tampering rejects a real kernel candidate and preserves the prior score', async () => {
  const context = (await database.pool.query("insert into import_contexts(instance,account) values ($1,'test') returning id", [randomUUID()])).rows[0].id as string;
  const target = (await database.pool.query("insert into score_definitions(name,description,prompt) values ($1,'','prompt') returning id", [randomUUID()])).rows[0].id as string;
  await database.pool.query("update model_roles set provider='fake',model=case role when 'scores' then 'classifier' else 'generator' end where role in ('scores','context_reduction')");
  const at = new Date(), f = await linkedScoreFixture(database, context, target, at), scores = new ScoreStore(database.db);
  expect(await scores.saveSuccessful({ articleId: f.article, scoreId: target, value: 25, calculatedAt: at, contentRevision: 1, assignmentRevision: 0 })).toBe(true);
  const prior = await scores.get(f.article, target), token = randomUUID(); await f.tasks.claimTask(f.score.id, token, at);
  const classifier = { model: { provider: 'fake', model: 'classifier' }, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: () => 1 };
  const loaded = await new ScoreTaskInputStore(database.pool).loadResult(f.score.id, token, { classifier, generator: { ...classifier, model: { provider: 'fake', model: 'generator' } } }, new AbortController().signal);
  if (loaded.kind !== 'loaded') throw new Error(`linked input: ${loaded.kind}`);
  const ai = { classify: async () => ({ kind: 'completed' as const, value: { answers: { score: { type: 'score' as const, score: 4, confidence: 1, criteria: [] } }, usage: null } }), generate: async () => { throw new Error('unexpected generator'); }, createRestrictedSession: async () => { throw new Error('unexpected session'); } };
  const result = await processContextChunks(loaded.input, ai);
  if (result.kind !== 'completed') throw new Error(`linked kernel: ${result.kind}`);
  await database.pool.query("update processing_tasks set result=result-'handoffReceipt' where id=$1", [f.tag.id]);
  expect(await scores.publishCandidate(result.value, at)).toBe(false);
  expect(await scores.get(f.article, target)).toEqual(prior);
  expect(await f.tasks.getTask(f.score.id)).toMatchObject({ state: 'running' });
});
