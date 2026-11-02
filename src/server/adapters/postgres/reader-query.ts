import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from './client.js';
import { articles, articleScores, scoreDefinitions } from './schema/index.js';

export interface ReaderQuery {
  read: 'unread' | 'read' | 'all'; sort: 'date' | 'title' | 'score'; direction: 'asc' | 'desc'; limit: number;
  source?: string; kind?: 'article' | 'video'; title?: string; cursor?: string; scoreId?: string;
}
type Cursor = { v: 1; fingerprint: string; date: string; id: string; title: string | null }
  | { v: 2; fingerprint: string; date: string; id: string; titleHash: string | null }
  | { v: 3; fingerprint: string; date: string; id: string; score: number | null };
export class InvalidCursor extends Error {}
const dateKey = sql`coalesce(${articles.publishedAt}, ${articles.importedAt})`;
const titleKey = sql`lower(${articles.title})`;
function fingerprint(query: ReaderQuery): string {
  return createHash('sha256').update(JSON.stringify([query.read, query.sort, query.direction, query.source ?? null, query.kind ?? null, query.title ?? null, ...(query.sort === 'score' || query.scoreId ? [query.scoreId ?? null] : [])])).digest('hex');
}
function decode(value: string, query: ReaderQuery): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw new Error();
    const c: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!c || typeof c !== 'object') throw new Error();
    const x = c as Record<string, unknown>;
    if (x.fingerprint !== fingerprint(query) || typeof x.date !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(x.date) || !Number.isFinite(Date.parse(x.date)) || typeof x.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x.id)) throw new Error();
    if (x.v === 1) {
      if (!(x.title === null || typeof x.title === 'string')) throw new Error();
    } else if (x.v === 2) {
      if (query.sort !== 'title' || !(x.titleHash === null || (typeof x.titleHash === 'string' && /^[0-9a-f]{64}$/.test(x.titleHash)))) throw new Error();
    } else if (x.v === 3) {
      if (query.sort !== 'score' || !(x.score === null || (typeof x.score === 'number' && Number.isFinite(x.score) && x.score >= 0 && x.score <= 100))) throw new Error();
    } else throw new Error();
    if ((query.sort === 'score') !== (x.v === 3)) throw new Error();
    if (new Date(x.date as string).toISOString().slice(0, 23) !== (x.date as string).slice(0, 23)) throw new Error();
    return x as Cursor;
  } catch { throw new InvalidCursor('Invalid cursor'); }
}
function titleHash(title: string | null): string | null {
  return title === null ? null : createHash('sha256').update(title).digest('hex');
}
export async function listReaderArticles(db: Database, query: ReaderQuery) {
  if (query.sort === 'score') return db.transaction(tx => listReaderArticlesInTransaction(tx, query));
  return listReaderArticlesInTransaction(db, query);
}
async function listReaderArticlesInTransaction(db: Pick<Database, 'execute'>, query: ReaderQuery) {
  if (query.sort === 'score') {
    if (!query.scoreId) throw new InvalidCursor('Score ID required');
    const definition = await db.execute(sql`select 1 from ${scoreDefinitions} where ${scoreDefinitions.id} = ${query.scoreId}::uuid and ${scoreDefinitions.active} and ${scoreDefinitions.deletedAt} is null for share`);
    if (!definition.rows.length) throw new InvalidCursor('Invalid score ID');
  } else if (query.scoreId) throw new InvalidCursor('Score ID requires score sort');
  const predicates: SQL[] = [];
  if (query.read !== 'all') predicates.push(sql`${articles.isRead} = ${query.read === 'read'}`);
  if (query.source) predicates.push(sql`${articles.sourceId} = ${query.source}::uuid`);
  if (query.kind) predicates.push(sql`${articles.kind} = ${query.kind}`);
  if (query.title) predicates.push(sql`${articles.title} ilike ${'%' + query.title.replace(/[\\%_]/g, '\\$&') + '%'} escape '\\'`);
  if (query.cursor) {
    const c = decode(query.cursor, query);
    const tie = sql`(${dateKey} < ${c.date}::timestamptz or (${dateKey} = ${c.date}::timestamptz and ${articles.id} < ${c.id}::uuid))`;
    if (query.sort === 'date') predicates.push(query.direction === 'desc' ? tie : sql`(${dateKey} > ${c.date}::timestamptz or (${dateKey} = ${c.date}::timestamptz and ${articles.id} < ${c.id}::uuid))`);
    else if (query.sort === 'score') {
      if (c.v !== 3) throw new InvalidCursor('Invalid cursor');
      if (c.score === null) predicates.push(sql`${articleScores.value} is null and ${tie}`);
      else {
        const compared = query.direction === 'asc' ? sql`${articleScores.value} > ${c.score}` : sql`${articleScores.value} < ${c.score}`;
        predicates.push(sql`(${articleScores.value} is null or ${compared} or (${articleScores.value} = ${c.score} and ${tie}))`);
      }
    } else {
      if (c.v === 3) throw new InvalidCursor('Invalid cursor');
      let title: string | null;
      if (c.v === 1) title = c.title;
      else {
        // Recover the full SQL sort key without placing an unbounded title in the cursor.
        const anchor = await db.execute(sql`select ${titleKey} as title from ${articles} where ${articles.id} = ${c.id}::uuid`);
        if (anchor.rows.length !== 1) throw new InvalidCursor('Invalid cursor');
        title = anchor.rows[0]!.title as string | null;
        if (titleHash(title) !== c.titleHash) throw new InvalidCursor('Invalid cursor');
      }
      if (title === null) predicates.push(sql`${titleKey} is null and ${tie}`);
      else {
        const compared = query.direction === 'asc' ? sql`${titleKey} > ${title}` : sql`${titleKey} < ${title}`;
        predicates.push(sql`(${titleKey} is null or ${compared} or (${titleKey} = ${title} and ${tie}))`);
      }
    }
  }
  const order = query.sort === 'date'
    ? (query.direction === 'asc' ? sql`${dateKey} asc, ${articles.id} desc` : sql`${dateKey} desc, ${articles.id} desc`)
    : query.sort === 'score'
      ? (query.direction === 'asc' ? sql`${articleScores.value} asc nulls last, ${dateKey} desc, ${articles.id} desc` : sql`${articleScores.value} desc nulls last, ${dateKey} desc, ${articles.id} desc`)
      : (query.direction === 'asc' ? sql`${titleKey} asc nulls last, ${dateKey} desc, ${articles.id} desc` : sql`${titleKey} desc nulls last, ${dateKey} desc, ${articles.id} desc`);
  const where = predicates.length ? sql`where ${sql.join(predicates, sql` and `)}` : sql``;
  const scoreJoin = query.sort === 'score' ? sql`left join ${articleScores} on ${articleScores.articleId} = ${articles.id} and ${articleScores.scoreId} = ${query.scoreId}::uuid` : sql``;
  const scoreValue = query.sort === 'score' ? sql`${articleScores.value}` : sql`null::float8`;
  const result = await db.execute(sql`select ${articles.id} as id, ${articles.contextId} as "contextId", ${articles.freshrssId} as "freshrssId", ${articles.sourceId} as "sourceId", ${articles.title} as title, ${articles.url} as url, ${articles.author} as author, ${articles.publishedAt} as "publishedAt", ${articles.importedAt} as "importedAt", ${articles.kind} as kind, ${articles.isRead} as "isRead", ${articles.mailState} as "mailState", to_char(${dateKey} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorDate", ${titleKey} as "cursorTitle", ${scoreValue} as "scoreValue" from ${articles} ${scoreJoin} ${where} order by ${order} limit ${query.limit + 1}`);
  const rows = result.rows as Array<Record<string, unknown> & { id: string; cursorDate: string; cursorTitle: string | null; scoreValue: number | null }>;
  const more = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor = more && last ? Buffer.from(JSON.stringify(query.sort === 'title'
    ? { v: 2, fingerprint: fingerprint(query), date: last.cursorDate, id: last.id, titleHash: titleHash(last.cursorTitle) }
    : query.sort === 'score' ? { v: 3, fingerprint: fingerprint(query), date: last.cursorDate, id: last.id, score: last.scoreValue }
    : { v: 1, fingerprint: fingerprint(query), date: last.cursorDate, id: last.id, title: null })).toString('base64url') : null;
  const items = page.map(row => ({ id: row.id, contextId: row.contextId, freshrssId: row.freshrssId, sourceId: row.sourceId, title: row.title, url: row.url, author: row.author, publishedAt: row.publishedAt, importedAt: row.importedAt, kind: row.kind, isRead: row.isRead, mailState: row.mailState, scoreValue: row.scoreValue, preparation: 'unavailable' }));
  return { items, nextCursor };
}
