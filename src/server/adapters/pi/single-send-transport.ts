import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import type { AttemptDispatchPermit } from '../../application/usage.js';

/** One exact POST route and one dispatch, including the entire streamed response lifetime. */
export function createSingleSendFetch(options: {
  url: string;
  permit: AttemptDispatchPermit;
  signal: AbortSignal;
  timeoutMs: number;
  maxResponseBytes: number;
}): typeof fetch & { readonly bodyCompleted: boolean } {
  const route = new URL(options.url);
  if (!['http:', 'https:'].includes(route.protocol) || route.username || route.password || route.hash
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2147483647
    || !Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1) throw new RangeError('Invalid single-send configuration');
  const expected = route.href;
  const { permit, signal: attemptSignal, timeoutMs, maxResponseBytes } = options;
  let used = false;
  let bodyCompleted = false;
  const send: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== expected || request.method !== 'POST') throw new Error('Request outside single-send route');
    // Prevent caller-controlled framing, protocol upgrade and hop-by-hop routing.
    for (const name of ['connection', 'transfer-encoding', 'content-length', 'upgrade', 'expect', 'trailer', 'proxy-authorization', 'proxy-connection']) {
      if (request.headers.has(name)) throw new Error('Unsupported request header');
    }
    if (used) throw new Error('Single-send transport already used');
    const signal = AbortSignal.any([attemptSignal, request.signal, AbortSignal.timeout(timeoutMs)]);
    signal.throwIfAborted();
    const headers = Object.fromEntries(request.headers.entries());
    headers.host = route.host;
    headers['accept-encoding'] = 'identity';
    used = true;
    // node:http initiates connection during request(); no asynchronous gap after consumption.
    permit.consume();
    return new Promise<Response>((resolve, reject) => {
      let response: IncomingMessage | undefined;
      const outgoing = (route.protocol === 'https:' ? httpsRequest : httpRequest)(route, {
        method: 'POST', headers, agent: false, signal,
      }, (incoming) => {
        response = incoming;
        const status = incoming.statusCode;
        if (!status || status < 200 || status > 599 || (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity')) {
          incoming.destroy(); reject(new Error('Unsupported provider response')); return;
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.append(name, value);
        }
        if ([204, 205, 304].includes(status)) {
          incoming.resume();
          resolve(new Response(null, { status, headers: responseHeaders }));
          return;
        }
        let size = 0;
        let cancelled = false;
        const iterator = incoming[Symbol.asyncIterator]();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await iterator.next();
              if (next.done) { bodyCompleted = incoming.complete && !cancelled && !signal.aborted; controller.close(); return; }
              const chunk = next.value as Buffer;
              size += chunk.byteLength;
              if (size > maxResponseBytes) throw new Error('Response body exceeds limit');
              controller.enqueue(new Uint8Array(chunk));
            } catch (error) { incoming.destroy(); controller.error(error); }
          },
          cancel() { cancelled = true; incoming.destroy(); },
        });
        resolve(new Response(body, { status, headers: responseHeaders }));
      });
      outgoing.on('error', (error) => { response?.destroy(error); reject(error); });
      if (request.body) {
        const body = Readable.fromWeb(request.body as import('node:stream/web').ReadableStream);
        body.on('error', (error) => outgoing.destroy(error));
        outgoing.on('close', () => body.destroy());
        body.pipe(outgoing);
      } else outgoing.end();
    });
  };
  return Object.defineProperty(send, 'bodyCompleted', { get: () => bodyCompleted }) as typeof fetch & { readonly bodyCompleted: boolean };
}
