import { idForm, readCategory } from './schemas.js';

type Request = (path: string, init: RequestInit, signal: AbortSignal) => Promise<string>;

/** Wire protocol only. The production client must keep its acknowledgement gate closed until V5. */
export async function sendExactReadAcknowledgement(
  request: Request, authorization: string, ids: readonly string[], signal: AbortSignal,
): Promise<void> {
  const form = idForm(ids);
  const headers = { Authorization: authorization };
  const token = await request('/reader/api/0/token', { method: 'GET', headers }, signal);
  if (!token || token.length > 4096 || /\s/.test(token)) throw new Error('Invalid FreshRSS response');
  form.set('a', readCategory);
  form.set('T', token);
  const result = await request('/reader/api/0/edit-tag', { method: 'POST', headers, body: form }, signal);
  if (result.trim() !== 'OK') throw new Error('Invalid FreshRSS response');
}
