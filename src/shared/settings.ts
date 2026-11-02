export const modelRoleNames = ["quality", "category", "tags", "scores", "extraction_agent", "context_reduction", "summary", "chat", "transcription"] as const;
export const usageBuckets = ["automatic", "interactive", "classifier", "transcription"] as const;
export type UsageBucket = typeof usageBuckets[number];
export type BudgetSettings = { bucket: UsageBucket; dailyRequests: number | null; concurrency: number | null; dailyAudioSeconds: number | null };

export function validateBudgetSettings(settings: BudgetSettings): BudgetSettings {
  if (!settings || !(usageBuckets as readonly string[]).includes(settings.bucket)) throw new RangeError("unknown budget bucket");
  for (const value of [settings.dailyRequests, settings.concurrency]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 2147483647)) throw new RangeError("invalid budget limit");
  }
  if (settings.dailyAudioSeconds !== null && (typeof settings.dailyAudioSeconds !== "number" || !Number.isFinite(settings.dailyAudioSeconds) || settings.dailyAudioSeconds < 0)) throw new RangeError("invalid audio limit");
  return settings;
}

export type ModelRole = typeof modelRoleNames[number];
export type ModelReference = { provider: string; model: string };
export type ModelRoleSettings = { role: ModelRole; primary: ModelReference | null; fallback: ModelReference | null };

export function validateModelRoleSettings(settings: ModelRoleSettings): ModelRoleSettings {
  if (!settings || !(modelRoleNames as readonly string[]).includes(settings.role)) throw new RangeError("unknown model role");
  for (const reference of [settings.primary, settings.fallback]) {
    if (reference !== null && (!reference || typeof reference.provider !== "string" || typeof reference.model !== "string" || !reference.provider.trim() || !reference.model.trim())) throw new RangeError("provider and model are required");
  }
  if (settings.fallback && !settings.primary) throw new RangeError("fallback requires a primary model");
  return settings;
}
