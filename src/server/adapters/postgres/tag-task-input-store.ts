import type pg from 'pg';
import { copyRequestModel, validateRequestModel, type RequestModel } from '../../application/score-context-request.js';
import type { TagCandidate } from './catalog-store.js';
import { articleFingerprint, readChainMetadata, readHandoffReceipt, readPreparationReceipt } from '../../domain/article-handoff.js';

export type TagTaskInput = {
  basis: Omit<TagCandidate, 'labels'>;
  title: string | null;
  category: string;
  content: string;
  generator: RequestModel;
};
export type TagInputResult = { kind: 'loaded'; input: TagTaskInput } | { kind: 'stale_basis' | 'not_owned' | 'configuration_required' | 'prerequisite_required' | 'missing_selected_content' | 'content_not_usable' | 'content_revision_mismatch' | 'invalid_handoff' };

/** Capture an already-owned task and its exact category basis; no inference under locks. */
export class TagTaskInputStore {
  constructor(private readonly pool: pg.Pool) {}

  async loadResult(taskId: string, executionToken: string, model: RequestModel | null, signal: AbortSignal): Promise<TagInputResult> {
    const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    if (!uuid(taskId) || !uuid(executionToken) || !signal || typeof signal.addEventListener !== 'function') return { kind: 'not_owned' };
    let generator: RequestModel | null = null;
    try { if (model) { validateRequestModel(model); generator = copyRequestModel(model); } } catch { /* Configuration is not ownership. */ }
    const client = await this.pool.connect();
    try {
      await client.query('begin isolation level read committed');
      const fail = async (kind: Exclude<TagInputResult, { kind: 'loaded' }>['kind']): Promise<TagInputResult> => { await client.query('rollback'); return { kind }; };
      const epoch = await client.query<{ revision: number }>('select revision from catalog_epoch where id=1 for share');
      const hint = await client.query<{ article_id: string }>('select article_id from processing_tasks where id=$1', [taskId]);
      if (!hint.rows[0]) return await fail('not_owned');
      const article = await client.query<{ id: string; title: string | null; source_id: string | null; category_id: string; content_revision: number; assignment_revision: number }>('select id,title,source_id,category_id,content_revision,assignment_revision from articles where id=$1 for update', [hint.rows[0].article_id]);
      const task = await client.query<{ id: string; article_id: string; action: string; state: string; execution_token: string | null; generation: number; prerequisite_id: string | null; result: Record<string, unknown> | null }>('select id,article_id,action,state,execution_token,generation,prerequisite_id,result from processing_tasks where id=$1 for update', [taskId]);
      const a = article.rows[0], t = task.rows[0];
      if (!a || !t || t.article_id !== a.id || t.action !== 'tags' || t.state !== 'running' || t.execution_token !== executionToken.toLowerCase()) return await fail('not_owned');
      if (!epoch.rows[0]) return await fail('stale_basis');
      if (!t.prerequisite_id) return await fail('prerequisite_required');
      const prerequisite = await client.query<{ id: string; article_id: string; action: string; state: string; generation: number; prerequisite_id: string | null; result: Record<string, unknown> | null }>('select id,article_id,action,state,generation,prerequisite_id,result from processing_tasks where id=$1 for share', [t.prerequisite_id]);
      const p = prerequisite.rows[0];
      if (!p || p.article_id !== a.id || p.action !== 'category' || p.state !== 'succeeded') return await fail('prerequisite_required');
      const receipt = readHandoffReceipt(p.result);
      if (!receipt || receipt.action !== 'category' || receipt.taskId.toLowerCase() !== p.id || receipt.articleId.toLowerCase() !== a.id || receipt.generation !== p.generation || (receipt.prerequisiteId?.toLowerCase() ?? null) !== p.prerequisite_id) return await fail('invalid_handoff');
      const hasChain = t.result !== null && Object.hasOwn(t.result, 'articleChain');
      const rootPresent = p.result !== null && Object.hasOwn(p.result, 'articleChain');
      const chain = hasChain ? readChainMetadata(t.result, 'tags') : null;
      const root = rootPresent ? readChainMetadata(p.result, 'category') : null;
      if (hasChain !== rootPresent || (hasChain && (!chain || !root || root.requiredHandoff !== null || !chain.requiredHandoff || !chain.requiredBasis || t.generation < 1 || p.generation < 1 || root.rootTaskId.toLowerCase() !== p.id || root.tagsTaskId.toLowerCase() !== t.id || root.prepareTaskId.toLowerCase() !== p.prerequisite_id || chain.rootTaskId.toLowerCase() !== p.id || chain.prepareTaskId.toLowerCase() !== p.prerequisite_id || chain.requiredHandoff.taskId.toLowerCase() !== p.id || chain.requiredHandoff.generation !== p.generation || root.requiredBasis.contentRevision !== receipt.basis.contentRevision || root.requiredBasis.articleInputHash !== receipt.basis.articleInputHash || receipt.basis.assignmentRevision < root.requiredBasis.assignmentRevision || receipt.basis.assignmentRevision - root.requiredBasis.assignmentRevision > 1 || JSON.stringify(chain.requiredBasis) !== JSON.stringify(receipt.basis)))) return await fail('invalid_handoff');
      if (p.prerequisite_id !== null) {
        const prepare = await client.query<{ id: string; article_id: string; action: string; state: string; generation: number; result: unknown }>('select id,article_id,action,state,generation,result from processing_tasks where id=$1 for share', [p.prerequisite_id]);
        const q = prepare.rows[0];
        if (!q || q.article_id !== a.id || q.action !== 'prepare' || q.state !== 'succeeded') return await fail(hasChain ? 'invalid_handoff' : 'prerequisite_required');
        if (chain) {
          const preparation = readPreparationReceipt(q.result);
          if (!preparation || preparation.taskId.toLowerCase() !== q.id || preparation.articleId.toLowerCase() !== a.id || preparation.generation !== q.generation || preparation.contentRevision !== receipt.basis.contentRevision) return await fail('invalid_handoff');
          const newer = await client.query("select 1 from processing_tasks where article_id=$1 and action='prepare' and generation>$2 limit 1", [a.id, q.generation]);
          if (newer.rowCount) return await fail('stale_basis');
        }
      }
      const hash = articleFingerprint(a.title, a.source_id);
      if (chain && (receipt.categoryId.toLowerCase() !== a.category_id || receipt.basis.contentRevision !== a.content_revision || receipt.basis.assignmentRevision !== a.assignment_revision || receipt.basis.articleInputHash !== hash)) return await fail('stale_basis');
      const content = await client.query<{ text: string; revision: number; quality: string }>('select text,revision,quality from article_contents where article_id=$1 for share', [a.id]);
      const selected = content.rows[0];
      if (selected && selected.revision !== a.content_revision) return await fail('content_revision_mismatch');
      if (!selected || a.content_revision <= 0 || !selected.text.trim()) return await fail('missing_selected_content');
      if (selected.quality !== 'usable') return await fail('content_not_usable');
      // A fresh statement after the article lock sees task insertions serialized by TaskStore.
      const details = await client.query<{ provider: string | null; model: string | null; label: string | null; newer: boolean }>(`select mr.provider,mr.model,c.label,
        exists(select 1 from processing_tasks n where n.article_id=$1 and ((n.action='tags' and n.generation>$2) or (n.action='category' and n.generation>$3))) as newer
        from (select 1) x left join model_roles mr on mr.role='tags' left join categories c on c.id=$4`, [a.id, t.generation, p.generation, a.category_id]);
      const d = details.rows[0]!;
      if (d.newer) return await fail('stale_basis');
      if (!generator || d.provider !== generator.model.provider || d.model !== generator.model.model || d.label === null) return await fail('configuration_required');
      const input: TagTaskInput = { basis: { taskId: t.id, executionToken: t.execution_token!, articleId: a.id, generation: t.generation, prerequisiteTaskId: t.prerequisite_id, prerequisiteGeneration: p.generation, categoryPrerequisiteId: p.prerequisite_id, title: a.title, categoryId: a.category_id, contentRevision: a.content_revision, contentText: selected.text, assignmentRevision: a.assignment_revision, catalogEpoch: epoch.rows[0].revision, articleInputHash: hash, prerequisiteReceipt: receipt, ...(chain && root ? { chainRoot: root, chainConsumer: chain } : {}) }, title: a.title, category: d.label, content: selected.text, generator };
      await client.query('commit');
      return { kind: 'loaded', input };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
}
