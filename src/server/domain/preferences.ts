export type VoteValue = -1 | 0 | 1;
export interface Vote { value: VoteValue; votedAt: Date }

export const DEFAULT_PREFERENCE_HALF_LIFE_DAYS = 90;

export function validateManualOffset(value: number): void {
  if (!Number.isFinite(value)) throw new RangeError('Invalid manual offset');
}

export function validateHalfLifeDays(value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('Invalid half-life');
}

export function weight(offset: number, votes: readonly Vote[], asOf: Date, halfLifeDays = DEFAULT_PREFERENCE_HALF_LIFE_DAYS): number {
  const time = asOf.getTime();
  validateManualOffset(offset);
  validateHalfLifeDays(halfLifeDays);
  if (!Number.isFinite(time)) throw new RangeError('Invalid weight parameters');
  return votes.reduce((sum, vote) => {
    const timestamp = vote.votedAt.getTime();
    if (!Number.isFinite(timestamp) || timestamp > time || ![-1, 0, 1].includes(vote.value)) throw new RangeError('Invalid vote');
    return sum + vote.value * 2 ** (-(time - timestamp) / 86_400_000 / halfLifeDays);
  }, offset);
}
