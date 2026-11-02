CREATE TABLE "article_contents" (
	"article_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"text" text NOT NULL,
	"source_url" text,
	"quality" text NOT NULL,
	"limitation" text,
	"failure_code" text,
	"captured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "content_revision_positive" CHECK ("article_contents"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "article_scores" (
	"article_id" uuid NOT NULL,
	"score_id" uuid NOT NULL,
	"value" double precision NOT NULL,
	"calculated_at" timestamp with time zone NOT NULL,
	"content_revision" integer NOT NULL,
	"assignment_revision" integer NOT NULL,
	"condensed" boolean DEFAULT false NOT NULL,
	"limited" boolean DEFAULT false NOT NULL,
	CONSTRAINT "article_scores_article_id_score_id_pk" PRIMARY KEY("article_id","score_id"),
	CONSTRAINT "score_value_range" CHECK ("article_scores"."value" >= 0 and "article_scores"."value" <= 100),
	CONSTRAINT "score_basis_revisions" CHECK ("article_scores"."content_revision" >= 0 and "article_scores"."assignment_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "article_tags" (
	"article_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "article_tags_article_id_tag_id_pk" PRIMARY KEY("article_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "category_label_nonempty" CHECK (length(trim("categories"."label")) > 0)
);
--> statement-breakpoint
CREATE TABLE "chunk_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chunk_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"purpose" text NOT NULL,
	"result" jsonb NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chunk_results_chunk_id_generation_purpose_unique" UNIQUE("chunk_id","generation","purpose"),
	CONSTRAINT "chunk_result_generation" CHECK ("chunk_results"."generation" >= 0 and length("chunk_results"."purpose") > 0)
);
--> statement-breakpoint
CREATE TABLE "content_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"content_revision" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "content_chunks_article_id_content_revision_ordinal_unique" UNIQUE("article_id","content_revision","ordinal"),
	CONSTRAINT "chunk_bounds" CHECK ("content_chunks"."content_revision" > 0 and "content_chunks"."ordinal" >= 0 and "content_chunks"."start_offset" >= 0 and "content_chunks"."end_offset" > "content_chunks"."start_offset")
);
--> statement-breakpoint
CREATE TABLE "model_roles" (
	"role" text PRIMARY KEY NOT NULL,
	"provider" text,
	"model" text,
	"fallback_provider" text,
	"fallback_model" text,
	CONSTRAINT "model_role_name" CHECK ("model_roles"."role" in ('quality', 'category', 'tags', 'scores', 'extraction_agent', 'context_reduction', 'summary', 'chat', 'transcription')),
	CONSTRAINT "model_role_pair" CHECK (("model_roles"."provider" is null and "model_roles"."model" is null or "model_roles"."provider" is not null and "model_roles"."model" is not null and length("model_roles"."provider") > 0 and length("model_roles"."model") > 0) and ("model_roles"."fallback_provider" is null and "model_roles"."fallback_model" is null or "model_roles"."fallback_provider" is not null and "model_roles"."fallback_model" is not null and length("model_roles"."fallback_provider") > 0 and length("model_roles"."fallback_model") > 0) and ("model_roles"."fallback_provider" is null or "model_roles"."provider" is not null))
);
--> statement-breakpoint
CREATE TABLE "request_counters" (
	"day_utc" date NOT NULL,
	"bucket" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "request_counters_day_utc_bucket_pk" PRIMARY KEY("day_utc","bucket"),
	CONSTRAINT "counter_bucket" CHECK ("request_counters"."bucket" in ('automatic', 'interactive', 'classifier', 'transcription')),
	CONSTRAINT "counter_requests" CHECK ("request_counters"."requests" >= 0)
);
--> statement-breakpoint
CREATE TABLE "score_category_prompts" (
	"score_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	CONSTRAINT "score_category_prompts_score_id_category_id_pk" PRIMARY KEY("score_id","category_id"),
	CONSTRAINT "score_category_prompt_nonempty" CHECK (length(trim("score_category_prompts"."prompt")) > 0)
);
--> statement-breakpoint
CREATE TABLE "score_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"prompt" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"include_title" boolean DEFAULT true NOT NULL,
	"include_content" boolean DEFAULT true NOT NULL,
	"include_category" boolean DEFAULT true NOT NULL,
	"include_tag_weights" boolean DEFAULT false NOT NULL,
	"include_source_weight" boolean DEFAULT false NOT NULL,
	CONSTRAINT "score_definition_nonempty" CHECK (length(trim("score_definitions"."name")) > 0 and length(trim("score_definitions"."prompt")) > 0)
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"key" text NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "tags_key_unique" UNIQUE("key"),
	CONSTRAINT "tag_key_nonempty" CHECK (length("tags"."key") > 0)
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket" text NOT NULL,
	"role" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"audio_seconds" double precision,
	CONSTRAINT "usage_bucket" CHECK ("usage_ledger"."bucket" in ('automatic', 'interactive', 'classifier', 'transcription')),
	CONSTRAINT "usage_status" CHECK ("usage_ledger"."status" in ('reserved', 'succeeded', 'failed')),
	CONSTRAINT "usage_amounts" CHECK (("usage_ledger"."input_tokens" is null or "usage_ledger"."input_tokens" >= 0) and ("usage_ledger"."output_tokens" is null or "usage_ledger"."output_tokens" >= 0) and ("usage_ledger"."audio_seconds" is null or ("usage_ledger"."audio_seconds" >= 0 and "usage_ledger"."audio_seconds" < 'Infinity'::float8)))
);
--> statement-breakpoint
-- Stable seed IDs: conflict handling deliberately preserves all user edits.
INSERT INTO categories (id, label) VALUES
 ('00000000-0000-4000-8000-000000000001', 'Nicht zugeordnet'),
 ('00000000-0000-4000-8000-000000000002', 'KI & Agenten'),
 ('00000000-0000-4000-8000-000000000003', 'Softwarearchitektur & Engineering'),
 ('00000000-0000-4000-8000-000000000004', 'Entwicklerwerkzeuge & Plattformen'),
 ('00000000-0000-4000-8000-000000000005', 'Homelab, DevOps & Smart Home'),
 ('00000000-0000-4000-8000-000000000006', 'Produktivität & Wissensmanagement'),
 ('00000000-0000-4000-8000-000000000007', 'Haus & Wohnen'),
 ('00000000-0000-4000-8000-000000000008', 'Gesundheit & Fitness'),
 ('00000000-0000-4000-8000-000000000009', 'Hobbys & Allgemeinwissen')
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO score_definitions (id, name, description, prompt, include_tag_weights, include_source_weight) VALUES
 ('10000000-0000-4000-8000-000000000001', 'Hype', 'Übertreibung und werbliche Behauptungen', 'Bewerte 0–100, wie stark der Inhalt durch übertriebene, werbliche oder unbelegte Behauptungen statt durch substanzielle Informationen geprägt ist. 0 = kein Hype; 100 = nahezu reine Übertreibung. Ignoriere, ob Matthias das Thema persönlich mag.', false, false),
 ('10000000-0000-4000-8000-000000000002', 'Facts', 'Überprüfbarkeit anhand vorliegender Informationen; keine unabhängige Faktenprüfung', 'Bewerte 0–100, wie überprüfbar die Aussagen anhand der vorliegenden Informationen sind. Primärquellen, konkrete Daten, Versionen und belegte Details erhöhen den Wert; unbelegte Behauptungen senken ihn. Behaupte keine unabhängige Faktenprüfung.', false, false),
 ('10000000-0000-4000-8000-000000000003', 'Signal', 'Konkrete und zeitnahe Anwendbarkeit', 'Bewerte 0–100, wie konkret und zeitnah die Information praktisch anwendbar ist. Hintergrundinformation kann wertvoll sein, aber weniger unmittelbar handlungsfähig. Bewerte unabhängig von der persönlichen Beliebtheit der Quelle.', false, false),
 ('10000000-0000-4000-8000-000000000004', 'Persönliche Relevanz', 'Persönlicher Nutzen für Interessen und Aufgaben', 'Bewerte 0–100, wie wahrscheinlich dieser Inhalt Matthias bei seinen Interessen und Aufgaben nützt. Berücksichtige die gewählte Hauptkategorie und die mitgelieferten Präferenzgewichte für Quelle und Schlagwörter als Hinweise, nicht als Fakten über den Inhalt. Niedrige oder neutrale Gewichte allein bedeuten nicht, dass der Inhalt unwichtig ist.', true, true)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO model_roles (role, provider, model) VALUES
 ('quality', 'typesafe', 'jev-latest'), ('category', 'typesafe', 'jev-latest'),
 ('scores', 'typesafe', 'jev-latest'), ('tags', NULL, NULL), ('extraction_agent', NULL, NULL),
 ('context_reduction', NULL, NULL), ('summary', NULL, NULL), ('chat', NULL, NULL), ('transcription', NULL, NULL)
ON CONFLICT (role) DO NOTHING;
--> statement-breakpoint
-- The fallback cannot be removed, archived or assigned a category override.
CREATE FUNCTION protect_fallback_category() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.id = '00000000-0000-4000-8000-000000000001'::uuid AND
    (TG_OP = 'DELETE' OR NEW.id <> OLD.id OR NEW.archived_at IS NOT NULL) THEN
   RAISE EXCEPTION 'fallback category is protected';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER protect_fallback_category BEFORE UPDATE OR DELETE ON categories FOR EACH ROW EXECUTE FUNCTION protect_fallback_category();
--> statement-breakpoint
ALTER TABLE score_category_prompts ADD CONSTRAINT fallback_uses_global_prompt CHECK (category_id <> '00000000-0000-4000-8000-000000000001'::uuid);
--> statement-breakpoint
CREATE FUNCTION prevent_score_definition_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'score definitions must be soft deleted'; END $$;
--> statement-breakpoint
CREATE TRIGGER prevent_score_definition_delete BEFORE DELETE ON score_definitions FOR EACH ROW EXECUTE FUNCTION prevent_score_definition_delete();
--> statement-breakpoint
-- Normalize at the database boundary so all writers share the same identity.
CREATE FUNCTION normalize_tag() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.label := btrim(regexp_replace(normalize(NEW.label, NFKC), '[[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', ' ', 'g'));
 NEW.key := normalize(casefold(NEW.label COLLATE "und-x-icu"), NFKC);
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER normalize_tag BEFORE INSERT OR UPDATE OF label, key ON tags FOR EACH ROW EXECUTE FUNCTION normalize_tag();
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "category_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "article_contents" ADD CONSTRAINT "article_contents_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_scores" ADD CONSTRAINT "article_scores_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_scores" ADD CONSTRAINT "article_scores_score_id_score_definitions_id_fk" FOREIGN KEY ("score_id") REFERENCES "public"."score_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_tags" ADD CONSTRAINT "article_tags_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_tags" ADD CONSTRAINT "article_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_results" ADD CONSTRAINT "chunk_results_chunk_id_content_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."content_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD CONSTRAINT "content_chunks_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_category_prompts" ADD CONSTRAINT "score_category_prompts_score_id_score_definitions_id_fk" FOREIGN KEY ("score_id") REFERENCES "public"."score_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_category_prompts" ADD CONSTRAINT "score_category_prompts_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_role_model_roles_role_fk" FOREIGN KEY ("role") REFERENCES "public"."model_roles"("role") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_scores_sort_idx" ON "article_scores" USING btree ("score_id","value");--> statement-breakpoint
CREATE INDEX "article_tags_tag_idx" ON "article_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "usage_occurred_idx" ON "usage_ledger" USING btree ("bucket","occurred_at");--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "articles_category_idx" ON "articles" USING btree ("category_id");