CREATE TABLE "budget_settings" (
  "bucket" text PRIMARY KEY NOT NULL,
  "daily_requests" integer,
  "concurrency" integer,
  "daily_audio_seconds" double precision,
  CONSTRAINT "budget_bucket" CHECK ("bucket" in ('automatic', 'interactive', 'classifier', 'transcription')),
  CONSTRAINT "budget_limits" CHECK (("daily_requests" is null or "daily_requests" >= 0) and ("concurrency" is null or "concurrency" >= 0) and ("daily_audio_seconds" is null or ("daily_audio_seconds" >= 0 and "daily_audio_seconds" < 'Infinity'::float8)))
);
--> statement-breakpoint
INSERT INTO budget_settings (bucket, daily_requests, concurrency) VALUES
 ('automatic', 50, 1), ('interactive', 50, 1), ('classifier', 2000, 2), ('transcription', NULL, NULL)
ON CONFLICT (bucket) DO NOTHING;
