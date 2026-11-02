import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { liveConfig, publicAddresses } from '../live/safety.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const fixture = () => ({ RUN_LIVE_FRESHRSS: '1', LIVE_FRESHRSS_DISPOSABLE: 'I-confirm-this-is-a-disposable-installation', LIVE_FRESHRSS_NON_PRODUCTION: 'I-confirm-host-and-credentials-are-not-production', LIVE_FRESHRSS_URL: 'https://disposable.example.net/api/greader.php', LIVE_FRESHRSS_EMAIL: 'fixture-user', LIVE_FRESHRSS_PASSWORD: 'fixture-password', LIVE_FRESHRSS_PRODUCTION_HOST: 'production.example.net', LIVE_FRESHRSS_PRODUCTION_EMAIL_SHA256: hash('production-user'), LIVE_FRESHRSS_PRODUCTION_PASSWORD_SHA256: hash('production-password'), LIVE_FRESHRSS_FIXTURE_IDS: 'fixture-a,fixture-b' });

describe('live FreshRSS safety (no network)', () => {
  it('requires both opt-ins and production identity', () => {
    const base = fixture();
    for (const key of ['RUN_LIVE_FRESHRSS', 'LIVE_FRESHRSS_DISPOSABLE', 'LIVE_FRESHRSS_NON_PRODUCTION', 'LIVE_FRESHRSS_PRODUCTION_HOST', 'LIVE_FRESHRSS_PRODUCTION_EMAIL_SHA256', 'LIVE_FRESHRSS_PRODUCTION_PASSWORD_SHA256'] as const) expect(() => liveConfig({ ...base, [key]: '' })).toThrow();
    expect(liveConfig(base).ids).toEqual(['fixture-a', 'fixture-b']);
  });
  it.each(['http://disposable.example.net/api/greader.php', 'https://localhost/api/greader.php', 'https://127.0.0.1/api/greader.php', 'https://192.168.1.1/api/greader.php', 'https://[::ffff:127.0.0.1]/api/greader.php', 'https://production.example.net/api/greader.php', 'https://a:b@disposable.example.net/api/greader.php', 'https://disposable.example.net:444/api/greader.php', 'https://disposable.example.net/api/greader.php?x=y'])('rejects target %s', url => {
    expect(() => liveConfig({ ...fixture(), LIVE_FRESHRSS_URL: url })).toThrow();
  });
  it('rejects production credentials and configured production target', () => {
    expect(() => liveConfig({ ...fixture(), LIVE_FRESHRSS_EMAIL: 'production-user' })).toThrow();
    expect(() => liveConfig({ ...fixture(), LIVE_FRESHRSS_PASSWORD: 'production-password' })).toThrow();
    expect(() => liveConfig({ ...fixture(), FRESHRSS_BASE_URL: 'https://disposable.example.net/api/greader.php' })).toThrow();
    expect(() => liveConfig({ ...fixture(), FRESHRSS_EMAIL: 'fixture-user' })).toThrow();
    expect(() => liveConfig({ ...fixture(), FRESHRSS_API_PASSWORD_FILE: '/fixture/secret' })).toThrow();
  });
  it('rejects private, IPv6, empty and mixed DNS results', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '169.254.1.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', '198.18.0.1', '224.0.0.1']) expect(publicAddresses([{ address, family: 4 }])).toBe(false);
    expect(publicAddresses([])).toBe(false);
    expect(publicAddresses([{ address: '::1', family: 6 }])).toBe(false);
    expect(publicAddresses([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }])).toBe(false);
    expect(publicAddresses([{ address: '8.8.8.8', family: 4 }])).toBe(true);
  });
});
