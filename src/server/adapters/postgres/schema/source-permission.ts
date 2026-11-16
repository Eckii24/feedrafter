import { boolean, pgTable, text } from 'drizzle-orm/pg-core';

export const sourcePermissionHostRules = pgTable('source_permission_host_rules', {
  host: text().primaryKey(),
  allowed: boolean().notNull(),
});
