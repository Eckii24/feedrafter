CREATE TABLE "freshrss_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"eligible" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"diagnostic" text,
	CONSTRAINT "freshrss_acknowledgements_context_id_article_id_unique" UNIQUE("context_id","article_id"),
	CONSTRAINT "ack_status" CHECK ("freshrss_acknowledgements"."status" in ('pending', 'confirmed')),
	CONSTRAINT "ack_attempts" CHECK ("freshrss_acknowledgements"."attempts" >= 0),
	CONSTRAINT "ack_confirmation" CHECK (("freshrss_acknowledgements"."status" = 'confirmed') = ("freshrss_acknowledgements"."confirmed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"import_enabled" boolean DEFAULT true NOT NULL,
	"import_interval_seconds" integer DEFAULT 14400 NOT NULL,
	"next_import_at" timestamp with time zone,
	CONSTRAINT "settings_singleton" CHECK ("app_settings"."id" = 1),
	CONSTRAINT "settings_interval" CHECK ("app_settings"."import_interval_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_id" uuid NOT NULL,
	"freshrss_id" text NOT NULL,
	"source_id" uuid,
	"title" text,
	"url" text,
	"author" text,
	"published_at" timestamp with time zone,
	"imported_at" timestamp with time zone NOT NULL,
	"kind" text DEFAULT 'article' NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"assignment_revision" integer DEFAULT 0 NOT NULL,
	"content_revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "articles_context_id_freshrss_id_unique" UNIQUE("context_id","freshrss_id"),
	CONSTRAINT "articles_context_id_id_unique" UNIQUE("context_id","id"),
	CONSTRAINT "article_external_id_nonempty" CHECK (length("articles"."freshrss_id") > 0),
	CONSTRAINT "article_kind" CHECK ("articles"."kind" in ('article', 'video')),
	CONSTRAINT "article_revisions" CHECK ("articles"."assignment_revision" >= 0 and "articles"."content_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "import_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance" text NOT NULL,
	"account" text NOT NULL,
	CONSTRAINT "import_contexts_instance_account_unique" UNIQUE("instance","account"),
	CONSTRAINT "context_identity_nonempty" CHECK (length("import_contexts"."instance") > 0 and length("import_contexts"."account") > 0)
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_id" uuid NOT NULL,
	"external_feed_id" text NOT NULL,
	"title" text,
	CONSTRAINT "sources_context_id_external_feed_id_unique" UNIQUE("context_id","external_feed_id"),
	CONSTRAINT "sources_context_id_id_unique" UNIQUE("context_id","id"),
	CONSTRAINT "source_external_id_nonempty" CHECK (length("sources"."external_feed_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "processing_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT 'fetch' NOT NULL,
	"fetched_count" integer DEFAULT 0 NOT NULL,
	"pending_count" integer DEFAULT 0 NOT NULL,
	"confirmed_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"error_code" text,
	"execution_owner" uuid,
	CONSTRAINT "run_status" CHECK ("processing_runs"."status" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "run_phase" CHECK ("processing_runs"."phase" in ('fetch', 'ack', 'complete')),
	CONSTRAINT "run_counts" CHECK ("processing_runs"."fetched_count" >= 0 and "processing_runs"."pending_count" >= 0 and "processing_runs"."confirmed_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "processing_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"action" text NOT NULL,
	"score_target_id" uuid,
	"generation" integer DEFAULT 0 NOT NULL,
	"execution_token" uuid,
	"state" text DEFAULT 'queued' NOT NULL,
	"prerequisite_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"error_code" text,
	"result" jsonb,
	"job_id" uuid,
	CONSTRAINT "task_state" CHECK ("processing_tasks"."state" in ('waiting_dependency', 'queued', 'running', 'retry_wait', 'paused_budget', 'paused_auth', 'needs_input', 'failed', 'succeeded', 'superseded')),
	CONSTRAINT "task_counts" CHECK ("processing_tasks"."generation" >= 0 and "processing_tasks"."attempt_count" >= 0 and length("processing_tasks"."action") > 0),
	CONSTRAINT "task_result_size" CHECK ("processing_tasks"."result" is null or (jsonb_typeof("processing_tasks"."result") = 'object' and octet_length("processing_tasks"."result"::text) <= 16384))
);
--> statement-breakpoint
ALTER TABLE "freshrss_acknowledgements" ADD CONSTRAINT "freshrss_acknowledgements_context_id_article_id_articles_context_id_id_fk" FOREIGN KEY ("context_id","article_id") REFERENCES "public"."articles"("context_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_context_id_import_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."import_contexts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_context_id_source_id_sources_context_id_id_fk" FOREIGN KEY ("context_id","source_id") REFERENCES "public"."sources"("context_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_context_id_import_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."import_contexts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_context_id_import_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."import_contexts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_tasks" ADD CONSTRAINT "processing_tasks_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_tasks" ADD CONSTRAINT "processing_tasks_prerequisite_id_processing_tasks_id_fk" FOREIGN KEY ("prerequisite_id") REFERENCES "public"."processing_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ack_pending_idx" ON "freshrss_acknowledgements" USING btree ("context_id","eligible") WHERE "freshrss_acknowledgements"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "articles_reader_date_idx" ON "articles" USING btree ("is_read",coalesce("published_at", "imported_at") desc,"id");--> statement-breakpoint
CREATE INDEX "articles_source_idx" ON "articles" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_import_per_context" ON "processing_runs" USING btree ("context_id") WHERE "processing_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_task_per_generation" ON "processing_tasks" USING btree ("article_id","action",coalesce("score_target_id", '00000000-0000-0000-0000-000000000000'::uuid),"generation") WHERE "processing_tasks"."state" in ('waiting_dependency', 'queued', 'running', 'retry_wait', 'paused_budget', 'paused_auth', 'needs_input');--> statement-breakpoint
CREATE INDEX "tasks_article_idx" ON "processing_tasks" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "tasks_state_idx" ON "processing_tasks" USING btree ("state");