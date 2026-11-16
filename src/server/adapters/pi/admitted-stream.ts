import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

type Terminal = Extract<AssistantMessageEvent, { type: 'done' | 'error' }>;
type Nonterminal = Exclude<AssistantMessageEvent, Terminal>;
type Identity = Pick<AssistantMessage, 'api' | 'provider' | 'model'>;
type Attempt = (signal: AbortSignal, emit: (event: Nonterminal) => void) => Promise<Terminal>;
const isTerminal = (event: AssistantMessageEvent): event is Terminal => event.type === 'done' || event.type === 'error';

/**
 * One invocation, one iterator and a shared Pi result. The attempt must not resolve
 * until validation, accounting and cleanup have settled. It returns the terminal
 * event rather than emitting it; Pi resolves result() as soon as a terminal is pushed.
 * Cancellation is cooperative: iterator close waits for the attempt to settle.
 */
export class AdmittedStream extends AssistantMessageEventStream {
  readonly #controller = new AbortController();
  readonly #attempt: Promise<void>;
  #terminal = false;
  #iteratorTaken = false;

  constructor(identity: Identity, attempt: Attempt) {
    super();
    const failure = (aborted: boolean): Terminal => {
      const reason = aborted ? 'aborted' : 'error';
      return { type: 'error', reason, error: {
        role: 'assistant', content: [], api: identity.api, provider: identity.provider, model: identity.model, stopReason: reason,
        errorMessage: aborted ? 'Invocation aborted' : 'Invocation failed', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } };
    };
    this.#attempt = Promise.resolve().then(() => attempt(this.#controller.signal, (event) => {
      if (this.#terminal || this.#controller.signal.aborted) return;
      if (isTerminal(event)) throw new Error('Terminal must be returned after settlement');
      super.push(event);
    })).then((terminal) => {
      if (!terminal || (terminal.type !== 'done' && terminal.type !== 'error')) throw new Error('Missing terminal');
      return this.#controller.signal.aborted ? failure(true) : terminal;
    }).catch(() => failure(this.#controller.signal.aborted)).then((terminal) => {
      this.#terminal = true;
      super.push(terminal);
      // Pi push(terminal) only wakes one pending next(); end wakes the rest.
      super.end();
    });
  }

  // Only the attempt may publish events or finish this stream.
  override push(): void { throw new Error('Admitted stream is read-only'); }
  override end(): void { throw new Error('Admitted stream is read-only'); }

  override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    if (this.#iteratorTaken) throw new Error('Admitted stream supports one iterator');
    this.#iteratorTaken = true;
    const iterator = super[Symbol.asyncIterator]();
    let closed = false;
    const close = async () => {
      if (!closed) {
        closed = true;
        if (!this.#terminal) this.#controller.abort();
      }
      await this.#attempt;
      await iterator.return?.();
    };
    return {
      next: async () => {
        if (closed) return { done: true, value: undefined };
        const result = await iterator.next();
        return closed ? { done: true, value: undefined } : result;
      },
      return: async () => { await close(); return { done: true, value: undefined }; },
      throw: async (error?: unknown) => { await close(); throw error; },
    };
  }
}
