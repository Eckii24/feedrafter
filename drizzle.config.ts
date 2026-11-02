import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/adapters/postgres/schema/index.ts",
  out: "./drizzle",
});
