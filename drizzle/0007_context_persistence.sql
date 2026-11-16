CREATE TABLE "context_checkpoints" (
	"plan_id" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "context_checkpoint_size" CHECK (jsonb_typeof("context_checkpoints"."state") = 'object' and octet_length("context_checkpoints"."state"::text) <= 1048576)
);
--> statement-breakpoint
CREATE TABLE "context_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"content_revision" integer NOT NULL,
	"assignment_revision" integer NOT NULL,
	"generation" integer NOT NULL,
	"task_kind" text NOT NULL,
	CONSTRAINT "context_plan_identity" CHECK ("context_plans"."id" ~ '^[0-9a-f]{64}$' and "context_plans"."content_revision" > 0 and "context_plans"."assignment_revision" >= 0 and "context_plans"."generation" >= 0 and length("context_plans"."task_kind") > 0)
);
--> statement-breakpoint
ALTER TABLE "content_chunks" DROP CONSTRAINT "content_chunks_article_id_content_revision_ordinal_unique";--> statement-breakpoint
ALTER TABLE "content_chunks" ADD COLUMN "plan_id" text;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD COLUMN "planner_chunk_id" text;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD COLUMN "overlap" integer;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD COLUMN "start_seconds" double precision;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD COLUMN "end_seconds" double precision;--> statement-breakpoint
ALTER TABLE "context_checkpoints" ADD CONSTRAINT "context_checkpoints_plan_id_context_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."context_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_plans" ADD CONSTRAINT "context_plans_task_id_processing_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."processing_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_plans" ADD CONSTRAINT "context_plans_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD CONSTRAINT "content_chunks_plan_id_context_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."context_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_chunk_ordinal" ON "content_chunks" USING btree ("article_id","content_revision","ordinal") WHERE "content_chunks"."plan_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_chunk_ordinal" ON "content_chunks" USING btree ("plan_id","ordinal") WHERE "content_chunks"."plan_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_chunk_identity" ON "content_chunks" USING btree ("plan_id","planner_chunk_id") WHERE "content_chunks"."plan_id" is not null;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD CONSTRAINT "chunk_plan_identity" CHECK (("content_chunks"."plan_id" is null and "content_chunks"."planner_chunk_id" is null and "content_chunks"."overlap" is null and "content_chunks"."start_seconds" is null and "content_chunks"."end_seconds" is null) or ("content_chunks"."plan_id" is not null and "content_chunks"."planner_chunk_id" is not null and "content_chunks"."planner_chunk_id" ~ '^[0-9a-f]{64}$' and "content_chunks"."overlap" is not null and "content_chunks"."overlap" >= 0));