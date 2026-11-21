import type pg from 'pg';
import { fallbackCategoryId } from '../../../shared/taxonomy.js';
import { articleFingerprint, readChainMetadata, readPreparationReceipt, type ChainMetadataV1 } from '../../domain/article-handoff.js';
import { copyRequestModel, validateRequestModel, type RequestModel } from '../../application/score-context-request.js';

export type CategoryTaskInput = {
  basis: { taskId: string; executionToken: string; articleId: string; generation: number; prerequisiteId: string | null; contentRevision: number; contentText: string; assignmentRevision: number; catalogEpoch: number; articleInputHash?: string; chainRoot?: ChainMetadataV1 };
  title: string | null;
  content: string | null;
  categories: { id: string; label: string }[];
  classifier: RequestModel;
  signal: AbortSignal;
};
export type CategoryInputResult = { kind: 'loaded'; input: CategoryTaskInput } | { kind: 'stale_basis' } | { kind: 'not_owned' } | { kind: 'configuration_required' } | { kind: 'prerequisite_required' } | { kind: 'missing_selected_content' } | { kind: 'content_not_usable' } | { kind: 'invalid_handoff' };

/** Capture an already-owned task. Inference runs only after the transaction ends. */
export class CategoryTaskInputStore {
  constructor(private readonly pool: pg.Pool) {}

  async loadResult(taskId: string, executionToken: string, model: RequestModel | null, signal: AbortSignal): Promise<CategoryInputResult> {
    const stale = { kind: 'stale_basis' } as const;
    const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    if (!uuid(taskId) || !uuid(executionToken) || !signal || typeof signal.addEventListener !== 'function') return { kind: 'not_owned' };
    let classifier: RequestModel | null = null;
    try {
      if (model) {
        validateRequestModel(model);
        classifier = copyRequestModel(model);
      }
    } catch { /* Missing request bounds are configuration, not stale ownership. */ }
    const client = await this.pool.connect();
    try {
      await client.query('begin isolation level read committed');
      const epoch = await client.query<{ revision: number }>('select revision from catalog_epoch where id=1 for share');
      const hint = await client.query<{ article_id: string }>('select article_id from processing_tasks where id=$1', [taskId]);
      if (!hint.rows[0]) { await client.query('rollback'); return { kind: 'not_owned' }; }
      const article = await client.query<{ id: string; title: string | null; source_id: string | null; content_revision: number; assignment_revision: number }>('select id,title,source_id,content_revision,assignment_revision from articles where id=$1 for update', [hint.rows[0].article_id]);
      const task = await client.query<{ id: string; article_id: string; action: string; state: string; execution_token: string | null; generation: number; prerequisite_id: string | null; result: Record<string, unknown> | null }>('select id,article_id,action,state,execution_token,generation,prerequisite_id,result from processing_tasks where id=$1 for update', [taskId]);
      const a = article.rows[0]; const t = task.rows[0];
      if (!a || !t || t.article_id !== a.id || t.action !== 'category' || t.state !== 'running' || t.execution_token !== executionToken.toLowerCase()) { await client.query('rollback'); return { kind: 'not_owned' }; }
      if (!epoch.rows[0]) { await client.query('rollback'); return stale; }
      const hasChain = t.result !== null && Object.hasOwn(t.result, 'articleChain');
      const chain = hasChain ? readChainMetadata(t.result, 'category') : null;
      if (hasChain && (!chain || chain.requiredHandoff !== null || t.generation < 1 || chain.rootTaskId.toLowerCase() !== t.id || chain.prepareTaskId.toLowerCase() !== t.prerequisite_id)) {
        await client.query('rollback'); return { kind: 'invalid_handoff' };
      }
      if (t.prerequisite_id !== null) {
        const prerequisite = await client.query<{ id: string; article_id: string; action: string; state: string; generation: number; result: unknown }>('select id,article_id,action,state,generation,result from processing_tasks where id=$1 for share', [t.prerequisite_id]);
        const p = prerequisite.rows[0];
        if (!p || p.article_id !== a.id || p.action !== 'prepare' || p.state !== 'succeeded') { await client.query('rollback'); return { kind: hasChain ? 'invalid_handoff' : 'prerequisite_required' }; }
        if (chain) {
          const receipt = readPreparationReceipt(p.result);
          if (!receipt || receipt.taskId.toLowerCase() !== p.id || receipt.articleId.toLowerCase() !== a.id || receipt.generation !== p.generation || receipt.contentRevision !== a.content_revision) {
            await client.query('rollback'); return { kind: 'invalid_handoff' };
          }
          const newerPrepare = await client.query('select 1 from processing_tasks where article_id=$1 and action=\'prepare\' and generation>$2 limit 1', [a.id, p.generation]);
          if (newerPrepare.rowCount) { await client.query('rollback'); return stale; }
        }
      }
      const hash = articleFingerprint(a.title, a.source_id);
      if (chain && (!chain.requiredBasis || chain.requiredBasis.contentRevision !== a.content_revision || chain.requiredBasis.assignmentRevision !== a.assignment_revision || chain.requiredBasis.articleInputHash !== hash)) {
        await client.query('rollback'); return stale;
      }
      const content = await client.query<{ text: string; revision: number; quality: string }>('select text,revision,quality from article_contents where article_id=$1 for share', [a.id]);
      const selected = content.rows[0];
      if (selected && selected.revision !== a.content_revision) { await client.query('rollback'); return stale; }
      if (!selected || a.content_revision <= 0 || !selected.text.trim()) { await client.query('rollback'); return { kind: 'missing_selected_content' }; }
      if (selected.quality !== 'usable') { await client.query('rollback'); return { kind: 'content_not_usable' }; }
      // Fresh statement snapshot after the article lock sees newer task inserts.
      const details = await client.query<{ provider: string | null; model: string | null; newer: boolean; categories: { id: string; label: string }[] }>(`select mr.provider, mr.model,
        exists(select 1 from processing_tasks n where n.article_id=$1 and n.action='category' and n.generation>$2) as newer,
        coalesce((select json_agg(json_build_object('id', c.id, 'label', c.label) order by c.id) from categories c where c.archived_at is null), '[]'::json) as categories
        from (select 1) x left join model_roles mr on mr.role='category'`, [a.id, t.generation]);
      const d = details.rows[0]!;
      if (d.newer) { await client.query('rollback'); return stale; }
      if (!classifier || d.provider !== classifier.model.provider || d.model !== classifier.model.model || !d.categories.some(c => c.id === fallbackCategoryId)) {
        await client.query('rollback'); return { kind: 'configuration_required' };
      }
      const input: CategoryTaskInput = { basis: { taskId: t.id, executionToken: t.execution_token!, articleId: a.id, generation: t.generation, prerequisiteId: t.prerequisite_id, contentRevision: a.content_revision, contentText: selected.text, assignmentRevision: a.assignment_revision, catalogEpoch: epoch.rows[0].revision, ...(chain ? { articleInputHash: hash, chainRoot: chain } : {}) }, title: a.title, content: selected.text, categories: d.categories, classifier, signal };
      await client.query('commit');
      return { kind: 'loaded', input };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }
}
