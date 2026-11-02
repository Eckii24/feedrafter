ALTER TABLE "usage_ledger" DROP CONSTRAINT "usage_status";--> statement-breakpoint
ALTER TABLE "usage_ledger" DROP CONSTRAINT "usage_amounts";--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "owner_token" uuid;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "owner_pid" integer;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "owner_backend_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "outcome_code" text;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "tokens_source" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "cost_source" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_status" CHECK ("usage_ledger"."status" in ('reserved', 'succeeded', 'failed', 'uncertain'));--> statement-breakpoint
UPDATE "usage_ledger" SET "status" = 'uncertain', "outcome_code" = 'legacy_ownerless_reservation', "settled_at" = now() WHERE "status" = 'reserved' AND "owner_token" IS NULL;--> statement-breakpoint
CREATE INDEX "usage_reserved_idx" ON "usage_ledger" USING btree ("bucket","id") WHERE "usage_ledger"."status" = 'reserved';--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_owner_token_unique" UNIQUE("owner_token");--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_sources" CHECK ("usage_ledger"."tokens_source" in ('provider', 'unknown') and "usage_ledger"."cost_source" in ('provider', 'unknown'));--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_owner_tuple" CHECK (("usage_ledger"."owner_token" is null and "usage_ledger"."owner_pid" is null and "usage_ledger"."owner_backend_start" is null) or ("usage_ledger"."owner_token" is not null and "usage_ledger"."owner_pid" is not null and "usage_ledger"."owner_pid" > 0 and "usage_ledger"."owner_backend_start" is not null));--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_reserved_owner" CHECK ("usage_ledger"."status" <> 'reserved' or ("usage_ledger"."owner_token" is not null and "usage_ledger"."owner_pid" is not null and "usage_ledger"."owner_backend_start" is not null and "usage_ledger"."settled_at" is null));--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_amounts" CHECK (("usage_ledger"."input_tokens" is null or "usage_ledger"."input_tokens" >= 0) and ("usage_ledger"."output_tokens" is null or "usage_ledger"."output_tokens" >= 0) and ("usage_ledger"."audio_seconds" is null or ("usage_ledger"."audio_seconds" >= 0 and "usage_ledger"."audio_seconds" < 'Infinity'::float8)) and ("usage_ledger"."cost_usd" is null or ("usage_ledger"."cost_usd" >= 0 and "usage_ledger"."cost_usd" < 'Infinity'::float8)));