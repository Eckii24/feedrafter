import type { ModelReference, ModelRole } from '../../shared/settings.js';
import type { ModelUsageBucket } from '../domain/usage.js';

export type AiScope = { bucket: ModelUsageBucket; taskId?: string; turnId?: string; signal: AbortSignal };

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type ClassificationQuestion =
  | { type: 'bool'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };
export type ClassificationAnswer =
  | { type: 'bool'; probability: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; confidence: number; criteria: string[] };
export type AiUsage = { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
export type ClassificationRequest = { model: ModelReference; role: ModelRole; state: JsonObject; questions: Record<string, ClassificationQuestion> };
export type GenerationRequest = { model: ModelReference; role: ModelRole; system: string; user: string };
export type SessionOptions = { model: ModelReference; role: ModelRole; system: string };
export type ClassificationResult = { answers: Record<string, ClassificationAnswer>; usage: AiUsage | null };
export type GenerationResult = { text: string; usage: AiUsage | null };
export type AiOutcome<T> = { kind: 'completed'; value: T } | { kind: 'paused_budget'; reason: 'daily_limit' | 'concurrency_limit' } | { kind: 'paused_auth' } | { kind: 'paused_configuration' };
export interface RestrictedSession {
  prompt(text: string, scope: AiScope): Promise<AiOutcome<GenerationResult>>;
  abort(): void;
  compact(scope: AiScope): Promise<AiOutcome<void>>;
  dispose(): Promise<void>;
}
export interface AiPort {
  classify(request: ClassificationRequest, scope: AiScope): Promise<AiOutcome<ClassificationResult>>;
  generate(request: GenerationRequest, scope: AiScope): Promise<AiOutcome<GenerationResult>>;
  createRestrictedSession(options: SessionOptions, scope: AiScope): Promise<AiOutcome<RestrictedSession>>;
}
