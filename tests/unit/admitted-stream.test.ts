import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { describe, expect, it, vi } from 'vitest';
import { AdmittedStream } from '../../src/server/adapters/pi/admitted-stream.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const identity = { api: 'fixture', provider: 'fixture', model: 'fixture' };
function message(): AssistantMessage {
  return { role: 'assistant', ...identity, content: [{ type: 'text', text: 'answer' }], stopReason: 'stop', timestamp: 0,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const done = (value: AssistantMessage): Extract<AssistantMessageEvent, { type: 'done' }> => ({ type: 'done', reason: 'stop', message: value });

describe('admitted stream', () => {
  it('pumps in order and withholds terminal and result until settlement', async () => {
    const settling = deferred<void>(); const pumped = deferred<void>(); const value = message();
    const stream = new AdmittedStream(identity, async (_signal, emit) => {
      emit({ type: 'start', partial: value });
      emit({ type: 'text_delta', contentIndex: 0, delta: 'answer', partial: value });
      pumped.resolve(); await settling.promise; return done(value);
    });
    expect(stream).toBeInstanceOf(AssistantMessageEventStream);
    await pumped.promise; // Producer ran before iteration or result consumption.
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('start');
    expect((await iterator.next()).value?.type).toBe('text_delta');
    const next = iterator.next(); const result = stream.result();
    const observed = vi.fn(); void next.then(observed); void result.then(observed);
    await Promise.resolve(); await Promise.resolve(); expect(observed).not.toHaveBeenCalled();
    settling.resolve();
    const terminal = await next;
    expect(terminal.value).toEqual(done(value));
    expect(await result).toBe(value);
    expect((await iterator.next()).done).toBe(true);
  });

  it('settles result without an iterator and shares the terminal with later iteration', async () => {
    const barrier = deferred<void>(); const value = message();
    const stream = new AdmittedStream(identity, async (_signal, emit) => {
      emit({ type: 'start', partial: value }); await barrier.promise; return done(value);
    });
    const result = stream.result(); const observed = vi.fn(); void result.then(observed);
    await Promise.resolve(); expect(observed).not.toHaveBeenCalled();
    barrier.resolve(); expect(await result).toBe(value);
    const events = []; for await (const event of stream) events.push(event);
    expect(events.map((event) => event.type)).toEqual(['start', 'done']);
    expect(events[1]).toEqual(done(value));
  });

  it.each(['return', 'throw'] as const)('%s before terminal aborts and waits for cleanup', async (method) => {
    const started = deferred<void>(); const aborted = deferred<void>(); const cleanup = deferred<void>();
    let signal!: AbortSignal;
    const stream = new AdmittedStream(identity, async (s, emit) => {
      signal = s; emit({ type: 'start', partial: message() }); started.resolve();
      await new Promise<void>((resolve) => s.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
      await cleanup.promise; throw new Error('private provider failure');
    });
    const iterator = stream[Symbol.asyncIterator](); await started.promise; await iterator.next();
    const thrown = new Error('consumer');
    const closing = method === 'return' ? iterator.return!() : iterator.throw!(thrown);
    const outcome = closing.then(() => 'returned', (error: unknown) => error);
    await aborted.promise; expect(signal.aborted).toBe(true);
    const observed = vi.fn(); void outcome.then(observed); await Promise.resolve(); expect(observed).not.toHaveBeenCalled();
    cleanup.resolve(); expect(await outcome).toBe(method === 'return' ? 'returned' : thrown);
    const result = await stream.result();
    expect(result.stopReason).toBe('aborted'); expect(result.errorMessage).toBe('Invocation aborted');
  });

  it('cancels a pending next and observes cleanup before closing', async () => {
    const started = deferred<void>(); const aborted = deferred<void>(); const cleanup = deferred<void>();
    const stream = new AdmittedStream(identity, async (signal) => {
      started.resolve();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
      await cleanup.promise; return done(message());
    });
    const iterator = stream[Symbol.asyncIterator](); await started.promise;
    const pending = iterator.next(); const closing = iterator.return!();
    await aborted.promise; const observed = vi.fn(); void closing.then(observed);
    await Promise.resolve(); expect(observed).not.toHaveBeenCalled();
    cleanup.resolve(); expect((await pending).done).toBe(true); expect((await closing).done).toBe(true);
    expect((await stream.result()).stopReason).toBe('aborted');
  });

  it('passes an already aborted signal when closed before the attempt starts', async () => {
    let wasAborted = false;
    const stream = new AdmittedStream(identity, async (signal) => { wasAborted = signal.aborted; return done(message()); });
    await stream[Symbol.asyncIterator]().return!();
    expect(wasAborted).toBe(true); expect((await stream.result()).stopReason).toBe('aborted');
  });

  it('preserves an attempt-supplied error terminal as the Pi result', async () => {
    const value = { ...message(), stopReason: 'error' as const, errorMessage: 'safe failure' };
    const stream = new AdmittedStream(identity, async () => ({ type: 'error', reason: 'error', error: value }));
    const events = []; for await (const event of stream) events.push(event);
    expect(events).toEqual([{ type: 'error', reason: 'error', error: value }]);
    expect(await stream.result()).toBe(value);
  });

  it('does not abort on normal completion or return after terminal', async () => {
    let signal!: AbortSignal; const value = message();
    const stream = new AdmittedStream(identity, async (s) => { signal = s; return done(value); });
    const events = []; for await (const event of stream) events.push(event);
    expect(events).toEqual([done(value)]); expect(signal.aborted).toBe(false);
    const second = new AdmittedStream(identity, async (s) => { signal = s; return done(value); });
    const iterator = second[Symbol.asyncIterator](); expect((await iterator.next()).value?.type).toBe('done');
    await iterator.return!(); expect(signal.aborted).toBe(false);
  });

  it('converts callback rejection to a sanitized Pi error terminal and result', async () => {
    const stream = new AdmittedStream(identity, async () => { throw new Error('secret token'); });
    const events = []; for await (const event of stream) events.push(event);
    expect(events).toHaveLength(1); const event = events[0];
    expect(event?.type).toBe('error');
    if (event?.type !== 'error') throw new Error('expected error');
    expect(event.reason).toBe('error'); expect(event.error.stopReason).toBe('error');
    expect(event.error.errorMessage).toBe('Invocation failed');
    expect(JSON.stringify(event)).not.toContain('secret');
    expect(await stream.result()).toBe(event.error);
  });
});
