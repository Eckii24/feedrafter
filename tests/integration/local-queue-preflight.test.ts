import { PgBoss } from 'pg-boss';
import { expect, it } from 'vitest';
import { provisionArticleQueues } from '../../src/server/adapters/postgres/article-worker.js';
import { assertLocalInferenceQueuesEmpty } from '../../src/server/adapters/postgres/local-queue-preflight.js';
import { provisionScoreQueue } from '../../src/server/adapters/postgres/score-admission.js';
import { createUsageDatabase } from '../helpers/usage-database.js';

it('rejects missing queues and pending, scheduled, retrying or active inference jobs', async () => {
  const db = await createUsageDatabase();
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error('Missing disposable database connection string');
  const boss = new PgBoss({ connectionString });
  boss.on('error', () => {});
  try {
    await boss.start();
    await expect(assertLocalInferenceQueuesEmpty(db.pool)).rejects.toThrow();
    await provisionArticleQueues(boss);
    await provisionScoreQueue(boss);
    await assertLocalInferenceQueuesEmpty(db.pool);
    for (const queue of ['category', 'tags', 'score']) {
      const id = await boss.send(queue, { taskId: 'fixture' }, { startAfter: 3600 });
      expect(id).toBeTruthy();
      await expect(assertLocalInferenceQueuesEmpty(db.pool)).rejects.toThrow();
      for (const state of ['retry', 'active'] as const) {
        await db.pool.query(`update pgboss.job set state=$1 where id=$2`, [state, id]);
        await expect(assertLocalInferenceQueuesEmpty(db.pool)).rejects.toThrow();
      }
      await db.pool.query("update pgboss.job set state='completed' where id=$1", [id]);
      await assertLocalInferenceQueuesEmpty(db.pool);
    }
  } finally {
    await boss.stop().catch(() => {});
    await db.dispose();
  }
}, 30000);
