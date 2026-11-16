import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { articles } from './import.js';

export const articleSummaries = pgTable('article_summaries', {
  articleId: uuid('article_id').primaryKey().references(() => articles.id, { onDelete: 'cascade' }),
  text: text().notNull(),
  contentRevision: integer('content_revision').notNull(),
  limitation: text(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }).notNull(),
}, t => [
  check('summary_text_valid', sql`length(trim(${t.text})) > 0 and octet_length(${t.text}) <= 16384`),
  check('summary_revision_positive', sql`${t.contentRevision} > 0`),
]);
