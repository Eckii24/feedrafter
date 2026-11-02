import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { articles, sources } from './import.js';
import { tags } from './enrichment.js';

export const tagVotes = pgTable('tag_votes', {
  articleId: uuid('article_id').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  tagId: uuid('tag_id').notNull().references(() => tags.id),
  value: integer().notNull(),
  votedAt: timestamp('voted_at', { withTimezone: true }).notNull(),
}, t => [primaryKey({ columns: [t.articleId, t.tagId] }), check('tag_vote_value', sql`${t.value} in (-1, 0, 1)`)]);
export const sourceVotes = pgTable('source_votes', {
  articleId: uuid('article_id').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id').notNull().references(() => sources.id),
  value: integer().notNull(),
  votedAt: timestamp('voted_at', { withTimezone: true }).notNull(),
}, t => [primaryKey({ columns: [t.articleId, t.sourceId] }), check('source_vote_value', sql`${t.value} in (-1, 0, 1)`)]);
