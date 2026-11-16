import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicWeb } from '../../src/server/ports/public-web.js';

const workers = vi.hoisted(() => [] as Array<{ emit: (event: string, ...args: unknown[]) => boolean; terminate: ReturnType<typeof vi.fn>; execArgv: string[] }>);
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0);
    execArgv: string[];
    constructor(_url: URL, options: { execArgv: string[] }) { super(); this.execArgv = options.execArgv; workers.push(this); }
  },
}));
import { createWebSearch } from '../../src/server/adapters/web/search.js';

const get: PublicWeb['get'] = async () => ({ status: 200, headers: {}, body: Buffer.from('page'), finalUrl: 'https://example.com/' });
afterEach(() => { vi.useRealTimers(); workers.length = 0; });

describe('search worker lifecycle', () => {
  it('bounds workers and queue, removes cancelled waiters, terminates workers and ignores late results', async () => {
    const controllers = Array.from({ length: 11 }, () => new AbortController());
    const search = createWebSearch({ get }).search;
    const pending = controllers.map(controller => search('q', 5, controller.signal));
    const settled = pending.map(p => p.then(() => undefined, (error: Error) => error));
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await vi.waitFor(async () => expect((await settled[10]!)?.message).toBe('SEARCH_UNAVAILABLE'));
    controllers[2]!.abort();
    expect((await settled[2]!)?.name).toBe('AbortError');
    controllers[0]!.abort();
    expect((await settled[0]!)?.name).toBe('AbortError');
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    workers[0]!.emit('message', { rows: [{ title: 'late', url: 'https://example.com/', snippet: '' }] });
    await vi.waitFor(() => expect(workers).toHaveLength(3));
    controllers.forEach(c => c.abort());
    await Promise.all(settled);
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('holds the slot until delayed termination completes and ignores late messages', async () => {
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const search = createWebSearch({ get }).search;
    const pending = controllers.map(c => search('q', 5, c.signal));
    const settled = pending.map(p => p.then(value => value, (error: Error) => error));
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    let finishTermination!: (value: number) => void;
    workers[0]!.terminate.mockImplementationOnce(() => new Promise<number>(resolve => { finishTermination = resolve; }));
    controllers[0]!.abort();
    await vi.waitFor(() => expect(workers[0]!.terminate).toHaveBeenCalledOnce());
    workers[0]!.emit('message', { rows: [{ title: 'late', url: 'https://example.com/', snippet: '' }] });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(workers).toHaveLength(2);
    finishTermination(0);
    expect((await settled[0] as Error).name).toBe('AbortError');
    await vi.waitFor(() => expect(workers).toHaveLength(3));
    controllers[1]!.abort(); controllers[2]!.abort(); await Promise.all(settled);
  });
  it('terminates the worker after success and removes stdin-only exec flags', async () => {
    process.execArgv.push('--input-type=module');
    try {
      const pending = createWebSearch({ get }).search('q');
      await vi.waitFor(() => expect(workers).toHaveLength(1));
      expect(workers[0]!.execArgv).not.toContain('--input-type=module');
      workers[0]!.emit('message', { rows: [] });
      expect(await pending).toEqual({ provider: 'DuckDuckGo', results: [] });
      expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    } finally { process.execArgv.pop(); }
  });
  it('expires queued work at its original deadline', async () => {
    vi.useFakeTimers();
    const search = createWebSearch({ get }).search;
    const pending = [search('q'), search('q'), search('q')];
    const assertions = pending.map(p => expect(p).rejects.toMatchObject({ name: 'AbortError' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all(assertions);
    expect(workers).toHaveLength(2);
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('rejects and terminates parsing on the absolute deadline, ignoring late messages', async () => {
    vi.useFakeTimers();
    const pending = createWebSearch({ get }).search('q');
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    workers[0]!.emit('message', { rows: [] });
  });
});
