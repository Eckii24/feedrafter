import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/server/adapters/postgres/client.js";
import { migrateDatabase } from "../../src/server/adapters/postgres/migrate.js";
import { ScoreStore } from "../../src/server/adapters/postgres/score-store.js";
import { ContentStore } from "../../src/server/adapters/postgres/content-store.js";
import { CatalogStore } from "../../src/server/adapters/postgres/catalog-store.js";
import { UsageStore } from "../../src/server/adapters/postgres/usage-store.js";

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
    const result = { articleId, scoreId: score, value: 75, calculatedAt: new Date('2026-01-01Z'), contentRevision: 1, assignmentRevision: 0 };
    await store.saveSuccessful(result);
    await expect(store.saveSuccessful({ ...result, value: NaN })).rejects.toThrow();
    await expect(store.saveSuccessful({ ...result, value: 80, contentRevision: -1 })).rejects.toThrow();
    expect(await store.get(articleId, score)).toMatchObject({ value: 75, contentRevision: 1 });
    await expect(database.pool.query("update article_scores set value='NaN' where article_id=$1", [articleId])).rejects.toThrow();
    expect((await database.pool.query("select value from article_scores where article_id=$1", [articleId])).rows[0].value).toBe(75);
    await database.pool.query("update score_definitions set active=false, deleted_at=now() where id=$1", [score]);
    await expect(database.pool.query("delete from score_definitions where id=$1", [score])).rejects.toThrow();
    const unreferenced = await database.pool.query("insert into score_definitions(name, description, prompt) values ('temporary', '', 'prompt') returning id");
    await expect(database.pool.query("delete from score_definitions where id=$1", [unreferenced.rows[0].id])).rejects.toThrow();
    expect((await database.pool.query("select value from article_scores where article_id=$1", [articleId])).rows[0].value).toBe(75);
  });
});
