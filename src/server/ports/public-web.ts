import type { IncomingHttpHeaders } from 'node:http';

/** Public-web retrieval is deliberately separate from authenticated integration clients. */
export interface PublicWebResponse {
  finalUrl: string;
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
export interface PublicWebOptions {
  /** Stricter per-call limits; defaults remain 10 MiB, 30 seconds and five redirects. */
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Reject to deny a target before DNS or transport, including every redirect. */
  authorizeTarget?: (url: string, signal: AbortSignal) => Promise<void>;
}
export interface PublicWeb {
  get(url: string, signal?: AbortSignal, options?: PublicWebOptions): Promise<PublicWebResponse>;
}
