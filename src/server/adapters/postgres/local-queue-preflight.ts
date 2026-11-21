import type pg from 'pg';

/**
 * Check before registering inference workers on an exclusively owned local database.
 * This is a point-in-time check, not a lock against other producers. The caller
 * must ensure no other process can enqueue work throughout the runtime.
 */
export async function assertLocalInferenceQueuesEmpty(pool: pg.Pool): Promise<void> {
  const queues = ['category', 'tags', 'score'];
  const result = await pool.query<{ provisioned: number; pending: boolean }>(
    `select
       (select count(*)::int from pgboss.queue where name=any($1::text[])) as provisioned,
       exists(select 1 from pgboss.job where name=any($1::text[]) and state not in ('completed', 'cancelled', 'failed')) as pending`,
    [queues],
  );
  if (result.rows.length !== 1 || result.rows[0]?.provisioned !== queues.length || result.rows[0]?.pending !== false) {
    throw new Error('Local inference queues are missing or contain pending jobs');
  }
}
