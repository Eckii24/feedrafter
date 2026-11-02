export const fallbackCategoryId = "00000000-0000-4000-8000-000000000001";
export type Category = { id: string; label: string; archivedAt: Date | null };
export type Tag = { id: string; label: string; key: string; archivedAt: Date | null };

// PostgreSQL's Unicode casefold is authoritative for identity. Do not replace
// it with JavaScript's lowercasing, which does not fold e.g. ß to ss.
export function normalizeTagLabel(label: string): string {
  if (typeof label !== "string") throw new RangeError("tag label is required");
  const normalized = label.normalize("NFKC").replace(/(?:(?!\uFEFF)[\s\u0085])+/gu, " ").replace(/^ | $/gu, "");
  if (!normalized) throw new RangeError("tag label is required");
  return normalized;
}
