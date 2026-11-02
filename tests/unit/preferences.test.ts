import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCE_HALF_LIFE_DAYS, validateHalfLifeDays, validateManualOffset, weight } from '../../src/server/domain/preferences.js';

describe('preference weight', () => {
  const asOf = new Date('2026-07-01T00:00:00Z');
  const vote = (value: -1 | 0 | 1, ageDays: number) => ({ value, votedAt: new Date(asOf.getTime() - ageDays * 86_400_000) });
  it('adds undecayed offset and exponential votes without clamping', () => {
    expect(weight(2, [vote(1, 0), vote(1, 90), vote(1, 180), vote(-1, 45), vote(0, 0)], asOf)).toBeCloseTo(3.75 - Math.SQRT1_2);
    expect(weight(0, [vote(1, 1)], asOf, 1)).toBeCloseTo(0.5);
    expect(weight(0, [{ value: 1, votedAt: new Date('2026-06-30T14:00:00-05:00') }], asOf, 1)).toBeCloseTo(2 ** (-5 / 24));
    expect(weight(-7, [vote(-1, 0), vote(0, 90)], asOf)).toBe(-8);
  });
  it('validates settings boundaries without clamping finite values', () => {
    expect(DEFAULT_PREFERENCE_HALF_LIFE_DAYS).toBe(90);
    for (const value of [Number.MIN_VALUE, 90, Number.MAX_VALUE]) expect(() => validateHalfLifeDays(value)).not.toThrow();
    for (const value of [0, -0, -1, NaN, Infinity, -Infinity]) expect(() => validateHalfLifeDays(value)).toThrow();
    for (const value of [-Number.MAX_VALUE, 0, Number.MAX_VALUE]) expect(() => validateManualOffset(value)).not.toThrow();
    for (const value of [NaN, Infinity, -Infinity]) expect(() => validateManualOffset(value)).toThrow();
  });
  it('rejects invalid inputs and future timestamps, including neutral votes', () => {
    for (const halfLife of [0, -1, Infinity, NaN]) expect(() => weight(0, [], asOf, halfLife)).toThrow();
    expect(() => weight(Infinity, [], asOf)).toThrow();
    expect(() => weight(0, [vote(0, -1)], asOf)).toThrow();
    expect(() => weight(0, [vote(1, NaN)], asOf)).toThrow();
    expect(() => weight(0, [], new Date(NaN))).toThrow();
  });
});
