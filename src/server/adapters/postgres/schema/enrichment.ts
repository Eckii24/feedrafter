import { sql } from "drizzle-orm";
import { boolean, check, date, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { articles } from "./import.js";
import { processingTasks } from "./processing.js";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const categories = pgTable("categories", {
  id: uuid().defaultRandom().primaryKey(),
  label: text().notNull(),
  archivedAt: time("archived_at"),
}, (t) => [check("category_label_nonempty", sql`length(trim(${t.label})) > 0`)]);

export const tags = pgTable("tags", {
  id: uuid().defaultRandom().primaryKey(),
  label: text().notNull(),
  key: text().notNull(),
  archivedAt: time("archived_at"),
  manualOffset: doublePrecision("manual_offset").notNull().default(0),
}, (t) => [unique("tags_key_unique").on(t.key), check("tag_key_nonempty", sql`length(${t.key}) > 0`), check("tag_offset_finite", sql`${t.manualOffset} > '-Infinity'::float8 and ${t.manualOffset} < 'Infinity'::float8`)]);

export const catalogEpoch = pgTable("catalog_epoch", {
  id: integer().primaryKey().default(1),
  revision: integer().notNull().default(0),
}, (t) => [check("catalog_epoch_singleton", sql`${t.id} = 1`), check("catalog_epoch_revision", sql`${t.revision} >= 0`)]);

export const articleTags = pgTable("article_tags", {
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  tagId: uuid("tag_id").notNull().references(() => tags.id),
}, (t) => [primaryKey({ columns: [t.articleId, t.tagId] }), index("article_tags_tag_idx").on(t.tagId)]);

export const articleContents = pgTable("article_contents", {
  articleId: uuid("article_id").primaryKey().references(() => articles.id, { onDelete: "cascade" }),
  revision: integer().notNull(),
  text: text().notNull(),
  sourceUrl: text("source_url"),
  quality: text().notNull(),
  limitation: text(),
  failureCode: text("failure_code"),
  capturedAt: time("captured_at").notNull(),
}, (t) => [check("content_revision_positive", sql`${t.revision} > 0`)]);

export const contextPlans = pgTable("context_plans", {
  id: text().primaryKey(),
  taskId: uuid("task_id").notNull().references(() => processingTasks.id, { onDelete: "cascade" }),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  contentRevision: integer("content_revision").notNull(),
  assignmentRevision: integer("assignment_revision").notNull(),
  generation: integer().notNull(),
  taskKind: text("task_kind").notNull(),
}, (t) => [check("context_plan_identity", sql`${t.id} ~ '^[0-9a-f]{64}$' and ${t.contentRevision} > 0 and ${t.assignmentRevision} >= 0 and ${t.generation} >= 0 and length(${t.taskKind}) > 0`)]);

export const contextCheckpoints = pgTable("context_checkpoints", {
  planId: text("plan_id").primaryKey().references(() => contextPlans.id, { onDelete: "cascade" }),
  state: jsonb().notNull(),
  updatedAt: time("updated_at").notNull(),
}, (t) => [check("context_checkpoint_size", sql`jsonb_typeof(${t.state}) = 'object' and octet_length(${t.state}::text) <= 1048576`)]);

export const contentChunks = pgTable("content_chunks", {
  id: uuid().defaultRandom().primaryKey(),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  contentRevision: integer("content_revision").notNull(),
  ordinal: integer().notNull(),
  startOffset: integer("start_offset").notNull(),
  endOffset: integer("end_offset").notNull(),
  text: text().notNull(),
  planId: text("plan_id").references(() => contextPlans.id, { onDelete: "cascade" }),
  plannerChunkId: text("planner_chunk_id"),
  overlap: integer(),
  startSeconds: doublePrecision("start_seconds"),
  endSeconds: doublePrecision("end_seconds"),
}, (t) => [
  uniqueIndex("legacy_chunk_ordinal").on(t.articleId, t.contentRevision, t.ordinal).where(sql`${t.planId} is null`),
  uniqueIndex("plan_chunk_ordinal").on(t.planId, t.ordinal).where(sql`${t.planId} is not null`),
  uniqueIndex("plan_chunk_identity").on(t.planId, t.plannerChunkId).where(sql`${t.planId} is not null`),
  check("chunk_plan_identity", sql`(${t.planId} is null and ${t.plannerChunkId} is null and ${t.overlap} is null and ${t.startSeconds} is null and ${t.endSeconds} is null) or (${t.planId} is not null and ${t.plannerChunkId} is not null and ${t.plannerChunkId} ~ '^[0-9a-f]{64}$' and ${t.overlap} is not null and ${t.overlap} >= 0)`),
  check("chunk_bounds", sql`${t.contentRevision} > 0 and ${t.ordinal} >= 0 and ${t.startOffset} >= 0 and ${t.endOffset} > ${t.startOffset}`),
]);

export const chunkResults = pgTable("chunk_results", {
  id: uuid().defaultRandom().primaryKey(),
  chunkId: uuid("chunk_id").notNull().references(() => contentChunks.id, { onDelete: "cascade" }),
  generation: integer().notNull(),
  purpose: text().notNull(),
  result: jsonb().notNull(),
  completedAt: time("completed_at").notNull(),
}, (t) => [unique().on(t.chunkId, t.generation, t.purpose), check("chunk_result_generation", sql`${t.generation} >= 0 and length(${t.purpose}) > 0`)]);

export const scoreDefinitions = pgTable("score_definitions", {
  id: uuid().defaultRandom().primaryKey(),
  name: text().notNull(),
  description: text().notNull(),
  prompt: text().notNull(),
  active: boolean().notNull().default(true),
  deletedAt: time("deleted_at"),
  includeTitle: boolean("include_title").notNull().default(true),
  includeContent: boolean("include_content").notNull().default(true),
  includeCategory: boolean("include_category").notNull().default(true),
  includeTagWeights: boolean("include_tag_weights").notNull().default(false),
  includeSourceWeight: boolean("include_source_weight").notNull().default(false),
}, (t) => [check("score_definition_nonempty", sql`length(trim(${t.name})) > 0 and length(trim(${t.prompt})) > 0`)]);

export const scoreCategoryPrompts = pgTable("score_category_prompts", {
  scoreId: uuid("score_id").notNull().references(() => scoreDefinitions.id),
  categoryId: uuid("category_id").notNull().references(() => categories.id),
  prompt: text().notNull(),
}, (t) => [primaryKey({ columns: [t.scoreId, t.categoryId] }), check("score_category_prompt_nonempty", sql`length(trim(${t.prompt})) > 0`)]);

export const articleScores = pgTable("article_scores", {
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  scoreId: uuid("score_id").notNull().references(() => scoreDefinitions.id),
  value: doublePrecision().notNull(),
  calculatedAt: time("calculated_at").notNull(),
  contentRevision: integer("content_revision").notNull(),
  assignmentRevision: integer("assignment_revision").notNull(),
  condensed: boolean().notNull().default(false),
  limited: boolean().notNull().default(false),
}, (t) => [primaryKey({ columns: [t.articleId, t.scoreId] }), check("score_value_range", sql`${t.value} >= 0 and ${t.value} <= 100`), check("score_basis_revisions", sql`${t.contentRevision} >= 0 and ${t.assignmentRevision} >= 0`), index("article_scores_sort_idx").on(t.scoreId, t.value)]);

export const modelRoles = pgTable("model_roles", {
  role: text().primaryKey(),
  provider: text(),
  model: text(),
  fallbackProvider: text("fallback_provider"),
  fallbackModel: text("fallback_model"),
}, (t) => [check("model_role_name", sql`${t.role} in ('quality', 'category', 'tags', 'scores', 'extraction_agent', 'context_reduction', 'summary', 'chat', 'transcription')`), check("model_role_pair", sql`(${t.provider} is null and ${t.model} is null or ${t.provider} is not null and ${t.model} is not null and length(${t.provider}) > 0 and length(${t.model}) > 0) and (${t.fallbackProvider} is null and ${t.fallbackModel} is null or ${t.fallbackProvider} is not null and ${t.fallbackModel} is not null and length(${t.fallbackProvider}) > 0 and length(${t.fallbackModel}) > 0) and (${t.fallbackProvider} is null or ${t.provider} is not null)`)]);

export const usageLedger = pgTable("usage_ledger", {
  id: uuid().defaultRandom().primaryKey(),
  bucket: text().notNull(),
  role: text().notNull().references(() => modelRoles.role),
  provider: text().notNull(),
  model: text().notNull(),
  occurredAt: time("occurred_at").notNull(),
  status: text().notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  audioSeconds: doublePrecision("audio_seconds"),
  ownerToken: uuid("owner_token"),
  ownerPid: integer("owner_pid"),
  ownerBackendStart: timestamp("owner_backend_start", { withTimezone: true, mode: "string" }),
  settledAt: time("settled_at"),
  outcomeCode: text("outcome_code"),
  taskId: text("task_id"),
  turnId: text("turn_id"),
  costUsd: doublePrecision("cost_usd"),
  tokensSource: text("tokens_source").notNull().default("unknown"),
  costSource: text("cost_source").notNull().default("unknown"),
}, (t) => [
  check("usage_bucket", sql`${t.bucket} in ('automatic', 'interactive', 'classifier', 'transcription')`),
  check("usage_status", sql`${t.status} in ('reserved', 'succeeded', 'failed', 'uncertain')`),
  check("usage_amounts", sql`(${t.inputTokens} is null or ${t.inputTokens} >= 0) and (${t.outputTokens} is null or ${t.outputTokens} >= 0) and (${t.audioSeconds} is null or (${t.audioSeconds} >= 0 and ${t.audioSeconds} < 'Infinity'::float8)) and (${t.costUsd} is null or (${t.costUsd} >= 0 and ${t.costUsd} < 'Infinity'::float8))`),
  check("usage_sources", sql`${t.tokensSource} in ('provider', 'unknown') and ${t.costSource} in ('provider', 'unknown')`),
  check("usage_owner_tuple", sql`(${t.ownerToken} is null and ${t.ownerPid} is null and ${t.ownerBackendStart} is null) or (${t.ownerToken} is not null and ${t.ownerPid} is not null and ${t.ownerPid} > 0 and ${t.ownerBackendStart} is not null)`),
  check("usage_reserved_owner", sql`${t.status} <> 'reserved' or (${t.ownerToken} is not null and ${t.ownerPid} is not null and ${t.ownerBackendStart} is not null and ${t.settledAt} is null)`),
  unique("usage_owner_token_unique").on(t.ownerToken),
  index("usage_reserved_idx").on(t.bucket, t.id).where(sql`${t.status} = 'reserved'`),
  index("usage_occurred_idx").on(t.bucket, t.occurredAt),
]);

export const budgetSettings = pgTable("budget_settings", {
  bucket: text().primaryKey(),
  dailyRequests: integer("daily_requests"),
  concurrency: integer(),
  dailyAudioSeconds: doublePrecision("daily_audio_seconds"),
}, (t) => [check("budget_bucket", sql`${t.bucket} in ('automatic', 'interactive', 'classifier', 'transcription')`), check("budget_limits", sql`(${t.dailyRequests} is null or ${t.dailyRequests} >= 0) and (${t.concurrency} is null or ${t.concurrency} >= 0) and (${t.dailyAudioSeconds} is null or (${t.dailyAudioSeconds} >= 0 and ${t.dailyAudioSeconds} < 'Infinity'::float8))`)]);

export const requestCounters = pgTable("request_counters", {
  dayUtc: date("day_utc").notNull(),
  bucket: text().notNull(),
  requests: integer().notNull().default(0),
}, (t) => [primaryKey({ columns: [t.dayUtc, t.bucket] }), check("counter_bucket", sql`${t.bucket} in ('automatic', 'interactive', 'classifier', 'transcription')`), check("counter_requests", sql`${t.requests} >= 0`)]);
