import { describe, expect, it } from 'vitest';
import { isPostgresJsonText } from '../../src/server/domain/postgres-json-text.js';

describe('PostgreSQL JSON text', () => {
  it.each(['', 'plain', 'é😀𐀿', '\ud800\udc00\udbff\udfff'])('accepts well-formed text %s', value => {
    expect(isPostgresJsonText(value)).toBe(true);
  });
  it.each(['\0', '\ud800', '\udfff', '\ud800x', 'x\udfff', '\ud800\ud800\udc00', '\ud800\udc00\udfff'])('rejects unsupported text %s', value => {
    expect(isPostgresJsonText(value)).toBe(false);
  });
});
