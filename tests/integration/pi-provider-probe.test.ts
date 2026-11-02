import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { PostgresUsageAdmissionStore } from '../../src/server/adapters/postgres/usage-admission-store.js';
import { UsageService } from '../../src/server/application/usage.js';
import { systemClock } from '../../src/server/domain/clock.js';
import { createFakeProvider } from '../helpers/fake-provider.js';
import { createUsageDatabase } from '../helpers/usage-database.js';

it('probes the pinned classifier over loopback behind a committed admission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feedrafter-pi-probe-'));
  const oldKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'fixture-only-key';
  let db: Awaited<ReturnType<typeof createUsageDatabase>> | undefined;
  let fake: Awaited<ReturnType<typeof createFakeProvider>> | undefined;
  try {
    db = await createUsageDatabase();
    await migrateDatabase(db.pool);
    fake = await createFakeProvider();
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false });
    const model = runtime.getModelOfType('classifier', 'typesafe', 'jev-latest');
    if (!model) throw new Error('Missing pinned TypeSafe classifier');
    const service = new UsageService(new PostgresUsageAdmissionStore(db.pool, systemClock));
    const intent = { bucket: 'classifier' as const, role: 'quality' as const, provider: model.provider, model: model.id };
    const scope = { bucket: 'classifier' as const, signal: new AbortController().signal };
    const attempt = service.executeAttempt(intent, scope, async (signal) => {
      const result = await runtime.classify({ ...model, baseUrl: fake!.url }, {
        state: { text: 'fixture' }, questions: { b: { type: 'bool', instructions: 'fixture', criteria: { true: 'yes', false: 'no' } } },
      }, { signal, maxRetries: 0 });
      return { kind: 'success', value: result, terminal: { status: 'succeeded', inputTokens: null, outputTokens: null, costUsd: null, tokensSource: 'unknown', costSource: 'unknown', outcomeCode: null } };
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const request = await Promise.race([
      fake.nextRequest(),
      attempt.then(() => { throw new Error('Attempt ended before reaching the fixture'); }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Fixture request timed out')), 5000); }),
    ]).finally(() => clearTimeout(timeout));
    expect(fake.accepted).toBe(1);
    expect(request.request.url).toBe('/systemone');
    expect((await db.pool.query('select status from usage_ledger')).rows).toEqual([{ status: 'reserved' }]);
    request.respond(200, { 'content-type': 'application/json' }, JSON.stringify({ answers: { b: { type: 'noul', noul: 0.75 } }, usage: { input_tokens: 5 } }));
    const result = await attempt;
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('Probe was not admitted');
    expect(result.value.stopReason).toBe('stop');
    expect(result.value.answers.b).toEqual({ type: 'bool', probability: 0.75 });
    // Pi manufactures output=0 when the provider omits that field; it is not wire evidence.
    expect(result.value.usage).toMatchObject({ input: 5, output: 0 });
    expect((await db.pool.query('select status, input_tokens, output_tokens from usage_ledger')).rows).toEqual([{ status: 'succeeded', input_tokens: null, output_tokens: null }]);
  } finally {
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
    await fake?.close();
    await db?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
