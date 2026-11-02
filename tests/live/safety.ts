import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

const forbidden = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) forbidden.addSubnet(network, prefix, 'ipv4');

export function publicAddresses(addresses: readonly { address: string; family: number }[]): boolean {
  // Fail closed on IPv6, mixed DNS results, and unclassified addresses.
  return addresses.length > 0 && addresses.every(({ address, family }) => family === 4 && isIP(address) === 4 && !forbidden.check(address, 'ipv4'));
}

export function liveConfig(env: NodeJS.ProcessEnv) {
  if (env.RUN_LIVE_FRESHRSS !== '1' || env.LIVE_FRESHRSS_DISPOSABLE !== 'I-confirm-this-is-a-disposable-installation' || env.LIVE_FRESHRSS_NON_PRODUCTION !== 'I-confirm-host-and-credentials-are-not-production') throw new Error('Live FreshRSS consent required');
  const { LIVE_FRESHRSS_URL: raw, LIVE_FRESHRSS_EMAIL: email, LIVE_FRESHRSS_PASSWORD: password, LIVE_FRESHRSS_PRODUCTION_HOST: productionHost, LIVE_FRESHRSS_PRODUCTION_EMAIL_SHA256: productionEmail, LIVE_FRESHRSS_PRODUCTION_PASSWORD_SHA256: productionPassword, LIVE_FRESHRSS_FIXTURE_IDS: fixtureIds } = env;
  if (!raw || !email || !password || !productionHost || !productionEmail || !productionPassword || !fixtureIds) throw new Error('Missing live safety configuration');
  // Never inspect an operational secret file; require a clean environment instead.
  if (env.FRESHRSS_API_PASSWORD_FILE) throw new Error('Operational secret file configured');
  if (![productionEmail, productionPassword].every(value => /^[a-f0-9]{64}$/.test(value)) || !/^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(productionHost)) throw new Error('Invalid production identity');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  if (hash(email) === productionEmail || hash(password) === productionPassword || email === env.FRESHRSS_EMAIL || password === env.FRESHRSS_API_PASSWORD) throw new Error('Production credentials rejected');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid live target'); }
  const host = url.hostname.toLowerCase();
  if (env.FRESHRSS_BASE_URL) {
    let configuredHost: string;
    try { configuredHost = new URL(env.FRESHRSS_BASE_URL).hostname.toLowerCase(); } catch { throw new Error('Invalid configured production target'); }
    if (host === configuredHost) throw new Error('Production target rejected');
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/$/, '').endsWith('/api/greader.php') || !/^[a-z0-9.-]+$/.test(host) || isIP(host) || !host.includes('.') || host.endsWith('.') || /(^|\.)(localhost|local|internal|test|example|invalid)$/.test(host) || host === productionHost.toLowerCase().replace(/\.$/, '')) throw new Error('Unsafe live target');
  const ids = fixtureIds.split(',');
  if (ids.some(id => !id || id.trim() !== id) || new Set(ids).size !== ids.length) throw new Error('Invalid fixture IDs');
  return { baseUrl: url.toString().replace(/\/$/, ''), email, password, ids, host };
}

/** Resolve each request and pin the selected public address; never follow redirects. */
export function pinnedTransport(host: string): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password) throw new Error('Unsafe live request');
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!publicAddresses(addresses)) throw new Error('Unsafe live DNS result');
    const address = addresses[0]!.address;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body instanceof URLSearchParams ? init.body.toString() : undefined;
    if (body !== undefined) headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8';
    return await new Promise<Response>((resolve, reject) => {
      const req = request(url, { method: init.method ?? 'GET', headers, signal: init.signal ?? undefined, lookup: (_hostname, _options, callback) => callback(null, address, 4) }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 10 * 1024 * 1024) res.destroy(new Error('Response too large')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => { if (!res.statusCode || res.statusCode >= 300 && res.statusCode < 400) return reject(new Error('Redirect rejected')); resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })); });
      });
      req.on('error', reject); req.end(body);
    });
  };
}
