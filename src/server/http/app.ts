import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { listReaderArticles, InvalidCursor, type ReaderQuery } from '../adapters/postgres/reader-query.js';
import { ReaderStore } from '../adapters/postgres/reader-store.js';
import { CatalogStore, CatalogCollision } from '../adapters/postgres/catalog-store.js';
import { fallbackCategoryId, normalizeTagLabel } from '../../shared/taxonomy.js';
import type { ScoreDefinitionInput } from '../../shared/scores.js';
import { PreferenceStore, type FeedbackTarget } from '../adapters/postgres/preference-store.js';
import type { VoteValue } from '../domain/preferences.js';
import { MailStore } from '../adapters/postgres/mail-store.js';
import { ImportStore } from '../adapters/postgres/import-store.js';
import { TaskStore } from '../adapters/postgres/task-store.js';
import type { Database } from '../adapters/postgres/client.js';
import type { ImportJobs } from '../adapters/postgres/import-jobs.js';
import type pg from 'pg';

export interface HttpDependencies { db: Database; pool: pg.Pool; origin: string; trustedProxies: string[]; imports?: { jobs: ImportJobs; contextId: string } }
const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } } as const;
const errorSchema = { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message', 'requestId'], properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' } } } } } as const;
const commonResponses = { 400: errorSchema, 403: errorSchema, 404: errorSchema, 503: errorSchema };
const nullableString = { type: ['string', 'null'] };
const catalogLabel = { type: 'string', description: 'After normalization, 1–200 characters; must not contain NUL.' } as const;
const catalogCreateBody = { type: 'object', additionalProperties: false, required: ['label'], properties: { label: catalogLabel } } as const;
const catalogPatchBody = { oneOf: [catalogCreateBody, { type: 'object', additionalProperties: false, required: ['archived'], properties: { archived: { const: true } } }] } as const;
const scoreTextFields = { name: 200, description: 2000, prompt: 10000 } as const;
const scoreBooleanFields = ['active', 'includeTitle', 'includeContent', 'includeCategory', 'includeTagWeights', 'includeSourceWeight'] as const;
const scoreProperties = { name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' }, description: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' }, prompt: { type: 'string', minLength: 1, maxLength: 10000, pattern: '\\S' }, ...Object.fromEntries(scoreBooleanFields.map(key => [key, { type: 'boolean' }])) };
const scoreBody = { type: 'object', additionalProperties: false, required: Object.keys(scoreProperties), properties: scoreProperties };
const scorePatchBody = { type: 'object', additionalProperties: false, minProperties: 1, properties: scoreProperties };
const scoreRecord = { type: 'object', required: ['id', ...Object.keys(scoreProperties), 'deletedAt'], properties: { id: uuid, ...scoreProperties, name: { type: 'string' }, description: { type: 'string' }, prompt: { type: 'string' }, deletedAt: nullableString } };
const catalogRecord = (kind: 'categories' | 'tags') => ({ type: 'object', required: kind === 'tags' ? ['id', 'label', 'key', 'archivedAt'] : ['id', 'label', 'archivedAt'], properties: { id: uuid, label: { type: 'string' }, ...(kind === 'tags' ? { key: { type: 'string' } } : {}), archivedAt: nullableString } });
const articleSchema = { type: 'object', required: ['id', 'contextId', 'freshrssId', 'sourceId', 'title', 'url', 'author', 'publishedAt', 'importedAt', 'kind', 'isRead', 'mailState', 'scoreValue', 'preparation'], properties: {
  id: uuid, contextId: uuid, freshrssId: { type: 'string' }, sourceId: { type: ['string', 'null'] }, title: nullableString, url: nullableString, author: nullableString,
  publishedAt: nullableString, importedAt: { type: 'string' }, kind: { enum: ['article', 'video'] }, isRead: { type: 'boolean' }, mailState: { enum: ['not_selected', 'selected', 'sent'] }, scoreValue: { type: ['number', 'null'], description: 'Selected score value for score sorting; null when absent or no score selected' }, preparation: { const: 'unavailable' },
} } as const;
const mailContentSchema = { type: 'object', required: ['status', 'text', 'quality', 'limitation', 'failureCode', 'sourceUrl', 'capturedAt'], properties: { status: { enum: ['missing', 'limited', 'available'] }, text: nullableString, quality: nullableString, limitation: nullableString, failureCode: nullableString, sourceUrl: nullableString, capturedAt: nullableString } } as const;
const missingContentSchema = { type: 'object', required: ['status', 'text'], properties: { status: { const: 'missing' }, text: { type: 'null' } } } as const;
const mailItemSchema = { type: 'object', required: ['id', 'url', 'title', 'sourceId', 'sourceTitle', 'author', 'publishedAt', 'importedAt', 'kind', 'selectedAt', 'content', 'transcript', 'summary'], properties: { id: uuid, url: nullableString, title: nullableString, sourceId: nullableString, sourceTitle: nullableString, author: nullableString, publishedAt: nullableString, importedAt: { type: 'string' }, kind: { enum: ['article', 'video'] }, selectedAt: { type: 'string' }, content: mailContentSchema, transcript: missingContentSchema, summary: missingContentSchema } } as const;
const runSchema = { type: 'object', required: ['id', 'contextId', 'status', 'phase', 'fetchedCount', 'confirmedCount', 'pendingCount', 'startedAt', 'endedAt', 'errorCode'], properties: {
  id: uuid, contextId: uuid, status: { type: 'string' }, phase: { type: 'string' }, fetchedCount: { type: 'integer' }, confirmedCount: { type: 'integer' }, pendingCount: { type: 'integer' }, startedAt: { type: 'string' }, endedAt: nullableString, errorCode: nullableString,
} } as const;
const settingsSchema = { type: 'object', required: ['importEnabled', 'importIntervalSeconds', 'nextImportAt'], properties: { importEnabled: { type: 'boolean' }, importIntervalSeconds: { type: 'integer' }, nextImportAt: nullableString } } as const;
function articleDto(row: NonNullable<Awaited<ReturnType<ReaderStore['getArticle']>>>) {
  return { id: row.id, contextId: row.contextId, freshrssId: row.freshrssId, sourceId: row.sourceId, title: row.title, url: row.url, author: row.author, publishedAt: row.publishedAt?.toISOString() ?? null, importedAt: row.importedAt.toISOString(), kind: row.kind, isRead: row.isRead, mailState: row.mailState, scoreValue: null, preparation: 'unavailable' };
}
function runDto(row: NonNullable<Awaited<ReturnType<TaskStore['getRun']>>>) {
  return { id: row.id, contextId: row.contextId, status: row.status, phase: row.phase, fetchedCount: row.fetchedCount, confirmedCount: row.confirmedCount, pendingCount: row.pendingCount, startedAt: row.startedAt.toISOString(), endedAt: row.endedAt?.toISOString() ?? null, errorCode: row.errorCode };
}
export async function buildHttpApp(deps: HttpDependencies) {
  const app = Fastify({ logger: false, bodyLimit: 16384, trustProxy: deps.trustedProxies.length ? deps.trustedProxies : false, ajv: { customOptions: { removeAdditional: false } } });
  await app.register(swagger, { openapi: { info: { title: 'Feedrafter API', version: '1.0.0' } } });
  const reader = new ReaderStore(deps.db); const preferences = new PreferenceStore(deps.pool); const mail = new MailStore(deps.pool); const imports = new ImportStore(deps.db); const tasks = new TaskStore(deps.db);
  const clients = new Set<import('node:http').ServerResponse>();
  const broadcast = (type: string, entityId: string) => {
    const message = `data: ${JSON.stringify({ type, entityId })}\n\n`;
    for (const client of clients) { if (client.writableLength > 16384 || !client.write(message)) { clients.delete(client); client.destroy(); } }
  };
  const heartbeat = setInterval(() => { for (const client of clients) { if (client.writableLength > 16384 || !client.write(': heartbeat\n\n')) { clients.delete(client); client.destroy(); } } }, 15000); heartbeat.unref();
  // Snapshot changes from workers are advisory; clients reload authoritative state.
  let lastRun = '';
  const progress = setInterval(() => { void deps.pool.query('select id, status, phase, fetched_count, confirmed_count, pending_count, error_code from processing_runs order by started_at desc limit 100').then(result => {
    const snapshot = JSON.stringify(result.rows); if (lastRun && snapshot !== lastRun) broadcast('pipeline.changed', 'runs'); lastRun = snapshot;
  }).catch(() => {}); }, 2000); progress.unref();
  app.addHook('preClose', async () => { for (const client of clients) client.destroy(); clients.clear(); });
  app.addHook('onClose', async () => { clearInterval(heartbeat); clearInterval(progress); });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'").header('referrer-policy', 'no-referrer').header('x-content-type-options', 'nosniff');
    const expected = new URL(deps.origin);
    if (request.headers.host?.toLowerCase() !== expected.host.toLowerCase()) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden', requestId: request.id } });
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== deps.origin) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden', requestId: request.id } });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden', requestId: request.id } });
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'JSON content type required', requestId: request.id } });
    }
  });
  app.addHook('preValidation', async (request, reply) => {
    if (request.method === 'POST' && request.routeOptions.url === '/api/v1/articles/:id/feedback' && request.body && typeof request.body === 'object' && !Array.isArray(request.body)) {
      const body = request.body as Record<string, unknown>;
      if (typeof body.value !== 'number' || !Array.isArray(body.targets) || body.targets.some(target => !target || typeof target !== 'object' || Array.isArray(target) || typeof target.id !== 'string' || typeof target.type !== 'string')) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request', requestId: request.id } });
    }
    if (request.method === 'POST' && request.routeOptions.url === '/api/v1/mail-queue/acknowledgements' && request.body && typeof request.body === 'object' && !Array.isArray(request.body)) {
      const ids = (request.body as Record<string, unknown>).articleIds;
      if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request', requestId: request.id } });
    }
    if (['POST', 'PATCH'].includes(request.method) && /^\/api\/v1\/(categories|tags)(\/:id)?$/.test(request.routeOptions.url ?? '') && request.body && typeof request.body === 'object' && !Array.isArray(request.body)) {
      const body = request.body as Record<string, unknown>;
      if (('label' in body && typeof body.label !== 'string') || ('archived' in body && typeof body.archived !== 'boolean')) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request', requestId: request.id } });
    }
    if (['POST', 'PATCH'].includes(request.method) && /^\/api\/v1\/scores(\/:id)?$/.test(request.routeOptions.url ?? '') && request.body && typeof request.body === 'object' && !Array.isArray(request.body)) {
      const body = request.body as Record<string, unknown>;
      const invalidText = Object.entries(scoreTextFields).some(([key, max]) => key in body && (typeof body[key] !== 'string' || !(body[key] as string).trim() || (body[key] as string).length > max || (body[key] as string).includes('\0')));
      if (invalidText || scoreBooleanFields.some(key => key in body && typeof body[key] !== 'boolean')) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request', requestId: request.id } });
    }
    if (request.method === 'PUT' && request.routeOptions.url === '/api/v1/scores/:id/category-prompts/:categoryId' && request.body && typeof request.body === 'object' && !Array.isArray(request.body)) {
      const prompt = (request.body as Record<string, unknown>).prompt;
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 10000 || prompt.includes('\0')) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid prompt', requestId: request.id } });
    }
    if (!['PATCH', 'PUT'].includes(request.method) || !request.body || typeof request.body !== 'object' || Array.isArray(request.body)) return;
    const body = request.body as Record<string, unknown>;
    if (request.routeOptions.url === '/api/v1/articles/:id/category' && typeof body.categoryId !== 'string') return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid category ID', requestId: request.id } });
    if (('selected' in body && typeof body.selected !== 'boolean') || ('isRead' in body && typeof body.isRead !== 'boolean') || ('importEnabled' in body && typeof body.importEnabled !== 'boolean') || ('importIntervalSeconds' in body && typeof body.importIntervalSeconds !== 'number')) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request', requestId: request.id } });
  });
  app.setErrorHandler((error, request, reply) => {
    const e = error as { validation?: unknown; statusCode?: number };
    const status = error instanceof InvalidCursor || e.validation || (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) ? 400 : 500;
    void reply.code(status).send({ error: { code: status === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', message: status === 400 ? 'Invalid request' : 'Internal error', requestId: request.id } });
  });
  await app.register(fastifyStatic, { root: resolve('dist/web'), prefix: '/', wildcard: false });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: request.id } }));
  const notFound = (requestId: string) => ({ error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
  const catalog = new CatalogStore(deps.db);
  for (const kind of ['categories', 'tags'] as const) {
    const path = `/api/v1/${kind}`;
    const list = () => kind === 'categories' ? catalog.listCategories() : catalog.listTags();
    const invalid = (requestId: string, message: string) => ({ error: { code: 'INVALID_REQUEST', message, requestId } });
    const record = catalogRecord(kind);
    app.get(path, { schema: { response: { 200: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: record } } }, 403: errorSchema, 500: errorSchema } } }, async () => ({ items: await list() }));
    const mutate = async (request: import('fastify').FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: import('fastify').FastifyReply, create: boolean) => {
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send(invalid(request.id, 'Invalid request'));
      const data = body as Record<string, unknown>;
      const keys = Object.keys(data);
      if (keys.length !== 1 || (keys[0] !== 'label' && (create || keys[0] !== 'archived' || data.archived !== true))) return reply.code(400).send(invalid(request.id, 'Provide a label or archive action'));
      if (!create && data.archived === true && kind === 'categories' && request.params.id === fallbackCategoryId) return reply.code(400).send(invalid(request.id, 'Fallback category cannot be archived'));
      let label = '';
      if ('label' in data) {
        if (typeof data.label !== 'string') return reply.code(400).send(invalid(request.id, 'Label is required'));
        try { label = kind === 'tags' ? normalizeTagLabel(data.label) : data.label.trim(); } catch { return reply.code(400).send(invalid(request.id, 'Label is required')); }
        if (!label || Array.from(label).length > 200 || label.includes('\u0000')) return reply.code(400).send(invalid(request.id, 'Label must contain 1–200 characters'));
      }
      try {
        const row = create ? (kind === 'categories' ? await catalog.createCategory(label) : await catalog.createTag(label)) : data.archived === true ? (kind === 'categories' ? await catalog.archiveCategory(request.params.id, new Date()) : await catalog.archiveTag(request.params.id, new Date())) : (kind === 'categories' ? await catalog.renameCategory(request.params.id, label) : await catalog.renameTag(request.params.id, label));
        return row ? reply.code(create ? 201 : 200).send(row) : reply.code(404).send(notFound(request.id));
      } catch (error) {
        let cause: unknown = error;
        while (cause && typeof cause === 'object') {
          if (cause instanceof CatalogCollision || ('code' in cause && cause.code === '23505')) return reply.code(409).send({ error: { code: 'CONFLICT', message: 'Label already exists', requestId: request.id } });
          cause = 'cause' in cause ? cause.cause : undefined;
        }
        throw error;
      }
    };
    app.post<{ Params: { id: string }; Body: unknown }>(path, { schema: { body: catalogCreateBody, response: { 201: record, 400: errorSchema, 403: errorSchema, 409: errorSchema, 500: errorSchema } } }, async (request, reply) => mutate(request, reply, true));
    app.patch<{ Params: { id: string }; Body: unknown }>(`${path}/:id`, { schema: { params: idParams, body: catalogPatchBody, response: { 200: record, 400: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema } } }, async (request, reply) => mutate(request, reply, false));
  }
  const scoreErrors = { 400: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema };
  app.get('/api/v1/scores', { schema: { response: { 200: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: scoreRecord } } }, ...scoreErrors } } }, async () => ({ items: await catalog.listScoreDefinitions() }));
  app.post<{ Body: ScoreDefinitionInput }>('/api/v1/scores', { schema: { body: scoreBody, response: { 201: scoreRecord, ...scoreErrors } } }, async (request, reply) => reply.code(201).send(await catalog.createScoreDefinition(request.body)));
  app.patch<{ Params: { id: string }; Body: Partial<ScoreDefinitionInput> }>('/api/v1/scores/:id', { schema: { params: idParams, body: scorePatchBody, response: { 200: scoreRecord, ...scoreErrors } } }, async (request, reply) => {
    const row = await catalog.updateScoreDefinition(request.params.id, request.body);
    if (row) return row;
    const existing = (await catalog.listScoreDefinitions()).find(item => item.id === request.params.id.toLowerCase());
    return existing ? reply.code(409).send({ error: { code: 'DELETED', message: 'Score definition is deleted', requestId: request.id } }) : reply.code(404).send(notFound(request.id));
  });
  const scoreDeleteSchema = { params: idParams, response: { 200: scoreRecord, ...scoreErrors } };
  // Document the JSON object clients send without narrowing the existing accepted JSON bodies.
  app.delete<{ Params: { id: string } }>('/api/v1/scores/:id', { schema: scoreDeleteSchema, config: { swaggerTransform: ({ url }) => ({ url, schema: { ...scoreDeleteSchema, body: { type: 'object' } } }) } }, async (request, reply) => {
    const row = await catalog.deleteScoreDefinition(request.params.id, new Date());
    return row ?? reply.code(404).send(notFound(request.id));
  });
  const overrideRecord = { type: 'object', required: ['scoreId', 'categoryId', 'prompt'], properties: { scoreId: uuid, categoryId: uuid, prompt: { type: 'string' } } };
  const overrideParams = { type: 'object', additionalProperties: false, required: ['id', 'categoryId'], properties: { id: uuid, categoryId: uuid } };
  const overrideError = (result: 'not_found' | 'deleted' | 'invalid_category', requestId: string, reply: import('fastify').FastifyReply) => result === 'not_found' ? reply.code(404).send(notFound(requestId)) : reply.code(result === 'deleted' ? 409 : 400).send({ error: { code: result === 'deleted' ? 'DELETED' : 'INVALID_REQUEST', message: result === 'deleted' ? 'Score definition is deleted' : 'Category must be active and not fallback', requestId } });
  app.get<{ Params: { id: string } }>('/api/v1/scores/:id/category-prompts', { schema: { params: idParams, response: { 200: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: overrideRecord } } }, ...scoreErrors } } }, async (request, reply) => {
    const result = await catalog.scoreCategoryPromptsForScore(request.params.id);
    return result.result === 'ok' ? { items: result.items } : overrideError(result.result, request.id, reply);
  });
  app.put<{ Params: { id: string; categoryId: string }; Body: { prompt: string } }>('/api/v1/scores/:id/category-prompts/:categoryId', { schema: { params: overrideParams, body: { type: 'object', additionalProperties: false, required: ['prompt'], properties: { prompt: scoreProperties.prompt } }, response: { 200: overrideRecord, ...scoreErrors } } }, async (request, reply) => {
    const result = await catalog.saveScoreCategoryPrompt(request.params.id, request.params.categoryId, request.body.prompt);
    return result === 'ok' ? { scoreId: request.params.id.toLowerCase(), categoryId: request.params.categoryId.toLowerCase(), prompt: request.body.prompt } : overrideError(result, request.id, reply);
  });
  app.delete<{ Params: { id: string; categoryId: string }; Body: object }>('/api/v1/scores/:id/category-prompts/:categoryId', { schema: { params: overrideParams, body: { type: 'object', additionalProperties: false, maxProperties: 0 }, response: { 200: { type: 'object', required: ['removed'], properties: { removed: { const: true } } }, ...scoreErrors } } }, async (request, reply) => {
    const result = await catalog.deleteScoreCategoryPrompt(request.params.id, request.params.categoryId);
    return result === 'ok' ? { removed: true } : overrideError(result, request.id, reply);
  });
  app.get('/api/v1/openapi.json', async () => app.swagger());
  app.get('/api/v1/health/live', { schema: { response: { 200: { type: 'object', properties: { status: { const: 'ok' } }, required: ['status'] } } } }, async () => ({ status: 'ok' }));
  app.get('/api/v1/health/ready', { schema: { response: { 200: { type: 'object', properties: { status: { const: 'ok' } }, required: ['status'] }, ...commonResponses } } }, async (req, reply) => {
    try { const result = await deps.pool.query("select to_regclass('public.articles') is not null and to_regclass('public.processing_runs') is not null and to_regclass('public.app_settings') is not null and to_regclass('drizzle.__drizzle_migrations') is not null as ready"); if (!result.rows[0]?.ready) throw new Error(); const version = await deps.pool.query('select max(created_at)::text as version from drizzle.__drizzle_migrations'); if (version.rows[0]?.version !== '1793618549951') throw new Error(); return { status: 'ok' }; }
    catch { return reply.code(503).send({ error: { code: 'NOT_READY', message: 'Not ready', requestId: req.id } }); }
  });
  app.get<{ Querystring: ReaderQuery }>('/api/v1/articles', { schema: { querystring: { type: 'object', additionalProperties: false, properties: {
    read: { enum: ['unread', 'read', 'all'], default: 'unread' }, sort: { enum: ['date', 'title', 'score'], default: 'date' }, direction: { enum: ['asc', 'desc'], default: 'desc' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, source: uuid, scoreId: { ...uuid, description: 'Required for score sort; must identify an active, non-deleted score' }, kind: { enum: ['article', 'video'] }, title: { type: 'string', minLength: 1, maxLength: 200 }, cursor: { type: 'string', minLength: 1, maxLength: 4096 },
  } }, response: { 200: { type: 'object', required: ['items', 'nextCursor'], properties: { items: { type: 'array', items: articleSchema }, nextCursor: nullableString } }, ...commonResponses } } }, async request => listReaderArticles(deps.db, request.query));
  app.get<{ Params: { id: string } }>('/api/v1/articles/:id', { schema: { params: idParams, response: { 200: articleSchema, ...commonResponses } } }, async (request, reply) => { const row = await reader.getArticle(request.params.id); return row ? articleDto(row) : reply.code(404).send(notFound(request.id)); });
  const assignmentResponse = { type: 'object', required: ['category', 'tags', 'assignmentRevision'], properties: { category: catalogRecord('categories'), tags: { type: 'array', items: catalogRecord('tags') }, assignmentRevision: { type: 'integer' } } } as const;
  const okResponse = { type: 'object', required: ['ok'], properties: { ok: { const: true } } } as const;
  const assignmentResponses = { 400: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema };
  app.get<{ Params: { id: string } }>('/api/v1/articles/:id/catalog', { schema: { params: idParams, response: { 200: assignmentResponse, ...assignmentResponses } } }, async (request, reply) => {
    const state = await catalog.articleCatalog(request.params.id);
    return state ?? reply.code(404).send(notFound(request.id));
  });
  const assignmentReply = (result: 'ok' | 'catalog_not_found' | 'article_not_found' | 'archived', requestId: string, reply: import('fastify').FastifyReply, articleId: string) => {
    if (result === 'catalog_not_found' || result === 'article_not_found') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: result === 'catalog_not_found' ? 'Catalog item not found' : 'Article not found', requestId } });
    if (result === 'archived') return reply.code(409).send({ error: { code: 'ARCHIVED', message: 'Catalog item is archived', requestId } });
    broadcast('article.changed', articleId); return { ok: true };
  };
  app.patch<{ Params: { id: string }; Body: { categoryId: string } }>('/api/v1/articles/:id/category', { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['categoryId'], properties: { categoryId: uuid } }, response: { 200: okResponse, ...assignmentResponses } } }, async (request, reply) => assignmentReply(await catalog.setCategory(request.params.id, request.body.categoryId), request.id, reply, request.params.id));
  const tagParams = { type: 'object', additionalProperties: false, required: ['id', 'tagId'], properties: { id: uuid, tagId: uuid } } as const;
  for (const method of ['PUT', 'DELETE'] as const) app.route<{ Params: { id: string; tagId: string } }>({ method, url: '/api/v1/articles/:id/tags/:tagId', schema: { params: tagParams, response: { 200: okResponse, ...assignmentResponses } }, handler: async (request, reply) => assignmentReply(await catalog.changeTag(request.params.id, request.params.tagId, method === 'PUT'), request.id, reply, request.params.id) });
  const feedbackTarget = { type: 'object', additionalProperties: false, required: ['type', 'id'], properties: { type: { enum: ['tag', 'source'] }, id: uuid } } as const;
  const feedbackResponse = { type: 'object', required: ['targets'], properties: { targets: { type: 'array', items: { type: 'object', required: ['type', 'id', 'label', 'detached', 'value', 'votedAt'], properties: { type: { enum: ['tag', 'source'] }, id: uuid, label: { type: 'string' }, detached: { type: 'boolean' }, value: { enum: [-1, 0, 1, null] }, votedAt: nullableString } } } } } as const;
  app.get<{ Params: { id: string } }>('/api/v1/articles/:id/feedback', { schema: { params: idParams, response: { 200: feedbackResponse, ...commonResponses } } }, async (request, reply) => {
    const targets = await preferences.list(request.params.id); return targets ? { targets } : reply.code(404).send(notFound(request.id));
  });
  app.post<{ Params: { id: string }; Body: { value: VoteValue; targets: FeedbackTarget[] } }>('/api/v1/articles/:id/feedback', { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['value', 'targets'], properties: { value: { enum: [-1, 0, 1] }, targets: { type: 'array', minItems: 1, maxItems: 100, items: feedbackTarget } } }, response: { 200: feedbackResponse, ...commonResponses } } }, async (request, reply) => {
    const result = await preferences.vote(request.params.id, request.body.value, request.body.targets);
    if (result === 'not_found') return reply.code(404).send(notFound(request.id));
    if (result === 'invalid') return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid target', requestId: request.id } });
    return { targets: (await preferences.list(request.params.id)) ?? [] };
  });
  app.delete<{ Params: { id: string; kind: 'tags' | 'sources'; targetId: string } }>('/api/v1/articles/:id/feedback/:kind/:targetId', { schema: { params: { type: 'object', additionalProperties: false, required: ['id', 'kind', 'targetId'], properties: { id: uuid, kind: { enum: ['tags', 'sources'] }, targetId: uuid } }, response: { 200: { type: 'object', required: ['ok'], properties: { ok: { const: true } } }, ...commonResponses } } }, async (request, reply) => {
    return await preferences.remove(request.params.id, request.params.kind === 'tags' ? 'tag' : 'source', request.params.targetId) ? { ok: true } : reply.code(404).send(notFound(request.id));
  });
  app.patch<{ Params: { id: string }; Body: { isRead: boolean } }>('/api/v1/articles/:id', { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['isRead'], properties: { isRead: { type: 'boolean' } } }, response: { 200: articleSchema, ...commonResponses } } }, async (request, reply) => { const row = await reader.setRead(request.params.id, request.body.isRead); if (!row) return reply.code(404).send(notFound(request.id)); broadcast('article.changed', row.id); return articleDto(row); });
  app.put<{ Params: { id: string }; Body: { selected: boolean } }>('/api/v1/articles/:id/mail-selection', { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['selected'], properties: { selected: { type: 'boolean' } } }, response: { 200: articleSchema, 409: errorSchema, ...commonResponses } } }, async (request, reply) => {
    const result = await mail.select(request.params.id, request.body.selected);
    if (result === 'not_found') return reply.code(404).send(notFound(request.id));
    if (result === 'sent') return reply.code(409).send({ error: { code: 'MAIL_ALREADY_SENT', message: 'Mail already sent', requestId: request.id } });
    const row = await reader.getArticle(request.params.id);
    if (!row) return reply.code(404).send(notFound(request.id));
    broadcast('article.changed', row.id); return articleDto(row);
  });
  app.get<{ Querystring: { limit: number; cursor?: string } }>('/api/v1/mail-queue', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, cursor: { type: 'string', minLength: 1, maxLength: 1024 } } }, response: { 200: { type: 'object', required: ['items', 'nextCursor'], properties: { items: { type: 'array', items: mailItemSchema }, nextCursor: nullableString } }, ...commonResponses } } }, async request => mail.list(request.query.limit, request.query.cursor));
  app.post<{ Body: { articleIds: string[] } }>('/api/v1/mail-queue/acknowledgements', { schema: { body: { type: 'object', additionalProperties: false, required: ['articleIds'], properties: { articleIds: { type: 'array', minItems: 1, maxItems: 100, items: uuid } } }, response: { 200: { type: 'object', required: ['confirmed', 'alreadyConfirmed', 'rejected'], properties: { confirmed: { type: 'array', items: uuid }, alreadyConfirmed: { type: 'array', items: uuid }, rejected: { type: 'array', items: { type: 'object', required: ['id', 'code'], properties: { id: uuid, code: { enum: ['NOT_FOUND', 'NOT_SELECTED'] } } } } } }, ...commonResponses } } }, async request => {
    const result = await mail.acknowledge(request.body.articleIds);
    for (const id of result.confirmed) broadcast('article.changed', id);
    return result;
  });
  app.post('/api/v1/pipeline/runs', { schema: { body: { type: 'object', additionalProperties: false }, response: { 202: { type: 'object', required: ['runId', 'state', 'reused'], properties: { runId: uuid, state: { type: 'string' }, reused: { type: 'boolean' } } }, ...commonResponses } } }, async (request, reply) => {
    if (!deps.imports) return reply.code(503).send({ error: { code: 'IMPORT_UNAVAILABLE', message: 'Import unavailable', requestId: request.id } });
    const result = await deps.imports.jobs.startImport(deps.imports.contextId); broadcast('pipeline.changed', result.run.id); return reply.code(202).send({ runId: result.run.id, state: result.run.status, reused: result.reused });
  });
  app.get<{ Params: { id: string } }>('/api/v1/pipeline/runs/:id', { schema: { params: idParams, response: { 200: runSchema, ...commonResponses } } }, async (request, reply) => { const row = await tasks.getRun(request.params.id); return row ? runDto(row) : reply.code(404).send(notFound(request.id)); });
  app.get('/api/v1/settings/import', { schema: { response: { 200: settingsSchema, ...commonResponses } } }, async () => { const row = await imports.getSettings(); return { importEnabled: row.importEnabled, importIntervalSeconds: row.importIntervalSeconds, nextImportAt: row.nextImportAt?.toISOString() ?? null }; });
  app.patch<{ Body: { importEnabled?: boolean; importIntervalSeconds?: number } }>('/api/v1/settings/import', { schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { importEnabled: { type: 'boolean' }, importIntervalSeconds: { type: 'integer', minimum: 60, maximum: 2147483647 } } }, response: { 200: settingsSchema, ...commonResponses } } }, async request => {
    const row = await imports.patchSettings(request.body, new Date()); broadcast('settings.changed', 'import'); return { importEnabled: row.importEnabled, importIntervalSeconds: row.importIntervalSeconds, nextImportAt: row.nextImportAt?.toISOString() ?? null };
  });
  app.get('/api/v1/events', async (request, reply) => { if (clients.size >= 100) return reply.code(503).send({ error: { code: 'STREAM_LIMIT', message: 'Stream limit reached', requestId: request.id } }); reply.hijack(); const res = reply.raw; res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive', 'content-security-policy': "default-src 'self'; object-src 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }); res.write(': connected\n\n'); clients.add(res); request.raw.on('close', () => clients.delete(res)); });
  return app;
}
