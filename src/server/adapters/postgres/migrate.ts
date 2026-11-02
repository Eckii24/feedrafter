import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

// Explicit administrative operation; application connections never migrate on startup.
export async function migrateDatabase(pool: pg.Pool, migrationsFolder = "./drizzle"): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1, $2)", [18420, 1]);
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    try { await client.query("select pg_advisory_unlock($1, $2)", [18420, 1]); }
    finally { client.release(); }
  }
}
