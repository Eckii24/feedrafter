import { MIMEType } from 'node:util';
import { Worker } from 'node:worker_threads';

/** Missing charset is allowed only when the bytes and declarations are valid UTF-8. */
export function validateHtmlContentType(value: string): void {
  let mime: MIMEType;
  try { mime = new MIMEType(value); } catch { throw new Error('not_html'); }
  if (!['text/html', 'application/xhtml+xml'].includes(mime.essence)) throw new Error('not_html');
  const mentions = value.match(/(?:^|;)\s*charset\s*(?:=|;|$)/gi) ?? [];
  const charset = mime.params.get('charset');
  if (mentions.length > 1 || (mentions.length && !charset) || (charset && !/^utf-?8$/i.test(charset.trim()))) throw new Error('unsupported_encoding');
}

const MAX_HTML = 10 * 1024 * 1024;
const MAX_TEXT = 1_000_000;
let active = false;
const waiting: Array<() => void> = [];

async function acquire(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) throw signal.reason;
  if (active) {
    if (waiting.length >= 16) throw new Error('Extraction queue full');
    await new Promise<void>((resolve, reject) => {
      const wake = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { const i = waiting.indexOf(wake); if (i >= 0) waiting.splice(i, 1); reject(signal.reason); };
      waiting.push(wake);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  } else active = true;
  const release = () => { const next = waiting.shift(); if (next) next(); else active = false; };
  if (signal.aborted) { release(); throw signal.reason; }
  return release;
}

/** One bounded worker process-wide; the deadline includes queue time. */
export async function extractHtml(html: Buffer, signal?: AbortSignal, options: { timeoutMs?: number; workerUrl?: URL; contentType?: string } = {}): Promise<{ text: string; pageText: string }> {
  if (!Buffer.isBuffer(html) || html.length > MAX_HTML) throw new Error('HTML exceeds limit');
  if (options.contentType !== undefined) validateHtmlContentType(options.contentType);
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(html); } catch { throw new Error('unsupported_encoding'); }
  if (decoded.includes('\0')) throw new Error('unsupported_encoding');
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10_000) throw new Error('Invalid extraction deadline');
  const deadline = AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const release = await acquire(combined);
  try {
    const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const worker = new Worker(options.workerUrl ?? new URL(`./readability-worker${extension}`, import.meta.url), {
      workerData: { html: decoded }, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
    });
    let abort: (() => void) | undefined;
    try {
      return await new Promise<{ text: string; pageText: string }>((resolve, reject) => {
        abort = () => reject(combined.reason);
        combined.addEventListener('abort', abort, { once: true });
        if (combined.aborted) abort();
        worker.once('message', (result: unknown) => {
          if (!result || typeof result !== 'object' || !('text' in result) || !('pageText' in result) ||
              typeof result.text !== 'string' || typeof result.pageText !== 'string' || result.text.length > MAX_TEXT || result.pageText.length > MAX_HTML) {
            reject(new Error('Invalid extraction output')); return;
          }
          resolve({ text: result.text, pageText: result.pageText });
        });
        worker.once('error', reject);
        worker.once('exit', code => reject(new Error(`Extraction worker exited: ${code}`)));
      });
    } finally { if (abort) combined.removeEventListener('abort', abort); await worker.terminate(); }
  } finally { release(); }
}
