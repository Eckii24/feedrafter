import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import { createPiGenerator } from '../../src/server/adapters/pi/generator.js';
import { UsageService } from '../../src/server/application/usage.js';
import type { UsageAdmissionPort } from '../../src/server/ports/usage.js';

const network = vi.hoisted(() => ({ sends: 0 }));
vi.mock('node:https', async (original) => ({ ...await original<typeof import('node:https')>(), request: () => { network.sends++; throw new Error('Unexpected network'); } }));

it('rejects an omitted API-key output cap before dispatch, including non-sk configured keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-cap-'));
  const key = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'sk-fixture';
  const create = ModelRuntime.create.bind(ModelRuntime);
  vi.spyOn(ModelRuntime, 'create').mockImplementation(options => create({ ...options, authPath: join(dir, 'auth.json') }));
  const stream = ModelRuntime.prototype.stream;
  vi.spyOn(ModelRuntime.prototype, 'stream').mockImplementation(function (this: ModelRuntime, model, context, options) {
    const onPayload = options?.onPayload;
    return stream.call(this, model, context, { ...options, onPayload(payload, payloadModel) {
      const withoutCap = { ...payload as Record<string, unknown> }; delete withoutCap.max_output_tokens;
      return onPayload?.(withoutCap, payloadModel);
    } });
  });
  const port: UsageAdmissionPort = {
    async recover() { return 0; },
    async withOwner(signal, action) { return action({ token: 'owner', signal }); },
    async reserve(owner, intent) { return { admitted: true, reservation: { id: 'r', ownerToken: owner.token, bucket: intent.bucket, dayUtc: '2026-01-01' } }; },
    async settle() { return 'settled'; },
  };
  try {
    const model = { provider: 'openai', model: 'gpt-4.1-mini' };
    const generator = await createPiGenerator(new UsageService(port), [{ role: 'summary', primary: model, fallback: null }]);
    for (const configuredKey of ['sk-fixture', 'fixture-non-sk']) {
      process.env.OPENAI_API_KEY = configuredKey;
      await expect(generator.generate({ model, role: 'summary', system: 'system', user: 'user' }, { bucket: 'interactive', signal: new AbortController().signal })).rejects.toMatchObject({ kind: 'uncertain' });
      expect(network.sends).toBe(0);
    }
  } finally {
    vi.restoreAllMocks();
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
    rmSync(dir, { recursive: true, force: true });
  }
});
