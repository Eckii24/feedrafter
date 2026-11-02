import { MIMEType } from 'node:util';
import { parentPort, workerData } from 'node:worker_threads';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

// linkedom parses markup only: it does not run scripts or fetch resources.
const html = workerData.html as string;
if (/^\s*<\?xml\b/i.test(html) && !/^\s*<\?xml\b[\s\S]*?\?>/i.test(html)) throw new Error('unsupported_encoding');
for (const declaration of html.matchAll(/<\?xml\b[\s\S]*?\?>/gi)) {
  const encodings = [...declaration[0].matchAll(/\bencoding\s*=\s*(['"])(.*?)\1/gi)];
  const mentions = declaration[0].match(/\bencoding\b/gi) ?? [];
  if (mentions.length !== encodings.length || encodings.length > 1 || encodings.some(encoding => !/^utf-?8$/i.test(encoding[2]!))) throw new Error('unsupported_encoding');
}
const { document } = parseHTML(html);
for (const meta of document.querySelectorAll('meta')) {
  if (meta.hasAttribute('charset') && !/^utf-?8$/i.test(meta.getAttribute('charset')!.trim())) throw new Error('unsupported_encoding');
  if (meta.getAttribute('http-equiv')?.trim().toLowerCase() === 'content-type') {
    const content = meta.getAttribute('content') ?? '';
    let mime: MIMEType;
    try { mime = new MIMEType(content); } catch { throw new Error('unsupported_encoding'); }
    const mentions = content.match(/(?:^|;)\s*charset\s*(?:=|;|$)/gi) ?? [];
    const charset = mime.params.get('charset');
    if (mentions.length > 1 || (mentions.length && !charset) || (charset && !/^utf-?8$/i.test(charset.trim()))) throw new Error('unsupported_encoding');
  }
}
for (const node of document.querySelectorAll('script, style, noscript, template')) node.remove();
const pageText = document.body?.textContent ?? '';
const article = new Readability(document as unknown as Document, { maxElemsToParse: 100_000, disableJSONLD: true }).parse();
parentPort!.postMessage({ text: article?.textContent ?? '', pageText });
