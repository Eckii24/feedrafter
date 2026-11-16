import type pg from 'pg';

interface Row {
  score_target_id: string | null; name: string | null; active: boolean | null; deleted_at: Date | null;
  value: number | null; calculated_at: Date | null; content_revision: number | null; assignment_revision: number | null;
  current_content_revision: number; current_assignment_revision: number; condensed: boolean | null; limited: boolean | null;
  generation: number | null; state: string | null; error_code: string | null;
}

export class ScoreReaderStore {
  constructor(private readonly pool: pg.Pool) {}

  // One statement gives article, definitions, saved results and task history one MVCC snapshot.
  async getForReader(articleId: string) {
    const { rows } = await this.pool.query<Row>(`
      with latest_tasks as (
        select distinct on (score_target_id) score_target_id, generation, state, error_code
        from processing_tasks
        where article_id = $1 and action = 'scores' and score_target_id is not null
        order by score_target_id, generation desc, created_at desc, id desc
      )
      select d.id score_target_id, d.name, d.active, d.deleted_at,
        s.value, s.calculated_at, s.content_revision, s.assignment_revision, s.condensed, s.limited,
        a.content_revision current_content_revision, a.assignment_revision current_assignment_revision,
        t.generation, t.state, t.error_code
      from articles a
      left join score_definitions d on true
      left join article_scores s on s.article_id = a.id and s.score_id = d.id
      left join latest_tasks t on t.score_target_id = d.id
      where a.id = $1
      order by d.name, d.id`, [articleId]);
    if (!rows.length) return null;
    return { items: rows.filter(row => row.score_target_id !== null).map(row => ({
      scoreTargetId: row.score_target_id!, name: row.name!, active: row.active!, deleted: row.deleted_at !== null,
      value: row.value, calculatedAt: row.calculated_at?.toISOString() ?? null,
      contentRevision: row.content_revision, assignmentRevision: row.assignment_revision,
      stale: row.value === null ? null : row.content_revision !== row.current_content_revision || row.assignment_revision !== row.current_assignment_revision,
      condensed: row.condensed, limited: row.limited,
      latestTask: row.generation === null ? null : { generation: row.generation, state: row.state!, errorCode: row.error_code },
    })) };
  }
}
