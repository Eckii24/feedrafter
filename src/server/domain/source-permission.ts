import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

/** Canonical exact DNS hostname, not a URL or an IP address. */
export function normalizePermissionHost(input: string): string {
  if (typeof input !== 'string' || !input || input.length > 1024 || /[\s/:@?#\\%*]/u.test(input) || input.includes('[') || input.includes(']') || [...input].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('Invalid permission host');
  // WHATWG IDNA also expands alternate IPv4 spellings, which are then rejected.
  const host = domainToASCII(input).toLowerCase().replace(/\.$/, '');
  if (!host || isIP(host) || host.length > 253 || !host.includes('.') ||
      !host.split('.').every(label => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label)) ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test|onion)$/.test(host) || host.endsWith('.home.arpa')) {
    throw new Error('Invalid permission host');
  }
  return host;
}

/** Rules must use canonical keys. Permission does not replace the public-fetch safety boundary. */
export function resolveSourcePermission(override: boolean | null, host: string | null, rules: ReadonlyMap<string, boolean>): boolean {
  if (override !== null) return override;
  if (host === null) return false;
  try { return rules.get(normalizePermissionHost(host)) ?? false; }
  catch { return false; }
}
