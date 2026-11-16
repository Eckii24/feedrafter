CREATE TABLE "source_permission_host_rules" (
	"host" text PRIMARY KEY NOT NULL,
	"allowed" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "permission_override" boolean;
--> statement-breakpoint
INSERT INTO "source_permission_host_rules" ("host", "allowed") VALUES
  ('youtube.com', true),
  ('www.youtube.com', true),
  ('m.youtube.com', true),
  ('youtu.be', true)
ON CONFLICT ("host") DO NOTHING;
