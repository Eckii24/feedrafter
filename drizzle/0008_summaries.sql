CREATE TABLE "article_summaries" (
	"article_id" uuid PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"content_revision" integer NOT NULL,
	"limitation" text,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "summary_text_valid" CHECK (length(trim("article_summaries"."text")) > 0 and octet_length("article_summaries"."text") <= 16384),
	CONSTRAINT "summary_revision_positive" CHECK ("article_summaries"."content_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "article_summaries" ADD CONSTRAINT "article_summaries_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;