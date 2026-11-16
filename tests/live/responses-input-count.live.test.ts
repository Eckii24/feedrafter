import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { it, vi } from 'vitest';
import { createPiGenerator, createPiInputTokenCounter } from '../../src/server/adapters/pi/runtime.js';
import { UsageService, type AttemptResult, type AttemptScope, type InvokeResult } from '../../src/server/application/usage.js';
import type { ReservationIntent, UsageReservation } from '../../src/server/domain/usage.js';
import type { GenerationRequest } from '../../src/server/ports/ai.js';
import type { UsageAdmissionPort } from '../../src/server/ports/usage.js';

const enabled = process.env.RUN_LIVE_SUMMARY_PARITY === '1';

it.skipIf(!enabled)('compares one synthetic Responses input count with one capped generation', { retry: 0 }, async () => {
  // No runtime, credential store, or network access before validating consent and key.
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.length > 4096 || !/^sk-[\x21-\x7e]+$/u.test(key)) throw new Error('A supported OpenAI API key is required');

  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'feedrafter-parity-'));
    const create = ModelRuntime.create.bind(ModelRuntime);
    vi.spyOn(ModelRuntime, 'create').mockImplementation(options => create({ ...options, authPath: join(dir!, 'auth.json') }));
    const getAuth = ModelRuntime.prototype.getAuth;
    vi.spyOn(ModelRuntime.prototype, 'getAuth').mockImplementation(async function (this: ModelRuntime, ...args) {
      const result = await getAuth.apply(this, args);
      if (result?.auth.apiKey !== key) throw new Error('Unsupported authentication');
      return result;
    });
    // OAuth refresh and incidental global fetch are never allowed.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected fetch'); });

    const reservations: UsageReservation[] = [];
    const settled: string[] = [];
    const permits: number[] = [];
    const port: UsageAdmissionPort = {
      async recover() { return 0; },
      async withOwner(signal, action) { return action({ token: 'synthetic-owner', signal }); },
      async reserve(owner, intent) {
        const index = reservations.length;
        if (index >= 2 || intent.bucket !== 'interactive' || intent.role !== 'summary' || intent.provider !== 'openai' || intent.model !== 'gpt-4.1-mini') throw new Error('Unexpected reservation');
        const reservation: UsageReservation = { id: `synthetic-${index}`, ownerToken: owner.token, bucket: 'interactive', dayUtc: '2026-01-01' };
        reservations.push(reservation); permits.push(0);
        return { admitted: true, reservation };
      },
      async settle(_owner, reservation, terminal) {
        if (reservations[settled.length] !== reservation || permits[settled.length] !== 1 || terminal.status !== 'succeeded') throw new Error('Unexpected settlement');
        settled.push(reservation.id); return 'settled';
      },
    };
    class CountPermits extends UsageService {
      override executeAttempt<T>(intent: ReservationIntent, scope: AttemptScope, invoke: (signal: AbortSignal, permit: { consume(): void }) => Promise<InvokeResult<T>>): Promise<AttemptResult<T>> {
        return super.executeAttempt(intent, scope, (signal, permit) => invoke(signal, { consume() {
          const index = reservations.length - 1;
          if (index < 0 || index !== settled.length || permits[index] !== 0) throw new Error('Unexpected permit');
          permit.consume(); permits[index] = 1;
        } }));
      }
    }
    const usage = new CountPermits(port);
    const model = { provider: 'openai', model: 'gpt-4.1-mini' };
    const mappings = [{ role: 'summary' as const, primary: model, fallback: null }];
    const request: GenerationRequest = { model, role: 'summary', system: 'Answer briefly.', user: 'Say hello to a blue robot.' };
    const scope = { bucket: 'interactive' as const, signal: new AbortController().signal };
    const counter = await createPiInputTokenCounter(usage, mappings);
    const generator = await createPiGenerator(usage, mappings);
    const counted = await counter.count(request, scope);
    if (counted.kind !== 'completed' || !Number.isSafeInteger(counted.value.inputTokens)) throw new Error('Count unavailable');
    const generated = await generator.generate(request, scope);
    if (generated.kind !== 'completed' || generated.value.usage?.inputTokens == null || generated.value.usage.inputTokens !== counted.value.inputTokens) throw new Error('Input count unavailable or mismatched');
    if (reservations.length !== 2 || new Set(reservations.map(item => item.id)).size !== 2 || settled.length !== 2 || permits.some(value => value !== 1)) throw new Error('Invalid admission sequence');
  } catch {
    // Never surface provider errors, credentials, or payloads through the test runner.
    throw new Error('Live parity experiment failed');
  } finally {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});
