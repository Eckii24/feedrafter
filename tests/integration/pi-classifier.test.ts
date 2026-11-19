import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { PostgresUsageAdmissionStore } from '../../src/server/adapters/postgres/usage-admission-store.js';
import { createPiClassifier } from '../../src/server/adapters/pi/classifier.js';
import { UsageService } from '../../src/server/application/usage.js';
import { createArticleQualityClassifier } from '../../src/server/application/classify-article-quality.js';
import { systemClock } from '../../src/server/domain/clock.js';
import type { ClassificationRequest } from '../../src/server/ports/ai.js';
import { createFakeProvider } from '../helpers/fake-provider.js';
import { createUsageDatabase } from '../helpers/usage-database.js';

// Test-only socket interception: production still constructs and checks the audited HTTPS route.
const interception = vi.hoisted(() => ({ target: '' }));
vi.mock('node:https', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:https')>();
  const http = await import('node:http');
  return { ...original, request: ((url: URL, options: import('node:http').RequestOptions, callback: (res: import('node:http').IncomingMessage) => void) => {
    if (url.href !== 'https://api.typesafe.ai/v1/systemone' || !interception.target) throw new Error('Unexpected external request');
    return http.request(new URL('/systemone', interception.target), { ...options, headers: { ...options.headers, host: new URL(interception.target).host } }, callback);
  }) as typeof original.request };
});

const request: ClassificationRequest = {
  model: { provider: 'typesafe', model: 'jev-latest' }, role: 'quality', state: { text: 'fixture' },
  questions: {
    b: { type: 'bool', instructions: 'bool', criteria: { true: 'yes', false: 'no' } },
    c: { type: 'choice', instructions: 'choice', criteria: { a: 'A', b: 'B' } },
    s: { type: 'score', instructions: 'score', criteria: ['low', 'mid', 'high'] },
  },
};
const body = { answers: { b: { type: 'noul', noul: 0.75 }, c: { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } }, s: { type: 'score', score: 0.5, confidence: 0.9 } } };
const scope = () => ({ bucket: 'classifier' as const, signal: new AbortController().signal });
let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let fake: Awaited<ReturnType<typeof createFakeProvider>>;
let classifier: Awaited<ReturnType<typeof createPiClassifier>>;
let dir: string; let oldKey: string | undefined;
let restoreCreate: () => void;
let network: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'feedrafter-classifier-'));
  oldKey = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'fixture-only-key';
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Unexpected network'); });
  const create = ModelRuntime.create.bind(ModelRuntime);
  const spy = vi.spyOn(ModelRuntime, 'create').mockImplementation((options) => create({ ...options, authPath: join(dir, 'auth.json') }));
  restoreCreate = () => spy.mockRestore();
  db = await createUsageDatabase(); await migrateDatabase(db.pool);
  fake = await createFakeProvider(); interception.target = fake.url;
  classifier = await createPiClassifier(new UsageService(new PostgresUsageAdmissionStore(db.pool, systemClock)), [
    { role: 'quality', primary: request.model, fallback: null },
    { role: 'category', primary: request.model, fallback: null },
  ]);
}, 30000);
afterAll(async () => {
  interception.target = '';
  restoreCreate?.(); network?.mockRestore();
  if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
  await fake?.close(); await db?.dispose(); if (dir) await rm(dir, { recursive: true, force: true });
});

const ledger = async () => (await db.pool.query('select status, input_tokens, output_tokens, tokens_source, cost_usd, cost_source from usage_ledger order by occurred_at, id')).rows;
const next = async <T>(attempt: Promise<T>) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    fake.nextRequest(), attempt.then(() => { throw new Error('Attempt ended before request'); }, () => { throw new Error('Attempt failed before request'); }),
    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Request timeout')), 5000); }),
  ]).finally(() => clearTimeout(timeout));
};

describe('real Pi classifier and committed usage admission', () => {
  it('constructs and preflights without auth refresh or dispatch; missing auth pauses', async () => {
    const originalKey = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    const refresh = vi.spyOn(ModelRuntime.prototype, 'refresh');
    const classify = vi.spyOn(ModelRuntime.prototype, 'classify');
    const getAuth = vi.spyOn(ModelRuntime.prototype, 'getAuth');
    try {
      const capability = await createPiClassifier(new UsageService(new PostgresUsageAdmissionStore(db.pool, systemClock)), [{ role: 'quality', primary: request.model, fallback: null }]);
      expect(Object.keys(capability)).toEqual(['classify']);
      expect(await capability.classify(request, scope())).toEqual({ kind: 'paused_auth' });
      expect(refresh).not.toHaveBeenCalled(); expect(classify).not.toHaveBeenCalled(); expect(getAuth).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
      expect(await ledger()).toHaveLength(0); expect(fake.accepted).toBe(0);
    } finally {
      if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = originalKey;
      refresh.mockRestore(); classify.mockRestore(); getAuth.mockRestore();
    }
  });
  it('rejects invalid selection and cancellation before reservation and wire', async () => {
    const count = fake.accepted;
    await expect(classifier.classify({ ...request, model: { provider: 'other', model: 'jev-latest' } }, scope())).rejects.toThrow();
    await expect(classifier.classify({ ...request, model: { provider: 'typesafe', model: 'other' } }, scope())).rejects.toThrow();
    await expect(classifier.classify({ ...request, role: 'transcription' }, scope())).rejects.toThrow();
    await expect(classifier.classify({ ...request, role: 'summary' }, scope())).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(classifier.classify(request, { bucket: 'classifier', signal: controller.signal })).rejects.toThrow();
    expect(await ledger()).toHaveLength(0); expect(fake.accepted).toBe(count);
  });
  it('rejects an altered catalog route before reservation', async () => {
    const original = ModelRuntime.prototype.getModelOfType;
    const spy = vi.spyOn(ModelRuntime.prototype, 'getModelOfType').mockImplementation(function (this: ModelRuntime, ...args) {
      const model = original.apply(this, args);
      return model ? { ...model, baseUrl: 'https://other.example/v1/' } as typeof model : model;
    });
    try {
      await expect(classifier.classify(request, scope())).rejects.toThrow('route');
      expect(await ledger()).toHaveLength(0); expect(fake.accepted).toBe(0);
    } finally { spy.mockRestore(); }
  });
  it('holds the response until the reservation is visible; validates answers and preserves missing output usage', async () => {
    const attempt = classifier.classify(request, scope());
    const received = await next(attempt);
    expect(received.request.url).toBe('/systemone');
    expect(received.request.headers.authorization).toBe('Bearer fixture-only-key');
    expect(await ledger()).toMatchObject([{ status: 'reserved' }]);
    received.respond(200, { 'content-type': 'application/json' }, JSON.stringify({ ...body, usage: { input_tokens: 5 } }));
    const result = await attempt;
    expect(result).toMatchObject({ kind: 'completed', value: { answers: { b: { type: 'bool', probability: 0.75 }, c: { choice: 'a' }, s: { score: 0.5, criteria: ['low', 'mid', 'high'] } }, usage: { inputTokens: 5, outputTokens: null, costUsd: null } } });
    expect(await ledger()).toMatchObject([{ status: 'succeeded', input_tokens: 5, output_tokens: null, tokens_source: 'provider', cost_usd: null, cost_source: 'unknown' }]);
  });
  it('routes the quality seam through Pi and records its preparation task', async () => {
    // Fixture-only sizing; not evidence of a provider tokenizer or framing.
    const quality = createArticleQualityClassifier(classifier, { model: request.model, limits: { contextTokens: 10000, outputTokens: 1, framingTokens: 1 }, countTokens: s => Buffer.byteLength(s) });
    const before = fake.accepted;
    const attempt = quality.classify({ text: 'fixture article', sourceUrl: 'https://example.com/article' }, new AbortController().signal, 'quality-fixture-task');
    const received = await next(attempt);
    expect((await db.pool.query('select status from usage_ledger where task_id=$1', ['quality-fixture-task'])).rows).toEqual([{ status: 'reserved' }]);
    received.respond(200, { 'content-type': 'application/json' }, JSON.stringify({ answers: { usable: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 12 } }));
    expect(await attempt).toEqual({ usable: true, probability: 0.8 });
    expect((await db.pool.query('select status,input_tokens,output_tokens from usage_ledger where task_id=$1', ['quality-fixture-task'])).rows).toEqual([{ status: 'succeeded', input_tokens: 12, output_tokens: null }]);
    expect(fake.accepted - before).toBe(1);
  });
  it('correlates concurrent Pi request markers with committed reservations and denies a third', async () => {
    await db.pool.query("update budget_settings set concurrency=2 where bucket='classifier'");
    const markers = ['classifier-correlation-a', 'classifier-correlation-b', 'classifier-correlation-denied'];
    const context = (marker: string) => ({ ...scope(), taskId: `${marker}-task`, turnId: `${marker}-turn` });
    const counter = async () => Number((await db.pool.query("select coalesce(sum(requests), 0) as n from request_counters where bucket='classifier'")).rows[0].n);
    const beforeCounter = await counter(); const beforeWire = fake.accepted;
    const attempts = markers.slice(0, 2).map(marker => classifier.classify({ ...request, state: { text: marker } }, context(marker)));
    const held = await Promise.all(attempts.map(attempt => next(attempt)));
    try {
      const byMarker = new Map(held.map(item => [markers.find(marker => item.body.includes(marker)), item]));
      expect([...byMarker.keys()].sort()).toEqual(markers.slice(0, 2).sort());
      const rows = (await db.pool.query('select task_id, turn_id, status from usage_ledger where task_id = any($1)', [markers.map(marker => context(marker).taskId)])).rows;
      expect(rows).toHaveLength(2);
      for (const marker of markers.slice(0, 2)) expect(rows).toContainEqual({ task_id: context(marker).taskId, turn_id: context(marker).turnId, status: 'reserved' });
      expect(await classifier.classify({ ...request, state: { text: markers[2]! } }, context(markers[2]!))).toEqual({ kind: 'paused_budget', reason: 'concurrency_limit' });
      expect(fake.accepted - beforeWire).toBe(2); expect(await counter()).toBe(beforeCounter + 2);
      expect((await db.pool.query('select 1 from usage_ledger where task_id=$1', [context(markers[2]!).taskId])).rowCount).toBe(0);
      byMarker.get(markers[1])!.respond(200, {}, JSON.stringify(body));
      expect(await attempts[1]).toMatchObject({ kind: 'completed' });
      expect((await db.pool.query('select status from usage_ledger where task_id=$1', [context(markers[0]!).taskId])).rows[0]).toEqual({ status: 'reserved' });
      byMarker.get(markers[0])!.respond(200, {}, JSON.stringify(body));
      expect(await attempts[0]).toMatchObject({ kind: 'completed' });
      expect((await db.pool.query('select status from usage_ledger where task_id = any($1)', [markers.slice(0, 2).map(marker => context(marker).taskId)])).rows).toEqual([{ status: 'succeeded' }, { status: 'succeeded' }]);
      expect(fake.accepted - beforeWire).toBe(2); expect(await counter()).toBe(beforeCounter + 2);
    } finally {
      for (const item of held) item.disconnect();
      await Promise.allSettled(attempts);
      await db.pool.query("update budget_settings set concurrency=2 where bucket='classifier'");
    }
  });
  it('denies budget without wire or another reservation', async () => {
    await db.pool.query("update budget_settings set daily_requests=0 where bucket='classifier'");
    const before = fake.accepted; const rows = (await ledger()).length;
    expect(await classifier.classify(request, scope())).toEqual({ kind: 'paused_budget', reason: 'daily_limit' });
    expect(fake.accepted).toBe(before); expect(await ledger()).toHaveLength(rows);
    await db.pool.query("update budget_settings set daily_requests=2000 where bucket='classifier'");
  });
  it.each([302, 421, 429, 500, 503])('does not retry HTTP %i', async (status) => {
    const before = fake.accepted; const rows = (await ledger()).length;
    const attempt = classifier.classify(request, scope()); const received = await next(attempt);
    received.respond(status, { location: `${fake.url}/redirected` }, 'failure');
    await expect(attempt).rejects.toMatchObject({ kind: 'provider' });
    expect(fake.accepted - before).toBe(1); expect(await ledger()).toHaveLength(rows + 1);
  });
  it.each(['disconnect', 'invalid-json', 'invalid-answer', 'invalid-choice', 'invalid-score', 'extra-answer'])('does not retry %s', async (mode) => {
    const before = fake.accepted; const rows = (await ledger()).length;
    const attempt = classifier.classify(request, scope()); const received = await next(attempt);
    if (mode === 'disconnect') received.disconnect();
    else if (mode === 'invalid-json') received.respond(200, {}, '{');
    else if (mode === 'extra-answer') received.respond(200, {}, JSON.stringify({ answers: { ...body.answers, extra: {} } }));
    else if (mode === 'invalid-choice') received.respond(200, {}, JSON.stringify({ answers: { ...body.answers, c: { ...body.answers.c, choice: 'other' } } }));
    else if (mode === 'invalid-score') received.respond(200, {}, JSON.stringify({ answers: { ...body.answers, s: { ...body.answers.s, score: 3 } } }));
    else received.respond(200, {}, JSON.stringify({ answers: { ...body.answers, b: { type: 'noul', noul: 2 } } }));
    await expect(attempt).rejects.toThrow();
    expect(fake.accepted - before).toBe(1); expect(await ledger()).toHaveLength(rows + 1);
  });
  it('preserves observed input usage on malformed answers without synthesizing output', async () => {
    const attempt = classifier.classify(request, scope()); const received = await next(attempt);
    received.respond(200, {}, JSON.stringify({ answers: {}, usage: { input_tokens: 9 } }));
    await expect(attempt).rejects.toMatchObject({ kind: 'provider' });
    expect((await ledger()).at(-1)).toMatchObject({ status: 'failed', input_tokens: 9, output_tokens: null, tokens_source: 'provider' });
  });
  it('keeps wholly absent usage unknown', async () => {
    const attempt = classifier.classify(request, scope()); const received = await next(attempt);
    received.respond(200, {}, JSON.stringify(body));
    expect(await attempt).toMatchObject({ kind: 'completed', value: { usage: null } });
    expect((await ledger()).at(-1)).toMatchObject({ status: 'succeeded', input_tokens: null, output_tokens: null, tokens_source: 'unknown', cost_usd: null, cost_source: 'unknown' });
  });
  it('pauses the same physical model across roles after auth rejection', async () => {
    const before = fake.accepted; const rows = (await ledger()).length;
    const attempt = classifier.classify(request, scope()); const received = await next(attempt);
    received.respond(401, {}, 'unauthorized');
    await expect(attempt).rejects.toMatchObject({ kind: 'auth' });
    expect(await classifier.classify({ ...request, role: 'category' }, scope())).toEqual({ kind: 'paused_auth' });
    expect(fake.accepted - before).toBe(1); expect(await ledger()).toHaveLength(rows + 1);
  });
});
