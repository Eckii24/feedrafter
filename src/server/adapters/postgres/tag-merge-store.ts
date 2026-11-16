import type pg from 'pg';

export class TagMergeStore {
  constructor(private readonly pool: pg.Pool) {}

  async merge(targetId: string, sourceIds: string[]): Promise<'ok' | 'invalid' | 'not_found' | 'archived'> {
    targetId = targetId.toLowerCase();
    sourceIds = sourceIds.map(id => id.toLowerCase());
    const ids = [targetId, ...sourceIds].sort();
    if (!sourceIds.length || new Set(ids).size !== ids.length) return 'invalid';
    const client = await this.pool.connect();
    try {
      await client.query('begin isolation level read committed');
      // The epoch row is the first lock, before any participating tag or article.
      const epoch = await client.query('select revision from catalog_epoch where id = 1 for update');
      if (!epoch.rowCount) throw new Error('Missing catalog epoch');
      const tags = await client.query<{ id: string; archived_at: Date | null }>('select id, archived_at from tags where id = any($1::uuid[]) order by id for update', [ids]);
      if (tags.rowCount !== ids.length) { await client.query('rollback'); return 'not_found'; }
      if (tags.rows.some(tag => tag.archived_at)) { await client.query('rollback'); return 'archived'; }
      // Separate statement/snapshot after guards: includes commits waited for above.
      const affected = await client.query<{ article_id: string }>(`select article_id from article_tags where tag_id = any($1::uuid[])
        union select article_id from tag_votes where tag_id = any($1::uuid[]) order by article_id`, [ids]);
      const articles = affected.rows.map(row => row.article_id);
      if (articles.length) await client.query('select id from articles where id = any($1::uuid[]) order by id for update', [articles]);
      // Re-read under all article locks; aggregate original votes exactly once.
      await client.query(`insert into tag_votes (article_id, tag_id, value, voted_at)
        select article_id, $2::uuid, sign(sum(value))::integer, max(voted_at)
        from tag_votes where tag_id = any($1::uuid[]) group by article_id
        on conflict (article_id, tag_id) do update set value = excluded.value, voted_at = excluded.voted_at`, [ids, targetId]);
      await client.query(`insert into article_tags (article_id, tag_id)
        select distinct article_id, $2::uuid from article_tags where tag_id = any($1::uuid[])
        on conflict do nothing`, [sourceIds, targetId]);
      await client.query('delete from article_tags where tag_id = any($1::uuid[])', [sourceIds]);
      await client.query('delete from tag_votes where tag_id = any($1::uuid[])', [sourceIds]);
      await client.query('update tags set manual_offset = (select sum(manual_offset) from tags where id = any($1::uuid[])) where id = $2', [ids, targetId]);
      if (articles.length) await client.query('update articles set assignment_revision = assignment_revision + 1 where id = any($1::uuid[])', [articles]);
      await client.query('update catalog_epoch set revision = revision + 1 where id = 1');
      await client.query('delete from tags where id = any($1::uuid[])', [sourceIds]);
      await client.query('commit');
      return 'ok';
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
}
