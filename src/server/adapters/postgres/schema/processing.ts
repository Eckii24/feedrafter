import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { articles, importContexts } from "./import.js";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const processingRuns = pgTable("processing_runs", {
  id: uuid().defaultRandom().primaryKey(),
  contextId: uuid("context_id").notNull().references(() => importContexts.id),
  status: text().notNull().default("queued"),
  phase: text().notNull().default("fetch"),
  fetchedCount: integer("fetched_count").notNull().default(0),
  pendingCount: integer("pending_count").notNull().default(0),
  confirmedCount: integer("confirmed_count").notNull().default(0),
  startedAt: time("started_at").notNull(),
  endedAt: time("ended_at"),
  errorCode: text("error_code"),
  executionOwner: uuid("execution_owner"),
}, (t) => [
  check("run_status", sql`${t.status} in ('queued', 'running', 'succeeded', 'failed')`),
  check("run_phase", sql`${t.phase} in ('fetch', 'ack', 'complete')`),
  check("run_counts", sql`${t.fetchedCount} >= 0 and ${t.pendingCount} >= 0 and ${t.confirmedCount} >= 0`),
  uniqueIndex("one_active_import_per_context").on(t.contextId).where(sql`${t.status} in ('queued', 'running')`),
]);

export const processingTasks = pgTable("processing_tasks", {
  id: uuid().defaultRandom().primaryKey(),
  articleId: uuid("article_id").notNull().references(() => articles.id),
  action: text().notNull(),
  scoreTargetId: uuid("score_target_id"),
  generation: integer().notNull().default(0),
  executionToken: uuid("execution_token"),
  state: text().notNull().default("queued"),
  prerequisiteId: uuid("prerequisite_id"),
  attemptCount: integer("attempt_count").notNull().default(0),
  createdAt: time("created_at").notNull(),
  updatedAt: time("updated_at").notNull(),
  startedAt: time("started_at"),
  endedAt: time("ended_at"),
  errorCode: text("error_code"),
  result: jsonb().$type<Record<string, unknown>>(),
  jobId: uuid("job_id"),
}, (t) => [
  foreignKey({ columns: [t.prerequisiteId], foreignColumns: [t.id] }),
  check("task_state", sql`${t.state} in ('waiting_dependency', 'queued', 'running', 'retry_wait', 'paused_budget', 'paused_auth', 'needs_input', 'failed', 'succeeded', 'superseded')`),
  check("task_counts", sql`${t.generation} >= 0 and ${t.attemptCount} >= 0 and length(${t.action}) > 0`),
  check("task_result_size", sql`${t.result} is null or (jsonb_typeof(${t.result}) = 'object' and octet_length(${t.result}::text) <= 16384)`),
  uniqueIndex("one_active_task_per_generation").on(t.articleId, t.action, sql`coalesce(${t.scoreTargetId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.generation).where(sql`${t.state} in ('waiting_dependency', 'queued', 'running', 'retry_wait', 'paused_budget', 'paused_auth', 'needs_input')`),
  index("tasks_article_idx").on(t.articleId),
  index("tasks_state_idx").on(t.state),
]);
