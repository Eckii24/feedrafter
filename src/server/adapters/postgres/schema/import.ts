import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { categories } from "./enrichment.js";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const importContexts = pgTable("import_contexts", {
  id: uuid().defaultRandom().primaryKey(),
  instance: text().notNull(),
  account: text().notNull(),
}, (t) => [unique().on(t.instance, t.account), check("context_identity_nonempty", sql`length(${t.instance}) > 0 and length(${t.account}) > 0`)]);

export const sources = pgTable("sources", {
  id: uuid().defaultRandom().primaryKey(),
  contextId: uuid("context_id").notNull().references(() => importContexts.id),
  externalFeedId: text("external_feed_id").notNull(),
  title: text(),
  manualOffset: doublePrecision("manual_offset").notNull().default(0),
  permissionOverride: boolean("permission_override"),
}, (t) => [
  check("source_offset_finite", sql`${t.manualOffset} > '-Infinity'::float8 and ${t.manualOffset} < 'Infinity'::float8`),
  unique().on(t.contextId, t.externalFeedId),
  unique().on(t.contextId, t.id),
  check("source_external_id_nonempty", sql`length(${t.externalFeedId}) > 0`),
]);

export const articles = pgTable("articles", {
  id: uuid().defaultRandom().primaryKey(),
  contextId: uuid("context_id").notNull().references(() => importContexts.id),
  freshrssId: text("freshrss_id").notNull(),
  sourceId: uuid("source_id"),
  categoryId: uuid("category_id").notNull().default("00000000-0000-4000-8000-000000000001").references(() => categories.id),
  title: text(),
  url: text(),
  author: text(),
  publishedAt: time("published_at"),
  importedAt: time("imported_at").notNull(),
  kind: text().notNull().default("article"),
  isRead: boolean("is_read").notNull().default(false),
  mailState: text("mail_state").notNull().default("not_selected"),
  mailSelectedAt: time("mail_selected_at"),
  assignmentRevision: integer("assignment_revision").notNull().default(0),
  contentRevision: integer("content_revision").notNull().default(0),
}, (t) => [
  unique().on(t.contextId, t.freshrssId),
  unique().on(t.contextId, t.id),
  foreignKey({ columns: [t.contextId, t.sourceId], foreignColumns: [sources.contextId, sources.id] }),
  check("article_external_id_nonempty", sql`length(${t.freshrssId}) > 0`),
  check("article_kind", sql`${t.kind} in ('article', 'video')`),
  check("article_mail_state", sql`${t.mailState} in ('not_selected', 'selected', 'sent') and ((${t.mailState} = 'not_selected') = (${t.mailSelectedAt} is null))`),
  index("articles_mail_queue_idx").on(t.mailSelectedAt, t.id).where(sql`${t.mailState} = 'selected'`),
  check("article_revisions", sql`${t.assignmentRevision} >= 0 and ${t.contentRevision} >= 0`),
  index("articles_reader_date_idx").on(t.isRead, sql`coalesce(${t.publishedAt}, ${t.importedAt}) desc`, t.id),
  index("articles_source_idx").on(t.sourceId),
  index("articles_category_idx").on(t.categoryId),
]);

export const acknowledgements = pgTable("freshrss_acknowledgements", {
  id: uuid().defaultRandom().primaryKey(),
  contextId: uuid("context_id").notNull(),
  articleId: uuid("article_id").notNull(),
  status: text().notNull().default("pending"),
  eligible: boolean().notNull().default(false),
  attempts: integer().notNull().default(0),
  lastAttemptAt: time("last_attempt_at"),
  confirmedAt: time("confirmed_at"),
  diagnostic: text(),
}, (t) => [
  foreignKey({ columns: [t.contextId, t.articleId], foreignColumns: [articles.contextId, articles.id] }),
  unique().on(t.contextId, t.articleId),
  check("ack_status", sql`${t.status} in ('pending', 'confirmed')`),
  check("ack_attempts", sql`${t.attempts} >= 0`),
  check("ack_confirmation", sql`(${t.status} = 'confirmed') = (${t.confirmedAt} is not null)`),
  index("ack_pending_idx").on(t.contextId, t.eligible).where(sql`${t.status} = 'pending'`),
]);

export const appSettings = pgTable("app_settings", {
  id: integer().primaryKey().default(1),
  importEnabled: boolean("import_enabled").notNull().default(true),
  importIntervalSeconds: integer("import_interval_seconds").notNull().default(14400),
  nextImportAt: time("next_import_at"),
  preferenceHalfLifeDays: doublePrecision("preference_half_life_days").notNull().default(90),
}, (t) => [
  check("settings_preference_half_life", sql`${t.preferenceHalfLifeDays} > 0 and ${t.preferenceHalfLifeDays} < 'Infinity'::float8`),
  check("settings_singleton", sql`${t.id} = 1`),
  check("settings_interval", sql`${t.importIntervalSeconds} > 0`),
]);
