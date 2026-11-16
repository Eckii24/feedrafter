import type pg from 'pg';
import { DEFAULT_PREFERENCE_HALF_LIFE_DAYS, validateHalfLifeDays, validateManualOffset, weight, type VoteValue } from '../../domain/preferences.js';
import { InvalidCursor } from './reader-query.js';

export interface PreferenceQuery { query?: string; sort: 'name' | 'weight' | 'positive' | 'negative'; direction: 'asc' | 'desc'; limit: number; cursor?: string }
type Cursor = { v: 1; kind: string; query: string; sort: string; direction: string; key: number | null; id: string; asOf: string; halfLifeDays: number };

function parseCursor(value: string, kind: string, query: PreferenceQuery): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new Error();
    const c = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
    if (!c || c.v !== 1 || c.kind !== kind || c.query !== (query.query ?? '') || c.sort !== query.sort || c.direction !== query.direction || typeof c.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c.id) || typeof c.asOf !== 'string' || c.asOf.startsWith('0000-') || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.asOf) || !Number.isFinite(Date.parse(c.asOf)) || new Date(c.asOf).toISOString() !== c.asOf || typeof c.halfLifeDays !== 'number' || !Number.isFinite(c.halfLifeDays) || c.halfLifeDays <= 0 || (query.sort === 'name' ? c.key !== null : typeof c.key !== 'number' || !Number.isFinite(c.key))) throw new Error();
    return c;
  } catch { throw new InvalidCursor('Invalid cursor'); }
}

export class PreferenceAdminStore {
  constructor(private readonly pool: pg.Pool) {}

  async settings() {
    const result = await this.pool.query<{ preference_half_life_days: number }>('select preference_half_life_days from app_settings where id = 1');
    return { halfLifeDays: result.rows[0]?.preference_half_life_days ?? DEFAULT_PREFERENCE_HALF_LIFE_DAYS };
  }

  async setHalfLife(halfLifeDays: number) {
    validateHalfLifeDays(halfLifeDays);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      if (!(await client.query('select revision from catalog_epoch where id = 1 for update')).rowCount) throw new Error('Missing catalog epoch');
      await client.query('insert into app_settings (id, preference_half_life_days) values (1, $1) on conflict (id) do update set preference_half_life_days = excluded.preference_half_life_days', [halfLifeDays]);
      await client.query('update catalog_epoch set revision = revision + 1 where id = 1');
      await client.query('commit');
      return { halfLifeDays };
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  async setOffset(kind: 'tags' | 'sources', id: string, manualOffset: number) {
    validateManualOffset(manualOffset);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      if (!(await client.query('select revision from catalog_epoch where id = 1 for update')).rowCount) throw new Error('Missing catalog epoch');
      const result = await client.query(`update ${kind} set manual_offset = $2 where id = $1 returning id`, [id, manualOffset]);
      if (!result.rowCount) { await client.query('rollback'); return null; }
      await client.query('update catalog_epoch set revision = revision + 1 where id = 1');
      await client.query('commit');
      return { id: result.rows[0].id as string, manualOffset };
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  async list(kind: 'tags' | 'sources', query: PreferenceQuery) {
    const cursor = query.cursor ? parseCursor(query.cursor, kind, query) : null;
    const client = await this.pool.connect();
    try {
      await client.query('begin isolation level repeatable read read only');
      const meta = await client.query<{ as_of: Date; half_life: number }>(`select date_trunc('milliseconds', clock_timestamp()) as as_of, coalesce((select preference_half_life_days from app_settings where id=1), 90::float8) as half_life`);
      const { as_of: now, half_life: halfLife } = meta.rows[0]!;
      if (cursor && (cursor.halfLifeDays !== halfLife || Date.parse(cursor.asOf) > now.getTime())) throw new InvalidCursor('Stale cursor');
      const asOf = cursor ? new Date(cursor.asOf) : now;
      const label = kind === 'tags' ? 't.label' : 'coalesce(t.title, t.external_feed_id)';
      let anchor: string | number | null = cursor?.key ?? null;
      if (cursor && query.sort === 'name') {
        const found = await client.query<{ label: string }>(`select ${label} as label from ${kind} t where t.id = $1`, [cursor.id]);
        if (!found.rowCount) throw new InvalidCursor('Stale cursor');
        anchor = found.rows[0]!.label;
      }
      const voteTable = kind === 'tags' ? 'tag_votes' : 'source_votes';
      const voteColumn = kind === 'tags' ? 'tag_id' : 'source_id';
      const sortColumn = { name: 'label', weight: 'raw_weight', positive: 'positive', negative: 'negative' }[query.sort];
      const direction = query.direction === 'asc' ? 'asc' : 'desc';
      const comparison = query.direction === 'asc' ? '>' : '<';
      const result = await client.query<{ id: string; label: string; manual_offset: number; positive: number; negative: number; raw_weight: number; votes: { value: VoteValue; votedAt: string }[] }>(`
        with calculated as (
          select t.id, ${label} as label, t.manual_offset,
            count(v.value) filter (where v.value = 1)::int as positive,
            count(v.value) filter (where v.value = -1)::int as negative,
            t.manual_offset + coalesce(sum(v.value * case
              when date_trunc('milliseconds', v.voted_at) > $1::timestamptz then 0::float8
              when extract(epoch from ($1::timestamptz - date_trunc('milliseconds', v.voted_at)))::float8 / 86400 / 1075 >= $2::float8 then 0::float8
              else power(2::float8, -extract(epoch from ($1::timestamptz - date_trunc('milliseconds', v.voted_at)))::float8 / 86400 / $2::float8)
            end order by v.article_id), 0) as raw_weight,
            coalesce(json_agg(json_build_object('value', v.value, 'votedAt', v.voted_at) order by v.article_id) filter (where v.article_id is not null), '[]'::json) as votes
          from ${kind} t left join ${voteTable} v on v.${voteColumn} = t.id
          where strpos(lower(${label}), lower($3)) > 0
          group by t.id
        )
        select * from calculated
        ${cursor ? `where (${sortColumn} ${comparison} $4 or (${sortColumn} = $4 and id > $5::uuid))` : ''}
        order by ${sortColumn} ${direction}, id asc limit $${cursor ? 6 : 4}`, cursor ? [asOf, halfLife, query.query ?? '', anchor, cursor.id, query.limit + 1] : [asOf, halfLife, query.query ?? '', query.limit + 1]);
      const rows = result.rows.slice(0, query.limit);
      const last = rows.at(-1);
      const nextCursor = result.rows.length > query.limit && last ? Buffer.from(JSON.stringify({ v: 1, kind, query: query.query ?? '', sort: query.sort, direction: query.direction, key: query.sort === 'name' ? null : last[sortColumn as keyof typeof last], id: last.id, asOf: asOf.toISOString(), halfLifeDays: halfLife })).toString('base64url') : null;
      if (cursor && rows.some(row => row.votes.some(v => new Date(v.votedAt).getTime() > asOf.getTime()))) throw new InvalidCursor('Stale cursor');
      const items = rows.map(row => ({ id: row.id, label: row.label, manualOffset: row.manual_offset, positive: row.positive, negative: row.negative, weight: weight(row.manual_offset, row.votes.map(v => ({ value: v.value, votedAt: new Date(v.votedAt) })), asOf, halfLife) }));
      await client.query('commit');
      return { asOf: asOf.toISOString(), halfLifeDays: halfLife, items, nextCursor };
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }
}
