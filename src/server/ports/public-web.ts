import type { IncomingHttpHeaders } from 'node:http';

/** Public-web retrieval is deliberately separate from authenticated integration clients. */
export interface PublicWebResponse {
  finalUrl: string;
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
export interface PublicWeb {
  get(url: string, signal?: AbortSignal): Promise<PublicWebResponse>;
}
