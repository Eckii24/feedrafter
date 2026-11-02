import type { AdmissionResult, ReservationIntent, TerminalUsage, UsageReservation } from '../domain/usage.js';

export interface UsageOwner { readonly token: string; readonly signal: AbortSignal }
export interface UsageAdmissionPort {
  withOwner<T>(signal: AbortSignal, action: (owner: UsageOwner) => Promise<T>): Promise<T>;
  reserve(owner: UsageOwner, intent: ReservationIntent): Promise<AdmissionResult>;
  settle(owner: UsageOwner, reservation: UsageReservation, terminal: TerminalUsage): Promise<'settled' | 'already_terminal' | 'ownership_lost'>;
  recover(): Promise<number>;
}
