import type pg from 'pg';
import type { VoteValue } from '../../domain/preferences.js';

export interface FeedbackTarget { type: 'tag' | 'source'; id: string }
export interface ListedTarget extends FeedbackTarget { label: string; detached: boolean; value: VoteValue | null; votedAt: string | null }

export class PreferenceStore {
  constructor(private readonly pool: pg.Pool) {}

  async list(articleId: string): Promise<ListedTarget[] | null> {
    const exists = await this.pool.query('select 1 from articles where id = $1', [articleId]);
    if (!exists.rowCount) return null;
    const result = await this.pool.query<{ type: 'tag' | 'source'; id: string; label: string; detached: boolean; value: VoteValue | null; voted_at: Date | null }>(`
      select 'tag' as type, t.id, t.label, (at.article_id is null) as detached, v.value, v.voted_at
      from tags t
      left join article_tags at on at.tag_id = t.id and at.article_id = $1
      left join tag_votes v on v.tag_id = t.id and v.article_id = $1
      where at.article_id is not null or v.article_id is not null
      union all
      select 'source', s.id, coalesce(s.title, s.external_feed_id), false, v.value, v.voted_at
      from articles a join sources s on s.id = a.source_id
      left join source_votes v on v.article_id = a.id and v.source_id = s.id
      where a.id = $1
      order by type, label, id`, [articleId]);
    return result.rows.map(row => ({ type: row.type, id: row.id, label: row.label, detached: row.detached, value: row.value, votedAt: row.voted_at?.toISOString() ?? null }));
  }

  async vote(articleId: string, value: VoteValue, targets: FeedbackTarget[]): Promise<'ok' | 'not_found' | 'invalid'> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      if (![-1, 0, 1].includes(value) || !targets.length || new Set(targets.map(t => `${t.type}:${t.id.toLowerCase()}`)).size !== targets.length || targets.some(t => !['tag', 'source'].includes(t.type))) { await client.query('rollback'); return 'invalid'; }
      const article = await client.query<{ source_id: string | null }>('select source_id from articles where id = $1 for update', [articleId]);
      if (!article.rowCount) { await client.query('rollback'); return 'not_found'; }
      for (const target of targets) {
        if (target.type === 'source') {
          if (article.rows[0]!.source_id !== target.id.toLowerCase()) { await client.query('rollback'); return 'invalid'; }
        } else {
          const attached = await client.query('select 1 from article_tags where article_id = $1 and tag_id = $2 for share', [articleId, target.id]);
          const voted = attached.rowCount ? null : await client.query('select 1 from tag_votes where article_id = $1 and tag_id = $2 for share', [articleId, target.id]);
          if (!attached.rowCount && !voted?.rowCount) { await client.query('rollback'); return 'invalid'; }
        }
      }
      const votedAt = (await client.query<{ at: Date }>('select clock_timestamp() as at')).rows[0]!.at;
      for (const target of targets) {
        const table = target.type === 'tag' ? 'tag_votes' : 'source_votes';
        const column = target.type === 'tag' ? 'tag_id' : 'source_id';
        await client.query(`insert into ${table} (article_id, ${column}, value, voted_at) values ($1, $2, $3, $4) on conflict (article_id, ${column}) do update set value = excluded.value, voted_at = excluded.voted_at`, [articleId, target.id, value, votedAt]);
      }
      await client.query('commit');
      return 'ok';
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async remove(articleId: string, type: 'tag' | 'source', targetId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const article = await client.query('select 1 from articles where id = $1 for update', [articleId]);
      if (!article.rowCount) { await client.query('rollback'); return false; }
      const table = type === 'tag' ? 'tag_votes' : 'source_votes';
      const column = type === 'tag' ? 'tag_id' : 'source_id';
      await client.query(`delete from ${table} where article_id = $1 and ${column} = $2`, [articleId, targetId]);
      await client.query('commit'); return true;
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
}
