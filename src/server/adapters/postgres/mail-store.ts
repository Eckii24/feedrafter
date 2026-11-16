import type pg from 'pg';
import { InvalidCursor } from './reader-query.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Cursor = { v: 1; selectedAt: string; id: string };
function decodeCursor(value: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw new Error();
    const c = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
    if (c.v !== 1 || typeof c.id !== 'string' || !uuidPattern.test(c.id) || typeof c.selectedAt !== 'string' || c.selectedAt.startsWith('0000-') || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(c.selectedAt) || !Number.isFinite(Date.parse(c.selectedAt)) || new Date(c.selectedAt).toISOString().slice(0, 23) !== c.selectedAt.slice(0, 23)) throw new Error();
    return c;
  } catch { throw new InvalidCursor('Invalid cursor'); }
}

export class MailStore {
  constructor(private readonly pool: pg.Pool) {}

  async select(id: string, selected: boolean) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query<{ mail_state: string }>('select mail_state from articles where id = $1::uuid for update', [id]);
      const state = result.rows[0]?.mail_state;
      if (!state) { await client.query('commit'); return 'not_found' as const; }
      if (state === 'sent') { await client.query('commit'); return 'sent' as const; }
      const next = selected ? 'selected' : 'not_selected';
      if (state !== next) await client.query('update articles set mail_state = $2, mail_selected_at = case when $2 = \'selected\' then clock_timestamp() else null end where id = $1::uuid', [id, next]);
      await client.query('commit');
      return next;
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async acknowledge(articleIds: string[]) {
    const ids = [...new Set(articleIds.map(id => id.toLowerCase()))];
    // Reimports lock in feed order; retry the entire transaction if PostgreSQL
    // chooses this acknowledgement as the deadlock victim.
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('begin');
        // UUID order prevents deadlocks between acknowledgement batches.
        const rows = await client.query<{ id: string; mail_state: string }>('select id, mail_state from articles where id = any($1::uuid[]) order by id for update', [ids]);
        const states = new Map(rows.rows.map(row => [row.id, row.mail_state]));
        const confirmed: string[] = [], alreadyConfirmed: string[] = [];
        const rejected: { id: string; code: string }[] = [];
        for (const id of ids) {
          const state = states.get(id);
          if (state === 'selected') confirmed.push(id);
          else if (state === 'sent') alreadyConfirmed.push(id);
          else rejected.push({ id, code: state ? 'NOT_SELECTED' : 'NOT_FOUND' });
        }
        if (confirmed.length) await client.query("update articles set mail_state = 'sent' where id = any($1::uuid[])", [confirmed]);
        await client.query('commit');
        return { confirmed, alreadyConfirmed, rejected };
      } catch (error) {
        await client.query('rollback');
        if (attempt >= 2 || !(error instanceof Error) || !('code' in error) || error.code !== '40P01') throw error;
      } finally { client.release(); }
    }
  }

  async list(limit: number, cursor?: string) {
    const anchor = cursor ? decodeCursor(cursor) : null;
    const result = await this.pool.query(`select a.id, a.url, a.title, a.source_id as "sourceId", s.title as "sourceTitle", a.author,
      a.published_at as "publishedAt", a.imported_at as "importedAt", a.kind,
      to_char(a.mail_selected_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "selectedAt",
      c.text as "contentText", c.quality as "contentQuality", c.limitation as "contentLimitation", c.failure_code as "contentFailureCode", c.source_url as "contentSourceUrl", c.captured_at as "contentCapturedAt",
      sm.text as "summaryText", sm.limitation as "summaryLimitation", sm.content_revision as "summaryRevision", a.content_revision as "contentRevision"
      from articles a left join sources s on s.id = a.source_id left join article_contents c on c.article_id = a.id left join article_summaries sm on sm.article_id = a.id
      where a.mail_state = 'selected' and ($1::timestamptz is null or (a.mail_selected_at, a.id) > ($1::timestamptz, $2::uuid))
      order by a.mail_selected_at, a.id limit $3`, [anchor?.selectedAt ?? null, anchor?.id ?? null, limit + 1]);
    const rows = result.rows; const page = rows.slice(0, limit); const last = page.at(-1);
    return {
      items: page.map(row => ({ id: row.id, url: row.url, title: row.title, sourceId: row.sourceId, sourceTitle: row.sourceTitle, author: row.author, publishedAt: row.publishedAt, importedAt: row.importedAt, kind: row.kind, selectedAt: row.selectedAt,
        content: { status: row.contentText === null ? 'missing' : row.contentLimitation || row.contentFailureCode || row.contentQuality !== 'usable' ? 'limited' : 'available', text: row.contentText, quality: row.contentQuality, limitation: row.contentLimitation, failureCode: row.contentFailureCode, sourceUrl: row.contentSourceUrl, capturedAt: row.contentCapturedAt },
        transcript: { status: 'missing', text: null }, summary: row.summaryText === null ? { status: 'missing', text: null } : { status: row.summaryLimitation || row.summaryRevision !== row.contentRevision ? 'limited' : 'available', text: row.summaryText } })),
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ v: 1, selectedAt: last.selectedAt, id: last.id })).toString('base64url') : null,
    };
  }
}
