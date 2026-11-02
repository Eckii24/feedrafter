CREATE TABLE "source_votes" (
	"article_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"value" integer NOT NULL,
	"voted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "source_votes_article_id_source_id_pk" PRIMARY KEY("article_id","source_id"),
	CONSTRAINT "source_vote_value" CHECK ("source_votes"."value" in (-1, 0, 1))
);
--> statement-breakpoint
CREATE TABLE "tag_votes" (
	"article_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"value" integer NOT NULL,
	"voted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tag_votes_article_id_tag_id_pk" PRIMARY KEY("article_id","tag_id"),
	CONSTRAINT "tag_vote_value" CHECK ("tag_votes"."value" in (-1, 0, 1))
);
--> statement-breakpoint
ALTER TABLE "source_votes" ADD CONSTRAINT "source_votes_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_votes" ADD CONSTRAINT "source_votes_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_votes" ADD CONSTRAINT "tag_votes_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_votes" ADD CONSTRAINT "tag_votes_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE no action ON UPDATE no action;