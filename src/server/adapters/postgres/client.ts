import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return { pool, db: drizzle({ client: pool, schema }), close: () => pool.end() };
}
export type Database = NodePgDatabase<typeof schema>;
