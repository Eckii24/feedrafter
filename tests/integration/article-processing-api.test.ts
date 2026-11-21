import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { articleProcessingFixture } from '../helpers/article-processing-fixture.js';
import { buildHttpApp } from '../../src/server/http/app.js';

it('exposes sanitized category and tag progress over real HTTP and emits task changes', async () => {
  const f = await articleProcessingFixture();
  const controller = new AbortController();
  try {
    const disabled = await buildHttpApp({ ...f.database, origin: f.origin, trustedProxies: [] });
    try {
      const response = await disabled.inject({ method: 'POST', url: `/api/v1/articles/${f.article}/processing`, headers: { host: new URL(f.origin).host, 'content-type': 'application/json' }, payload: '{}' });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('PROCESSING_UNAVAILABLE');
    } finally { await disabled.close(); }
    const get = (id: string) => fetch(`${f.origin}/api/v1/processing-tasks/${id}`);
    const category = await get(f.admitted.categoryTaskId);
    expect(category.status).toBe(200);
    expect(await category.json()).toMatchObject({ id: f.admitted.categoryTaskId, articleId: f.article, action: 'category', scoreTargetId: null, state: 'queued', errorCode: null });
    const tags = await get(f.admitted.tagsTaskId);
    expect(await tags.json()).toMatchObject({ action: 'tags', scoreTargetId: null, state: 'waiting_dependency' });
    expect((await get(f.preparation.id)).status).toBe(404);
    expect((await get(randomUUID())).status).toBe(404);
    const score = await get(f.admitted.scoreTaskIds[0]!);
    expect(await score.json()).toMatchObject({ action: 'scores', scoreTargetId: f.target, state: 'waiting_dependency' });
    const stream = await fetch(`${f.origin}/api/v1/events`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    const received: string[] = [];
    const reading = (async () => {
      const decoder = new TextDecoder();
      try { while (true) { const part = await reader.read(); if (part.done) break; received.push(decoder.decode(part.value)); } } catch { /* abort on cleanup */ }
    })();
    await delay(2200);
    received.length = 0; // Ignore initial snapshots; require events after the updates.
    await f.database.pool.query("update processing_tasks set state='paused_auth',error_code='auth_required',updated_at=now(),result=$2::jsonb where id=$1", [f.admitted.categoryTaskId, JSON.stringify({ secret: 'hidden' })]);
    await f.database.pool.query("update processing_tasks set state='failed',error_code='synthetic_error',updated_at=now(),ended_at=now() where id=$1", [f.admitted.tagsTaskId]);
    await delay(2500);
    const text = received.join('');
    expect(text).toContain(f.admitted.categoryTaskId);
    expect(text).toContain(f.admitted.tagsTaskId);
    expect(text).toContain('task.changed');
    const changed = await (await get(f.admitted.categoryTaskId)).json();
    expect(changed).toMatchObject({ state: 'paused_auth', errorCode: 'auth_required' });
    expect(Object.keys(changed).sort()).toEqual(['action', 'articleId', 'createdAt', 'endedAt', 'errorCode', 'generation', 'id', 'scoreTargetId', 'state', 'updatedAt'].sort());
    expect(JSON.stringify(changed)).not.toContain('secret');
    expect(await (await get(f.admitted.tagsTaskId)).json()).toMatchObject({ state: 'failed', errorCode: 'synthetic_error', endedAt: expect.any(String) });
    controller.abort(); await reading;
  } finally { controller.abort(); await f.close(); }
}, 60000);
