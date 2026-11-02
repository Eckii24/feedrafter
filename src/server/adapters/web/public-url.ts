import { isIP } from 'node:net';

/** Parse every target independently. URL normalisation exposes alternate IP literal forms. */
export function publicUrl(input: string, base?: URL): URL {
  // URL discards empty userinfo, so inspect the supplied authority before parsing too.
  const normalized = input.replace(/[\t\n\r]/g, '').trim();
  const absolute = /^(https?:)([\\/]*)([^\\/?#]*)/i.exec(normalized);
  const relativeAuthority = /^[\\/]{2,}([^\\/?#]*)/.exec(normalized)?.[1];
  const authority = absolute && (!base || absolute[1]!.toLowerCase() !== base.protocol || absolute[2]!.length >= 2) ? absolute[3] : relativeAuthority;
  if (authority?.includes('@')) throw new Error('URL credentials rejected');
  const url = new URL(input, base);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== '80' && url.port !== '443') || isIP(host.replace(/^\[|\]$/g, '')) ||
      host.length > 253 || !host.includes('.') ||
      !host.split('.').every(label => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label)) ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test|onion)$/.test(host) || host.endsWith('.home.arpa')) {
    throw new Error('Unsafe public URL');
  }
  url.hash = '';
  return url;
}
