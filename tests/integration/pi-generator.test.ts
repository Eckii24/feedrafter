import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPiGenerator } from '../../src/server/adapters/pi/generator.js';
import { createPiInputTokenCounter } from '../../src/server/adapters/pi/runtime.js';
import { migrateDatabase } from '../../src/server/adapters/postgres/migrate.js';
import { PostgresUsageAdmissionStore } from '../../src/server/adapters/postgres/usage-admission-store.js';
import { CatalogStore } from '../../src/server/adapters/postgres/catalog-store.js';
import { ContentStore } from '../../src/server/adapters/postgres/content-store.js';
import { TagTaskInputStore } from '../../src/server/adapters/postgres/tag-task-input-store.js';
import { TaskStore } from '../../src/server/adapters/postgres/task-store.js';
import { assignTags } from '../../src/server/application/assign-tags.js';
import type { AiPort } from '../../src/server/ports/ai.js';
import { UsageService } from '../../src/server/application/usage.js';
import { systemClock } from '../../src/server/domain/clock.js';
import type { GenerationRequest } from '../../src/server/ports/ai.js';
import { createUsageDatabase } from '../helpers/usage-database.js';

const interception = vi.hoisted(() => ({ port: 0 }));
vi.mock('node:https', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:https')>();
  return { ...original, request: ((url: URL, options: import('node:https').RequestOptions, callback: (res: import('node:http').IncomingMessage) => void) => {
    if (!['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses/input_tokens'].includes(url.href) || !interception.port) throw new Error('Unexpected external request');
    return original.request(new URL(`https://127.0.0.1:${interception.port}${url.pathname}`), { ...options, servername: 'api.openai.com' }, callback);
  }) as typeof original.request };
});

const request: GenerationRequest = { model: { provider: 'openai', model: 'gpt-4.1-mini' }, role: 'summary', system: 'system', user: 'hello' };
const scope = () => ({ bucket: 'automatic' as const, signal: new AbortController().signal });
const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const terminal = (usage?: unknown, status: unknown = 'completed') => event({ type: 'response.completed', response: { status, output: [], ...(usage === undefined ? {} : { usage }) } });
const start = event({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg', role: 'assistant', content: [] } }) + event({ type: 'response.output_text.delta', output_index: 0, delta: 'hello' });
const done = 'data: [DONE]\n\n';
let db: Awaited<ReturnType<typeof createUsageDatabase>>;
let generator: Awaited<ReturnType<typeof createPiGenerator>>;
let server: ReturnType<typeof createServer>;
let dir: string; let key: string | undefined;
let restoreCreate: () => void;
let network: ReturnType<typeof vi.spyOn>;
let accepted = 0;
const pending: Array<{ response: ServerResponse; body: string; authorization: string | undefined; path: string | undefined }> = [];
const waiting: Array<(value: typeof pending[number]) => void> = [];
const next = () => pending.length ? Promise.resolve(pending.shift()!) : new Promise<typeof pending[number]>(resolve => waiting.push(resolve));
const ledger = async () => (await db.pool.query('select status, input_tokens, output_tokens, tokens_source, cost_usd, cost_source from usage_ledger order by occurred_at, id')).rows;
const originalCAs = getCACertificates('default');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pi-generator-'));
  const privateKey = join(dir, 'key.pem'); const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', privateKey, '-out', cert, '-days', '1', '-subj', '/CN=api.openai.com', '-addext', 'subjectAltName=DNS:api.openai.com'], { stdio: 'ignore' });
  setDefaultCACertificates([...originalCAs, readFileSync(cert, 'utf8')]);
  server = createServer({ key: readFileSync(privateKey), cert: readFileSync(cert) }, (req, res) => {
    accepted++; let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; });
    req.on('end', () => { const item = { response: res, body, authorization: req.headers.authorization, path: req.url }; const resolve = waiting.shift(); if (resolve) resolve(item); else pending.push(item); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  interception.port = (server.address() as AddressInfo).port;
  key = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'sk-fixture-key';
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Unexpected network'); });
  const create = ModelRuntime.create.bind(ModelRuntime);
  const spy = vi.spyOn(ModelRuntime, 'create').mockImplementation(options => create({ ...options, authPath: join(dir, 'auth.json') }));
  restoreCreate = () => spy.mockRestore();
  db = await createUsageDatabase(); await migrateDatabase(db.pool);
  generator = await createPiGenerator(new UsageService(new PostgresUsageAdmissionStore(db.pool, systemClock)), [{ role: 'summary', primary: request.model, fallback: null }, { role: 'category', primary: request.model, fallback: null }]);
}, 30000);
afterAll(async () => {
  interception.port = 0; restoreCreate?.(); network?.mockRestore();
  if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
  setDefaultCACertificates(originalCAs); server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await db?.dispose(); if (dir) rmSync(dir, { recursive: true, force: true });
});
const reply = (res: ServerResponse, body: string) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body); };

describe('real Pi generation with a single verified TLS send', () => {
  it('admits the tags kernel as automatic and publishes through the local fixture', async () => {
    const context = (await db.pool.query("insert into import_contexts(instance,account) values ('tags-pi', $1) returning id", [randomUUID()])).rows[0].id;
    const article = (await db.pool.query("insert into articles(context_id,freshrss_id,title,imported_at) values ($1,$2,'Title',now()) returning id", [context, randomUUID()])).rows[0].id;
    const at = new Date();
    await new ContentStore(db.db).saveSuccessful(article, { text: 'Body', quality: 'usable', capturedAt: at });
    await db.pool.query("update model_roles set provider=$1,model=$2 where role='tags'", [request.model.provider, request.model.model]);
    const tasks = new TaskStore(db.db), catalog = new CatalogStore(db.db);
    const category = await tasks.createTask({ articleId: article, action: 'category', generation: 1, createdAt: at, updatedAt: at });
    const categoryToken = randomUUID(); await tasks.claimTask(category.id, categoryToken, at);
    const basis = (await db.pool.query('select category_id,content_revision,assignment_revision,(select revision from catalog_epoch where id=1) as epoch from articles where id=$1', [article])).rows[0];
    const publication = await catalog.publishCategoryCandidate({ taskId: category.id, executionToken: categoryToken, articleId: article, generation: 1, prerequisiteId: null, contentRevision: basis.content_revision, contentText: 'Body', assignmentRevision: basis.assignment_revision, catalogEpoch: basis.epoch, categoryId: basis.category_id }, at);
    expect(publication).not.toBeNull();
    expect(publication?.receipt).toMatchObject({ action: 'category', taskId: category.id, articleId: article });
    const task = await tasks.createTask({ articleId: article, action: 'tags', generation: 1, prerequisiteId: category.id, createdAt: at, updatedAt: at });
    const token = randomUUID(); await tasks.claimTask(task.id, token, at);
    const pi = await createPiGenerator(new UsageService(new PostgresUsageAdmissionStore(db.pool, systemClock)), [{ role: 'tags', primary: request.model, fallback: null }]);
    const ai: AiPort = { ...pi, classify: vi.fn<AiPort['classify']>(), createRestrictedSession: vi.fn<AiPort['createRestrictedSession']>() };
    const before = accepted;
    const attempt = assignTags(task.id, token, { ai, tasks, catalog, inputs: new TagTaskInputStore(db.pool), model: { model: request.model, limits: { contextTokens: 10000, outputTokens: 100, framingTokens: 1 }, countTokens: () => 1 }, signal: new AbortController().signal });
    const received = await Promise.race([next(), attempt.then(result => { throw new Error(`Task ended before fixture: ${result.kind}`); })]);
    expect((await db.pool.query('select bucket,status from usage_ledger where task_id=$1', [task.id])).rows).toEqual([{ bucket: 'automatic', status: 'reserved' }]);
    const answer = event({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg', role: 'assistant', content: [] } }) + event({ type: 'response.output_text.delta', output_index: 0, delta: '{"tags":[]}' });
    reply(received.response, answer + terminal() + done);
    expect(await attempt).toEqual({ kind: 'published' });
    expect(await tasks.getTask(task.id)).toMatchObject({ state: 'succeeded' });
    expect((await db.pool.query('select bucket,status from usage_ledger where task_id=$1', [task.id])).rows).toEqual([{ bucket: 'automatic', status: 'succeeded' }]);
    expect(accepted - before).toBe(1);
  });
  it('commits reservation before wire and waits for HTTP EOF after the completed event and sentinel', async () => {
    const before = accepted; const attempt = generator.generate(request, scope()); const received = await next();
    expect(received.authorization).toBe('Bearer sk-fixture-key');
    expect(JSON.parse(received.body)).toMatchObject({ model: 'gpt-4.1-mini', stream: true, max_output_tokens: 4096 });
    expect(JSON.parse(received.body)).not.toHaveProperty('tools');
    expect((await ledger()).at(-1)).toMatchObject({ status: 'reserved' });
    received.response.writeHead(200, { 'content-type': 'text/event-stream' }); received.response.write(start + terminal({ input_tokens: 4 }) + done);
    let settled = false; void attempt.finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 100)); expect(settled).toBe(false);
    received.response.end();
    expect(await attempt).toMatchObject({ kind: 'completed', value: { text: 'hello', usage: { inputTokens: 4, outputTokens: null, costUsd: null } } });
    expect((await ledger()).at(-1)).toMatchObject({ status: 'succeeded', input_tokens: 4, output_tokens: null, tokens_source: 'provider', cost_usd: null, cost_source: 'unknown' });
    expect(accepted - before).toBe(1);
  });
  it('still rejects Pi thinking blocks on the OpenAI route', async () => {
    const before = accepted; const attempt = generator.generate(request, scope());
    const rejection = expect(attempt).rejects.toMatchObject({ kind: 'uncertain' });
    const received = await next();
    const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: 'private' }] };
    reply(received.response, event({ type: 'response.output_item.added', output_index: 0, item: reasoning })
      + event({ type: 'response.output_item.done', output_index: 0, item: reasoning }) + start + terminal({ input_tokens: 3, output_tokens: 2 }) + done);
    await rejection; expect(accepted - before).toBe(1);
    expect((await ledger()).at(-1)).toMatchObject({ status: 'uncertain', input_tokens: 3, output_tokens: 2 });
  });
  it.each([{ usage: { input_tokens: 0, output_tokens: 0 }, expected: { inputTokens: 0, outputTokens: 0, costUsd: null }, source: 'provider' }, { usage: undefined, expected: null, source: 'unknown' }, { usage: { input_tokens: 'bad', output_tokens: -1 }, expected: null, source: 'unknown' }])('preserves only valid wire usage %#', async ({ usage, expected, source }) => {
    const attempt = generator.generate(request, scope()); const received = await next(); reply(received.response, start + terminal(usage) + done);
    expect(await attempt).toMatchObject({ kind: 'completed', value: { usage: expected } }); expect((await ledger()).at(-1)).toMatchObject({ status: 'succeeded', tokens_source: source });
  });
  it.each(['failed', 'incomplete'] as const)('settles %s terminal usage without publishing partial text', async status => {
    for (const [usage, input, output, source] of [
      [{ input_tokens: 0, output_tokens: 0 }, 0, 0, 'provider'],
      [{ input_tokens: 8, output_tokens: 'invalid' }, 8, null, 'provider'],
      [{ input_tokens: 'invalid', output_tokens: 7 }, null, 7, 'provider'],
      [undefined, null, null, 'unknown'],
      [{ input_tokens: -1, output_tokens: 'bad' }, null, null, 'unknown'],
    ] as const) {
      const attempt = generator.generate(request, scope()); const rejection = expect(attempt).rejects.toMatchObject({ kind: 'provider' });
      const received = await next();
      reply(received.response, start + event({ type: `response.${status}`, response: { status, output: [], ...(usage === undefined ? {} : { usage }), incomplete_details: { reason: 'max_output_tokens' } } }) + done);
      await rejection;
      expect((await ledger()).at(-1)).toMatchObject({ status: 'failed', input_tokens: input, output_tokens: output, tokens_source: source });
    }
  });
  it('treats a conflicting terminal after a failed event and sentinel as uncertain', async () => {
    const attempt = generator.generate(request, scope()); const rejection = expect(attempt).rejects.toMatchObject({ kind: 'uncertain' });
    const received = await next();
    reply(received.response, event({ type: 'response.failed', response: { status: 'failed', usage: { input_tokens: 4 } } }) + done + terminal({ input_tokens: 5 }));
    await rejection;
    expect((await ledger()).at(-1)).toMatchObject({ status: 'uncertain', input_tokens: null, tokens_source: 'unknown' });
  });
  it('accepts completed events followed by EOF without a sentinel', async () => {
    const attempt = generator.generate(request, scope()); const received = await next(); reply(received.response, start + terminal({ output_tokens: 7 }));
    expect(await attempt).toMatchObject({ kind: 'completed', value: { usage: { inputTokens: null, outputTokens: 7, costUsd: null } } });
  });
  it.each(['no-terminal', 'malformed-terminal', 'disconnect', 'abort', 'overflow', 'overflow-after-sentinel', 'timeout', 'timeout-no-sentinel'])('never succeeds on %s', async mode => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = mode.startsWith('timeout') ? vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => nativeTimeout(ms === 60000 ? 300 : ms)) : undefined;
    try {
      const controller = new AbortController(); const before = accepted;
      const attempt = generator.generate(request, { bucket: 'automatic', signal: controller.signal }); const rejection = expect(attempt).rejects.toMatchObject({ kind: 'uncertain' });
      const received = await next(); const res = received.response;
      if (mode === 'no-terminal') reply(res, start + done);
      else if (mode === 'malformed-terminal') reply(res, start + terminal(undefined, null) + done);
      else {
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(start + terminal() + (mode === 'overflow' || mode === 'timeout-no-sentinel' ? '' : done));
        if (mode === 'disconnect') setTimeout(() => res.destroy(), 30);
        if (mode === 'abort') setTimeout(() => controller.abort(), 30);
        if (mode.startsWith('overflow')) res.end('x'.repeat(1024 * 1024 + 1));
      }
      await rejection; expect((await ledger()).at(-1)).toMatchObject({ status: 'uncertain' }); expect(accepted - before).toBe(1);
    } finally { timeout?.mockRestore(); }
  });
  it('rejects bad selection, route, input and pre-abort without a request', async () => {
    const before = accepted; const rows = (await ledger()).length;
    await expect(generator.generate({ ...request, model: { provider: 'openai', model: 'other' } }, scope())).rejects.toThrow();
    await expect(generator.generate({ ...request, user: 'x'.repeat(256 * 1024 + 1) }, scope())).rejects.toThrow();
    const controller = new AbortController(); controller.abort(); await expect(generator.generate(request, { bucket: 'automatic', signal: controller.signal })).rejects.toThrow();
    const original = ModelRuntime.prototype.getPhysicalModel;
    const spy = vi.spyOn(ModelRuntime.prototype, 'getPhysicalModel').mockImplementation(function (this: ModelRuntime, ...args) { const model = original.apply(this, args); return model ? { ...model, baseUrl: 'https://other.invalid/v1' } : model; });
    try { await expect(generator.generate(request, scope())).rejects.toThrow('route'); } finally { spy.mockRestore(); }
    expect(accepted).toBe(before); expect(await ledger()).toHaveLength(rows);
  });
  it('pauses without configured auth and without wire', async () => {
    const original = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
    try {
      const capability = await createPiGenerator(new UsageService(new PostgresUsageAdmissionStore(db.pool, systemClock)), [{ role: 'summary', primary: request.model, fallback: null }]);
      const before = accepted; const rows = (await ledger()).length;
      expect(await capability.generate(request, scope())).toEqual({ kind: 'paused_auth' });
      expect(accepted).toBe(before); expect(await ledger()).toHaveLength(rows);
    } finally { if (original !== undefined) process.env.OPENAI_API_KEY = original; }
  });
  it('admits Pi private OAuth without inventing an output token field', async () => {
    const original = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
    const authPath = join(dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({ openai: { type: 'oauth', access: 'fixture-oauth-token', refresh: 'fixture-refresh', expires: Date.now() + 3600000 } }));
    try {
      const before = accepted; const attempt = generator.generate(request, scope()); const received = await next();
      expect(received.authorization).toBe('Bearer fixture-oauth-token');
      expect(JSON.parse(received.body)).not.toHaveProperty('max_output_tokens');
      expect((await ledger()).at(-1)).toMatchObject({ status: 'reserved' });
      reply(received.response, start + terminal({ input_tokens: 1 }) + done);
      expect(await attempt).toMatchObject({ kind: 'completed', value: { text: 'hello' } });
      expect(accepted - before).toBe(1);
    } finally { writeFileSync(authPath, '{}'); if (original !== undefined) process.env.OPENAI_API_KEY = original; }
  });
  it('persists a successful Pi OAuth refresh before the inference wire', async () => {
    const original = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
    const authPath = join(dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({ openai: { type: 'oauth', access: 'expired-fixture', refresh: 'fixture-refresh', expires: 1, clientId: 'fixture-client' } }));
    network.mockImplementation(async (url: string | URL | Request) => {
      if (String(url) !== 'https://auth.openai.com/api/accounts/oauth/token') throw new Error('Unexpected network');
      return Response.json({ access_token: 'refreshed-fixture', refresh_token: 'rotated-fixture', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' });
    });
    try {
      const attempt = generator.generate(request, scope()); const received = await next();
      expect(received.authorization).toBe('Bearer refreshed-fixture');
      expect(JSON.parse(readFileSync(authPath, 'utf8')).openai).toMatchObject({ access: 'refreshed-fixture', refresh: 'rotated-fixture' });
      reply(received.response, start + terminal() + done);
      expect(await attempt).toMatchObject({ kind: 'completed' });
    } finally {
      network.mockImplementation(() => { throw new Error('Unexpected network'); });
      writeFileSync(authPath, '{}'); if (original !== undefined) process.env.OPENAI_API_KEY = original;
    }
  });
  it('settles an OAuth refresh rejection as auth and pauses cross-role without another refresh, row or wire', async () => {
    vi.resetModules();
    const { UsageService: FreshUsageService } = await import('../../src/server/application/usage.js');
    const fresh = await createPiGenerator(new FreshUsageService(new PostgresUsageAdmissionStore(db.pool, systemClock)), [{ role: 'summary', primary: request.model, fallback: null }, { role: 'category', primary: request.model, fallback: null }]);
    const original = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
    const authPath = join(dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({ openai: { type: 'oauth', access: 'expired-fixture', refresh: 'fixture-refresh', expires: 1, clientId: 'fixture-client' } }));
    const counter = async () => Number((await db.pool.query("select coalesce(sum(requests), 0) as n from request_counters where bucket='automatic'")).rows[0].n);
    const beforeCounter = await counter(); const beforeRows = (await ledger()).length; const beforeWire = accepted;
    network.mockClear(); network.mockImplementation(async (url: string | URL | Request) => {
      if (String(url) !== 'https://auth.openai.com/api/accounts/oauth/token') throw new Error('Unexpected network');
      return new Response('sensitive-fixture-error', { status: 401 });
    });
    try {
      const marker = { ...scope(), taskId: 'oauth-failure-task', turnId: 'oauth-failure-turn' };
      await expect(fresh.generate(request, marker)).rejects.toMatchObject({ kind: 'auth', message: 'Usage attempt auth' });
      expect((await db.pool.query('select status, outcome_code from usage_ledger where task_id=$1 and turn_id=$2', [marker.taskId, marker.turnId])).rows).toEqual([{ status: 'failed', outcome_code: 'provider_auth' }]);
      expect(await fresh.generate({ ...request, role: 'category' }, scope())).toEqual({ kind: 'paused_auth' });
      expect(network).toHaveBeenCalledOnce(); expect(accepted).toBe(beforeWire);
      expect(await ledger()).toHaveLength(beforeRows + 1); expect(await counter()).toBe(beforeCounter + 1);
    } finally {
      network.mockImplementation(() => { throw new Error('Unexpected network'); });
      writeFileSync(authPath, '{}'); if (original !== undefined) process.env.OPENAI_API_KEY = original;
    }
  });
  it('rejects an untrusted fixture certificate', async () => {
    const before = accepted; setDefaultCACertificates(originalCAs);
    try { await expect(generator.generate(request, scope())).rejects.toMatchObject({ kind: 'uncertain' }); expect(accepted).toBe(before); }
    finally { setDefaultCACertificates([...originalCAs, readFileSync(join(dir, 'cert.pem'), 'utf8')]); }
  });
  it('correlates concurrent Pi request markers with committed reservations and denies a third', async () => {
    await db.pool.query("update budget_settings set concurrency=2 where bucket='automatic'");
    const markers = ['generation-correlation-a', 'generation-correlation-b', 'generation-correlation-denied'];
    const context = (marker: string) => ({ ...scope(), taskId: `${marker}-task`, turnId: `${marker}-turn` });
    const counter = async () => Number((await db.pool.query("select coalesce(sum(requests), 0) as n from request_counters where bucket='automatic'")).rows[0].n);
    const beforeCounter = await counter(); const beforeWire = accepted;
    const attempts = markers.slice(0, 2).map(marker => generator.generate({ ...request, user: marker }, context(marker)));
    const held = await Promise.all([next(), next()]);
    try {
      const byMarker = new Map(held.map(item => [markers.find(marker => item.body.includes(marker)), item]));
      expect([...byMarker.keys()].sort()).toEqual(markers.slice(0, 2).sort());
      const rows = (await db.pool.query('select task_id, turn_id, status from usage_ledger where task_id = any($1)', [markers.map(marker => context(marker).taskId)])).rows;
      expect(rows).toHaveLength(2);
      for (const marker of markers.slice(0, 2)) expect(rows).toContainEqual({ task_id: context(marker).taskId, turn_id: context(marker).turnId, status: 'reserved' });
      expect(await generator.generate({ ...request, user: markers[2]! }, context(markers[2]!))).toEqual({ kind: 'paused_budget', reason: 'concurrency_limit' });
      expect(accepted - beforeWire).toBe(2); expect(await counter()).toBe(beforeCounter + 2);
      expect((await db.pool.query('select 1 from usage_ledger where task_id=$1', [context(markers[2]!).taskId])).rowCount).toBe(0);
      reply(byMarker.get(markers[1])!.response, start + terminal() + done);
      expect(await attempts[1]).toMatchObject({ kind: 'completed' });
      expect((await db.pool.query('select status from usage_ledger where task_id=$1', [context(markers[0]!).taskId])).rows[0]).toEqual({ status: 'reserved' });
      reply(byMarker.get(markers[0])!.response, start + terminal() + done);
      expect(await attempts[0]).toMatchObject({ kind: 'completed' });
      expect((await db.pool.query('select status from usage_ledger where task_id = any($1)', [markers.slice(0, 2).map(marker => context(marker).taskId)])).rows).toEqual([{ status: 'succeeded' }, { status: 'succeeded' }]);
      expect(accepted - beforeWire).toBe(2); expect(await counter()).toBe(beforeCounter + 2);
    } finally {
      for (const item of held) item.response.destroy();
      await Promise.allSettled(attempts);
      await db.pool.query("update budget_settings set concurrency=1 where bucket='automatic'");
    }
  });
  it('enforces budget before wire', async () => {
    await db.pool.query("update budget_settings set daily_requests=0 where bucket='automatic'");
    try { const before = accepted; const rows = (await ledger()).length; expect(await generator.generate(request, scope())).toEqual({ kind: 'paused_budget', reason: 'daily_limit' }); expect(accepted).toBe(before); expect(await ledger()).toHaveLength(rows); }
    finally { await db.pool.query("update budget_settings set daily_requests=2000 where bucket='automatic'"); }
  });
  it.each([302, 421, 429, 500, 503])('never retries HTTP %i', async status => {
    const before = accepted; const attempt = generator.generate(request, scope()); const rejection = expect(attempt).rejects.toMatchObject({ kind: 'provider' }); const received = await next();
    received.response.writeHead(status, { location: 'https://other.invalid/' }); received.response.end('error'); await rejection; expect(accepted - before).toBe(1);
  });
  it.each([401, 403])('pauses the shared physical model after HTTP %i', async status => {
    vi.resetModules();
    const { UsageService: FreshUsageService } = await import('../../src/server/application/usage.js');
    const fresh = await createPiGenerator(new FreshUsageService(new PostgresUsageAdmissionStore(db.pool, systemClock)), [{ role: 'summary', primary: request.model, fallback: null }, { role: 'category', primary: request.model, fallback: null }]);
    const before = accepted; const attempt = fresh.generate(request, scope()); const rejection = expect(attempt).rejects.toMatchObject({ kind: 'auth' }); const received = await next(); received.response.writeHead(status); received.response.end('auth'); await rejection;
    expect(await fresh.generate({ ...request, role: 'category' }, scope())).toEqual({ kind: 'paused_auth' }); expect(accepted - before).toBe(1);
  });
});

describe('unwired Responses input-token counter', () => {
  const counter = () => createPiInputTokenCounter(new UsageService(new PostgresUsageAdmissionStore(db.pool, systemClock)), [{ role: 'summary', primary: request.model, fallback: null }]);
  const interactive = () => ({ bucket: 'interactive' as const, signal: new AbortController().signal });
  const json = (res: ServerResponse, body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  it.each([{ system: 'Retain 🐈\nall system text', user: 'User text 🧪\nline two' }, { system: ' \n ', user: '' }])('matches Pi generation input and settles an independent count %#', async texts => {
    const capability = await counter(); const prompt = { ...request, ...texts };
    const before = accepted;
    const generation = generator.generate(prompt, { ...interactive(), taskId: 'parity-generation' }); const generated = await next();
    reply(generated.response, start + terminal() + done); await generation;
    const count = capability.count(prompt, { ...interactive(), taskId: 'parity-preflight' }); const received = await next();
    expect(received.path).toBe('/v1/responses/input_tokens'); expect(received.authorization).toBe('Bearer sk-fixture-key');
    expect(JSON.parse(received.body)).toEqual({ model: 'gpt-4.1-mini', input: JSON.parse(generated.body).input });
    expect(JSON.parse(received.body).input).toEqual([{ role: 'system', content: prompt.system }, { role: 'user', content: [{ type: 'input_text', text: prompt.user }] }]);
    expect((await ledger()).at(-1)).toMatchObject({ status: 'reserved' });
    json(received.response, { object: 'response.input_tokens', input_tokens: 123 });
    expect(await count).toEqual({ kind: 'completed', value: { inputTokens: 123 } });
    expect((await ledger()).at(-1)).toMatchObject({ status: 'succeeded', input_tokens: null, output_tokens: null, tokens_source: 'unknown', cost_usd: null, cost_source: 'unknown' });
    expect((await db.pool.query("select distinct task_id from usage_ledger where task_id in ('parity-generation', 'parity-preflight') and bucket='interactive' and status='succeeded'")).rows).toHaveLength(2);
    expect(accepted - before).toBe(2);
  });
  it('rejects unsupported requests before reservation or wire', async () => {
    const capability = await counter(); const before = accepted; const rows = (await ledger()).length;
    for (const invalid of [
      { ...request, model: { provider: 'openai', model: 'other' } }, { ...request, role: 'category' as const },
      { ...request, system: '' }, { ...request, user: '\ud800' }, { ...request, user: 'x'.repeat(256 * 1024 + 1) },
      { ...request, instructions: 'not supported' }, { ...request, model: { ...request.model, extra: true } },
    ]) await expect(capability.count(invalid, interactive())).rejects.toThrow();
    await expect(capability.count(request, scope())).rejects.toThrow();
    const aborted = new AbortController(); aborted.abort(); await expect(capability.count(request, { bucket: 'interactive', signal: aborted.signal })).rejects.toThrow();
    const original = ModelRuntime.prototype.getPhysicalModel;
    const spy = vi.spyOn(ModelRuntime.prototype, 'getPhysicalModel').mockImplementation(function (this: ModelRuntime, ...args) { const model = original.apply(this, args); return model ? { ...model, baseUrl: 'https://other.invalid/v1' } : model; });
    try { await expect(capability.count(request, interactive())).rejects.toThrow('route'); } finally { spy.mockRestore(); }
    expect(accepted).toBe(before); expect(await ledger()).toHaveLength(rows);
  });
  it('ignores expired OAuth and pauses without a valid environment API key', async () => {
    const capability = await counter(); const original = process.env.OPENAI_API_KEY;
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ openai: { type: 'oauth', access: 'expired', refresh: 'do-not-refresh', expires: 1 } }));
    const before = accepted; const rows = (await ledger()).length; network.mockClear();
    try {
      for (const key of [undefined, '', 'oauth-token', 'sk- invalid']) {
        if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
        expect(await capability.count(request, interactive())).toEqual({ kind: 'paused_auth' });
      }
      expect(accepted).toBe(before); expect(await ledger()).toHaveLength(rows); expect(network).not.toHaveBeenCalled();
    } finally { writeFileSync(join(dir, 'auth.json'), '{}'); if (original !== undefined) process.env.OPENAI_API_KEY = original; }
  });
  it('uses only the environment key even when expired OAuth is stored', async () => {
    const capability = await counter(); const authPath = join(dir, 'auth.json');
    const stored = JSON.stringify({ openai: { type: 'oauth', access: 'expired', refresh: 'do-not-refresh', expires: 1 } });
    writeFileSync(authPath, stored); network.mockClear();
    try {
      const attempt = capability.count(request, interactive()); const received = await next();
      expect(received.authorization).toBe('Bearer sk-fixture-key'); json(received.response, { object: 'response.input_tokens', input_tokens: 0 });
      expect(await attempt).toEqual({ kind: 'completed', value: { inputTokens: 0 } });
      expect(readFileSync(authPath, 'utf8')).toBe(stored); expect(network).not.toHaveBeenCalled();
    } finally { writeFileSync(authPath, '{}'); }
  });
  it('denies budget without dispatch or reservation', async () => {
    const capability = await counter(); await db.pool.query("update budget_settings set daily_requests=0 where bucket='interactive'");
    try { const before = accepted; const rows = (await ledger()).length; expect(await capability.count(request, interactive())).toEqual({ kind: 'paused_budget', reason: 'daily_limit' }); expect(accepted).toBe(before); expect(await ledger()).toHaveLength(rows); }
    finally { await db.pool.query("update budget_settings set daily_requests=2000 where bucket='interactive'"); }
  });
  it.each([{}, { object: 'response.input_tokens', input_tokens: -1 }, { object: 'wrong', input_tokens: 2 }, { object: 'response.input_tokens', input_tokens: 2, extra: true }, { object: 'response.input_tokens', input_tokens: 1.5 }])('rejects malformed output %#', async body => {
    const capability = await counter(); const before = accepted; const attempt = capability.count(request, interactive()); const rejected = expect(attempt).rejects.toMatchObject({ kind: 'provider' });
    const received = await next(); json(received.response, body); await rejected;
    expect((await ledger()).at(-1)).toMatchObject({ status: 'failed', input_tokens: null, tokens_source: 'unknown' }); expect(accepted - before).toBe(1);
  });
  it('rejects invalid JSON and does not retry provider errors', async () => {
    const capability = await counter(); const before = accepted;
    for (const status of [200, 429]) {
      const attempt = capability.count(request, interactive()); const rejected = expect(attempt).rejects.toMatchObject({ kind: 'provider' });
      const received = await next(); received.response.writeHead(status); received.response.end('not json'); await rejected;
    }
    expect(accepted - before).toBe(2);
  });
  it.each(['overflow', 'abort', 'timeout'] as const)('bounds %s and settles uncertain', async mode => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timer = mode === 'timeout' ? vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => nativeTimeout(ms === 60000 ? 300 : ms)) : undefined;
    try {
      const capability = await counter(); const controller = new AbortController(); const before = accepted;
      const attempt = capability.count(request, { bucket: 'interactive', signal: controller.signal }); const rejected = expect(attempt).rejects.toMatchObject({ kind: 'uncertain' });
      const received = await next(); received.response.writeHead(200); received.response.write('{');
      if (mode === 'overflow') received.response.end('x'.repeat(1024 * 1024 + 1));
      if (mode === 'abort') controller.abort();
      await rejected; expect((await ledger()).at(-1)).toMatchObject({ status: 'uncertain', input_tokens: null, tokens_source: 'unknown' }); expect(accepted - before).toBe(1);
    } finally { timer?.mockRestore(); }
  });
  it('pauses the physical model after provider authentication failure', async () => {
    const capability = await counter(); const before = accepted; const attempt = capability.count(request, interactive());
    const rejected = expect(attempt).rejects.toMatchObject({ kind: 'auth' }); const received = await next(); received.response.writeHead(401); received.response.end(); await rejected;
    expect(await capability.count(request, interactive())).toEqual({ kind: 'paused_auth' }); expect(accepted - before).toBe(1);
    expect((await ledger()).at(-1)).toMatchObject({ status: 'failed', input_tokens: null, tokens_source: 'unknown' });
  });
});
