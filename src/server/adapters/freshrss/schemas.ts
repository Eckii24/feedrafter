const READ_CATEGORY = 'user/-/state/com.google/read';
const MAX_IDS = 100;

export function isValidContinuation(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function validateIds(ids: readonly string[]): void {
  if (ids.length === 0 || ids.length > MAX_IDS || ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 4096) || new Set(ids).size !== ids.length) {
    throw new Error('Invalid FreshRSS IDs');
  }
}

export function idForm(ids: readonly string[]): URLSearchParams {
  validateIds(ids);
  const form = new URLSearchParams();
  for (const id of ids) form.append('i', id);
  return form;
}

/** Missing, duplicate, or unrequested items are ambiguous, never inferred unread. */
export function parseReadStates(text: string, ids: readonly string[]): ReadonlyMap<string, boolean> {
  validateIds(ids);
  let data: unknown;
  try { data = JSON.parse(text) as unknown; } catch { throw new Error('Invalid FreshRSS response'); }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('Invalid FreshRSS response');
  const items: unknown = (data as Record<string, unknown>).items;
  if (!Array.isArray(items)) throw new Error('Invalid FreshRSS response');
  const expected = new Set(ids);
  const result = new Map<string, boolean>();
  for (const value of items) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid FreshRSS response');
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || !expected.has(item.id) || result.has(item.id) ||
        !Array.isArray(item.categories) || !item.categories.every((category: unknown) => typeof category === 'string')) {
      throw new Error('Invalid FreshRSS response');
    }
    result.set(item.id, item.categories.includes(READ_CATEGORY));
  }
  if (result.size !== expected.size) throw new Error('Invalid FreshRSS response');
  return result;
}

export const readCategory = READ_CATEGORY;
