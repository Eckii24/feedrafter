CREATE TABLE "catalog_epoch" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "catalog_epoch_singleton" CHECK ("catalog_epoch"."id" = 1),
	CONSTRAINT "catalog_epoch_revision" CHECK ("catalog_epoch"."revision" >= 0)
);
--> statement-breakpoint
INSERT INTO "catalog_epoch" ("id", "revision") VALUES (1, 0);
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "preference_half_life_days" double precision DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "manual_offset" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "manual_offset" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "settings_preference_half_life" CHECK ("app_settings"."preference_half_life_days" > 0 and "app_settings"."preference_half_life_days" < 'Infinity'::float8);--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "source_offset_finite" CHECK ("sources"."manual_offset" > '-Infinity'::float8 and "sources"."manual_offset" < 'Infinity'::float8);--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tag_offset_finite" CHECK ("tags"."manual_offset" > '-Infinity'::float8 and "tags"."manual_offset" < 'Infinity'::float8);