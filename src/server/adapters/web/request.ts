import { Resolver } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { PublicWeb } from '../../ports/public-web.js';
import { isPublicAddress } from './public-address.js';
import { publicUrl } from './public-url.js';

const LIMIT = 10 * 1024 * 1024;
const DEADLINE = 30_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export type ResolverSeam = (hostname: string, signal: AbortSignal) => Promise<string[]>;
export type TransportSeam = (url: URL, address: string, signal: AbortSignal) => Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  body: Readable;
}>;

async function resolveAll(hostname: string, signal: AbortSignal): Promise<string[]> {
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const answers = await Promise.all([resolver.resolve4(hostname), resolver.resolve6(hostname)].map(async promise => {
      try { return await promise; } catch (error) {
        if (['ENODATA', 'ENOTFOUND'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
        throw error;
      }
    }));
    return answers.flat();
  } finally { signal.removeEventListener('abort', cancel); }
}

/** Single-use socket: lookup cannot resolve again, and Host/SNI remain the URL hostname. */
export const pinnedTransport: TransportSeam = (url, address, signal) => new Promise((resolve, reject) => {
  const family = isIP(address);
  if (!family) { reject(new Error('Invalid pinned address')); return; }
  const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: 'GET', agent: false, signal, family,
    headers: { 'accept-encoding': 'gzip, deflate, br' },
    lookup: (_hostname, _options, callback) => callback(null, address, family),
  }, (res: IncomingMessage) => {
    if (!res.statusCode) { res.destroy(); reject(new Error('Missing HTTP status')); return; }
    resolve({ status: res.statusCode, headers: res.headers, body: res });
  });
  req.on('error', reject);
  req.end();
});

// The same queue limits all instances and includes DNS, redirects and body processing.
let active = 0;
const waiting: Array<() => void> = [];
async function acquire(signal: AbortSignal): Promise<() => void> {
  if (active >= 2) await new Promise<void>((resolve, reject) => {
    const wake = () => { signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { const index = waiting.indexOf(wake); if (index >= 0) waiting.splice(index, 1); reject(signal.reason); };
    waiting.push(wake);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  else active++;
  if (signal.aborted) { release(); throw signal.reason; }
  return release;
}
function release() {
  const next = waiting.shift();
  if (next) next(); else active--;
}

function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function counter(): Transform {
  let size = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length;
    callback(size > LIMIT ? new Error('Response body exceeds limit') : null, chunk);
  } });
}
async function readBody(body: Readable, encoding: string | undefined, signal: AbortSignal): Promise<Buffer> {
  let decoder: Transform;
  switch ((encoding ?? 'identity').trim().toLowerCase()) {
    case 'identity': decoder = new Transform({ transform(chunk, _encoding, callback) { callback(null, chunk); } }); break;
    case 'gzip': decoder = createGunzip(); break;
    case 'deflate': decoder = createInflate(); break;
    case 'br': decoder = createBrotliDecompress(); break;
    default: body.destroy(); throw new Error('Unsupported content encoding');
  }
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(chunk); callback(); } });
  await pipeline(body, counter(), decoder, counter(), sink, { signal });
  return Buffer.concat(chunks);
}

export function createPublicWeb(options: { resolver?: ResolverSeam; transport?: TransportSeam } = {}): PublicWeb {
  const resolver = options.resolver ?? resolveAll;
  const transport = options.transport ?? pinnedTransport;
  return {
    async get(input: string, callerSignal?: AbortSignal) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Public web deadline exceeded')), DEADLINE);
      const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
      let unlock: (() => void) | undefined;
      try {
        let url = publicUrl(input);
        unlock = await acquire(signal);
        for (let redirects = 0; ; redirects++) {
          const addresses = await bounded(resolver(url.hostname.replace(/\.$/, ''), signal), signal);
          if (!addresses.length || !addresses.every(isPublicAddress)) throw new Error('Unsafe DNS result');
          const request = transport(url, addresses[0]!, signal);
          // A misbehaving injected transport may complete after the deadline.
          void request.then(response => { if (signal.aborted) response.body.destroy(); }, () => {});
          const response = await bounded(request, signal);
          if (REDIRECTS.has(response.status)) {
            response.body.destroy();
            const location = response.headers.location;
            if (!location || redirects >= 5) throw new Error('Invalid or excessive redirects');
            const next = publicUrl(location, url);
            if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('HTTPS downgrade rejected');
            url = next;
            continue;
          }
          const body = await readBody(response.body, response.headers['content-encoding'], signal);
          return { finalUrl: url.href, status: response.status, headers: response.headers, body };
        }
      } finally { clearTimeout(timer); controller.abort(); unlock?.(); }
    },
  };
}
