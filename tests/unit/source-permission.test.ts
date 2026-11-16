import { describe, expect, it } from 'vitest';
import { normalizePermissionHost, resolveSourcePermission } from '../../src/server/domain/source-permission.js';

describe('source permission hosts', () => {
  it.each([
    ['YouTube.COM.', 'youtube.com'],
    ['BÜCHER.example', 'xn--bcher-kva.example'],
    ['WWW.YouTube.com', 'www.youtube.com'],
    ['example\u3002com', 'example.com'],
  ])('canonicalizes %s', (input, expected) => {
    expect(normalizePermissionHost(input)).toBe(expected);
  });

  it.each([
    '', 'localhost', 'host.local', 'foo.internal', 'foo.invalid', 'foo.test', 'foo.onion', 'foo.home.arpa',
    '*.example.com', 'https://example.com', 'example.com/path', 'example.com:443', 'user@example.com',
    'example.com?x', 'example.com#x', 'example.com\\path', ' example.com', 'example.com\n',
    'example..com', '.example.com', 'example.com..', '-bad.example', 'bad-.example', 'bad_.example',
    `${'a'.repeat(64)}.example`, '127.0.0.1', '8.8.8.8', '127.1', '0x7f000001', '2130706433', '[::1]', '::1',
    'example.%63om', 'xn--.example',
  ])('rejects %j', input => {
    expect(() => normalizePermissionHost(input)).toThrow();
  });
});

describe('source permission resolution', () => {
  const rules = new Map([['youtube.com', true], ['www.youtube.com', true], ['m.youtube.com', true], ['youtu.be', true], ['blocked.example', false]]);
  it('uses feed override before an exact host rule and defaults to false', () => {
    expect(resolveSourcePermission(true, 'blocked.example', rules)).toBe(true);
    expect(resolveSourcePermission(false, 'youtube.com', rules)).toBe(false);
    expect(resolveSourcePermission(null, 'YOUTUBE.COM.', rules)).toBe(true);
    expect(resolveSourcePermission(null, 'blocked.example', rules)).toBe(false);
    expect(resolveSourcePermission(null, 'other.example', rules)).toBe(false);
    expect(resolveSourcePermission(null, 'sub.youtube.com', rules)).toBe(false);
    expect(resolveSourcePermission(null, 'youtube.com.evil.example', rules)).toBe(false);
    expect(resolveSourcePermission(null, null, rules)).toBe(false);
  });
  it('fails closed for malformed host names without an override', () => {
    expect(resolveSourcePermission(null, 'https://youtube.com', rules)).toBe(false);
    expect(resolveSourcePermission(null, '127.1', rules)).toBe(false);
  });
});
