export type KarakeepUncertain = { kind: 'uncertain' };
export type KarakeepAuthError = { kind: 'auth_error' };
export type KarakeepCreateResult =
  | { kind: 'created' | 'existing'; bookmark: { id: string; url: string } }
  | KarakeepUncertain | KarakeepAuthError;

// No response representation currently proves lookup presence or absence; auth failures are explicit.
export type KarakeepLookupResult = KarakeepUncertain | KarakeepAuthError;

export interface KarakeepPort {
  create(originalUrl: string, signal?: AbortSignal): Promise<KarakeepCreateResult>;
  checkUrl(originalUrl: string, signal?: AbortSignal): Promise<KarakeepLookupResult>;
}
