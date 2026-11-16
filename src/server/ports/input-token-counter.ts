import type { AiOutcome, AiScope, GenerationRequest } from './ai.js';

/** A provider count, not consumed usage or a request-fit decision. */
export type InputTokenCount = { inputTokens: number };
export interface InputTokenCounter {
  count(request: GenerationRequest, scope: AiScope): Promise<AiOutcome<InputTokenCount>>;
}
