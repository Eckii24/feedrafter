import { and, eq } from "drizzle-orm";
import { validateBudgetSettings, type BudgetSettings, type UsageBucket } from "../../../shared/settings.js";
import type { Database } from "./client.js";
import { budgetSettings, requestCounters, usageLedger } from "./schema/enrichment.js";

export class UsageStore {
  constructor(private readonly db: Database) {}
  listBudgets() { return this.db.select().from(budgetSettings); }
  async saveBudget(settings: BudgetSettings) {
    validateBudgetSettings(settings);
    await this.db.insert(budgetSettings).values(settings).onConflictDoUpdate({ target: budgetSettings.bucket, set: settings });
  }
  async getEntry(id: string) {
    const [row] = await this.db.select().from(usageLedger).where(eq(usageLedger.id, id));
    return row ?? null;
  }
  async getCounter(dayUtc: string, bucket: UsageBucket) {
    const [row] = await this.db.select().from(requestCounters).where(and(eq(requestCounters.dayUtc, dayUtc), eq(requestCounters.bucket, bucket)));
    return row ?? null;
  }
}
