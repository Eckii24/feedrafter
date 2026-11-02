ALTER TABLE "articles" ADD COLUMN "mail_state" text DEFAULT 'not_selected' NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "mail_selected_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "articles_mail_queue_idx" ON "articles" USING btree ("mail_selected_at","id") WHERE "articles"."mail_state" = 'selected';--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "article_mail_state" CHECK ("articles"."mail_state" in ('not_selected', 'selected', 'sent') and (("articles"."mail_state" = 'not_selected') = ("articles"."mail_selected_at" is null)));