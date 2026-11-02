export interface Article {
  id: string; sourceId: string | null; title: string | null; url: string | null;
  author: string | null; publishedAt: string | null; importedAt: string;
  kind: 'article' | 'video'; isRead: boolean; mailState: 'not_selected' | 'selected' | 'sent'; scoreValue: number | null;
}
export interface Page { items: Article[]; nextCursor: string | null }
export interface Run { id: string; status: string; phase: string; fetchedCount: number; confirmedCount: number; pendingCount: number; errorCode: string | null }
export class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new HttpError(body?.error?.message || `Request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}
export function safeLink(value: string | null): string | null {
  if (!value) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
