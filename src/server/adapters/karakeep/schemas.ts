import type { KarakeepCreateResult, KarakeepLookupResult } from '../../ports/karakeep.js';

const uncertain = { kind: 'uncertain' } as const;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function validOriginalUrl(value: string): boolean {
  if (typeof value !== 'string' || value !== value.trim() || value.includes('\\') ||
      Array.from(value).some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

/**
 * Provisional minimal representation, not a deployed API contract.
 * Require exact URL equality until normalization semantics are verified.
 */
export function parseCreate(status: number, value: unknown, originalUrl: string): KarakeepCreateResult {
  if (status !== 200 && status !== 201) return uncertain;
  const bookmark = object(value);
  const content = object(bookmark?.content);
  if (typeof bookmark?.id !== 'string' || !bookmark.id.trim() ||
      bookmark.id !== bookmark.id.trim() || bookmark.id.length > 4096 ||
      content?.type !== 'link' || content.url !== originalUrl) return uncertain;
  return { kind: status === 201 ? 'created' : 'existing', bookmark: { id: bookmark.id, url: originalUrl } };
}

/** The plan does not specify a reliable check-url wire shape or absent semantics. */
export function parseLookup(): KarakeepLookupResult {
  return uncertain;
}
