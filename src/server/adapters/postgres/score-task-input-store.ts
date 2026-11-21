import type pg from 'pg';
import { DEFAULT_PREFERENCE_HALF_LIFE_DAYS, weight, type VoteValue } from '../../domain/preferences.js';
import type { ScoreContextTask } from '../../application/process-context-chunks.js';
import { copyRequestModel, validateRequestModel, type RequestModel } from '../../application/score-context-request.js';
import { captureScoreHandoff } from './score-handoff.js';

type StoredVote = { value: VoteValue; votedAt: string };
type StoredWeight = { offset: number; votes: StoredVote[] };

export type ScoreTaskModels = { classifier: RequestModel; generator: RequestModel };
export type ScoreTaskInputResult = { kind: 'loaded'; input: ScoreContextTask } | { kind: 'stale_basis' | 'configuration_required' | 'invalid_handoff' };

/** Captures one owned score task; inference must happen after this method returns. */
export class ScoreTaskInputStore {
  constructor(private readonly pool: pg.Pool) {}

  async load(taskId: string, executionToken: string, models: ScoreTaskModels, signal: AbortSignal): Promise<ScoreContextTask | null> {
    const result = await this.loadResult(taskId, executionToken, models, signal);
    return result.kind === 'loaded' ? result.input : null;
  }

  async loadResult(taskId: string, executionToken: string, models: ScoreTaskModels | null, signal: AbortSignal): Promise<ScoreTaskInputResult> {
    const stale = { kind: 'stale_basis' } as const;
    const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    if (!uuid(taskId) || !uuid(executionToken) || !signal || typeof signal.addEventListener !== 'function') return stale;
    // Copy verified capabilities before any await, without invoking tokenizers.
    let capabilities: ScoreTaskModels | null = null;
    try {
      if (models) {
        validateRequestModel(models.classifier); validateRequestModel(models.generator);
        capabilities = { classifier: copyRequestModel(models.classifier), generator: copyRequestModel(models.generator) };
      }
    } catch { /* Invalid capabilities are configuration, not stale ownership. */ }
    const client = await this.pool.connect();
    try {
      await client.query('begin isolation level read committed');
      // Lock in publication order. The final read below uses one fresh statement
      // snapshot after these locks, including votes on other articles and new tasks.
      const epoch = await client.query<{ revision: number }>('select revision from catalog_epoch where id=1 for share');
      if (!epoch.rowCount) { await client.query('rollback'); return stale; }
      const hint = await client.query<{ article_id: string; score_target_id: string | null }>('select article_id, score_target_id from processing_tasks where id=$1', [taskId]);
      if (!hint.rows[0]?.score_target_id) { await client.query('rollback'); return stale; }
      const definition = await client.query<{ id: string; prompt: string; active: boolean; deleted_at: Date | null; include_title: boolean; include_content: boolean; include_category: boolean; include_tag_weights: boolean; include_source_weight: boolean }>('select * from score_definitions where id=$1 for share', [hint.rows[0].score_target_id]);
      const def = definition.rows[0];
      if (!def || !def.active || def.deleted_at) { await client.query('rollback'); return stale; }
      const article = await client.query<{ id: string; title: string | null; category_id: string; source_id: string | null; content_revision: number; assignment_revision: number }>('select id, title, category_id, source_id, content_revision, assignment_revision from articles where id=$1 for update', [hint.rows[0].article_id]);
      const a = article.rows[0];
      if (!a) { await client.query('rollback'); return stale; }
      const task = await client.query<{ id: string; article_id: string; action: string; score_target_id: string | null; state: string; execution_token: string | null; generation: number; prerequisite_id: string | null; result: unknown }>('select id, article_id, action, score_target_id, state, execution_token, generation, prerequisite_id, result from processing_tasks where id=$1 for update', [taskId]);
      const t = task.rows[0];
      if (!t || t.article_id !== a.id || t.action !== 'scores' || t.score_target_id !== def.id || t.state !== 'running' || t.execution_token !== executionToken.toLowerCase()) { await client.query('rollback'); return stale; }
      const handoff = await captureScoreHandoff({ id: t.id, articleId: t.article_id, action: t.action, state: t.state, generation: t.generation, prerequisiteId: t.prerequisite_id, result: t.result }, { id: a.id, title: a.title, sourceId: a.source_id, categoryId: a.category_id, contentRevision: a.content_revision, assignmentRevision: a.assignment_revision }, {
        task: async id => {
          const row = (await client.query<{ id: string; article_id: string; action: string; state: string; generation: number; prerequisite_id: string | null; result: unknown }>('select id,article_id,action,state,generation,prerequisite_id,result from processing_tasks where id=$1 for share', [id])).rows[0];
          return row ? { id: row.id, articleId: row.article_id, action: row.action, state: row.state, generation: row.generation, prerequisiteId: row.prerequisite_id, result: row.result } : null;
        },
        newer: async (articleId, action, generation) => !!(await client.query('select 1 from processing_tasks where article_id=$1 and action=$2 and generation>$3 limit 1', [articleId, action, generation])).rowCount,
        content: async articleId => (await client.query<{ text: string; revision: number }>('select text,revision from article_contents where article_id=$1 for share', [articleId])).rows[0] ?? null,
      });
      if (handoff.kind === 'invalid_handoff' || handoff.kind === 'stale_basis') { await client.query('rollback'); return { kind: handoff.kind }; }
      // One statement snapshot after the article lock is essential: a newer task
      // can be inserted under that lock without updating the article row. A fixed
      // transaction snapshot taken before waiting would miss it.
      const details = await client.query<{ category: string; override_prompt: string | null; content: string | null; content_revision: number | null; half_life: number; as_of: Date; classifier_provider: string | null; classifier_model: string | null; generator_provider: string | null; generator_model: string | null; newer: boolean; tags: (StoredWeight & { label: string })[]; source: StoredWeight | null }>(`select c.label as category, p.prompt as override_prompt, ac.text as content, ac.revision as content_revision,
        coalesce((select preference_half_life_days from app_settings where id=1), $3::float8) as half_life,
        date_trunc('milliseconds', clock_timestamp()) as as_of,
        cr.provider as classifier_provider, cr.model as classifier_model, gr.provider as generator_provider, gr.model as generator_model,
        exists(select 1 from processing_tasks n where n.article_id=$1 and n.action='scores' and n.score_target_id=$2 and n.generation>$5) as newer,
        case when $6::boolean then coalesce((select json_agg(json_build_object('label', t.label, 'offset', t.manual_offset, 'votes',
          coalesce((select json_agg(json_build_object('value', v.value, 'votedAt', v.voted_at) order by v.article_id) from tag_votes v where v.tag_id=t.id), '[]'::json)) order by t.label, t.id)
          from article_tags at join tags t on t.id=at.tag_id where at.article_id=$1), '[]'::json) else '[]'::json end as tags,
        case when $7::boolean then (select json_build_object('offset', s.manual_offset, 'votes',
          coalesce((select json_agg(json_build_object('value', v.value, 'votedAt', v.voted_at) order by v.article_id) from source_votes v where v.source_id=s.id), '[]'::json)) from sources s where s.id=$8) else null end as source
        from categories c left join score_category_prompts p on p.category_id=c.id and p.score_id=$2
        left join article_contents ac on ac.article_id=$1
        left join model_roles cr on cr.role='scores' left join model_roles gr on gr.role='context_reduction'
        where c.id=$4`, [a.id, def.id, DEFAULT_PREFERENCE_HALF_LIFE_DAYS, a.category_id, t.generation, def.include_tag_weights, def.include_source_weight, a.source_id]);
      const d = details.rows[0];
      if (!d || d.newer || (d.content_revision ?? 0) !== a.content_revision ||
          (def.include_source_weight && a.source_id !== null && !d.source)) { await client.query('rollback'); return stale; }
      if (!capabilities || d.classifier_provider !== capabilities.classifier.model.provider || d.classifier_model !== capabilities.classifier.model.model ||
          d.generator_provider !== capabilities.generator.model.provider || d.generator_model !== capabilities.generator.model.model) {
        await client.query('rollback'); return { kind: 'configuration_required' };
      }
      const { classifier, generator } = capabilities;
      const calculate = (item: StoredWeight) => weight(item.offset, item.votes.map(v => ({ value: v.value, votedAt: new Date(v.votedAt) })), d.as_of, d.half_life);
      const tagWeights = d.tags.map(tag => ({ tag: tag.label, weight: calculate(tag) }));
      const sourceWeight = d.source ? calculate(d.source) : null;
      const result: ScoreContextTask = {
        owner: { taskId: t.id, executionToken: t.execution_token, assignmentRevision: a.assignment_revision, catalogEpoch: epoch.rows[0]!.revision, ...(handoff.kind === 'linked' ? { handoff: handoff.value } : {}) },
        scoreId: t.score_target_id!, generation: t.generation, prompt: d.override_prompt ?? def.prompt,
        article: { id: a.id, title: a.title, content: d.content ?? '', contentRevision: a.content_revision, category: d.category, tagWeights, sourceWeight },
        fields: { includeTitle: def.include_title, includeContent: def.include_content, includeCategory: def.include_category, includeTagWeights: def.include_tag_weights, includeSourceWeight: def.include_source_weight },
        classifier, generator, signal,
      };
      await client.query('commit');
      return { kind: 'loaded', input: result };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }
}
