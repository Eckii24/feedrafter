import type { ModelReference, ModelRole } from '../../shared/settings.js';

export type ModelUsageBucket = 'automatic' | 'interactive' | 'classifier';
export type ReservationIntent = ModelReference & { bucket: ModelUsageBucket; role: ModelRole; taskId?: string; turnId?: string };
export type UsageReservation = { id: string; ownerToken: string; bucket: ModelUsageBucket; dayUtc: string };
export type AdmissionResult = { admitted: true; reservation: UsageReservation } | { admitted: false; reason: 'daily_limit' | 'concurrency_limit' };
export type TerminalUsage = {
  status: 'succeeded' | 'failed' | 'uncertain';
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  tokensSource: 'provider' | 'unknown';
  costSource: 'provider' | 'unknown';
  outcomeCode: string | null;
};
