import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './api';

type Item = { id: string; label: string; archivedAt: string | null };
type State = { category: Item; tags: Item[]; assignmentRevision: number };

export function ArticleCatalog({ articleId, online, refresh, onChanged }: { articleId: string; online: boolean; refresh: number; onChanged: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [categories, setCategories] = useState<Item[]>([]);
  const [tags, setTags] = useState<Item[]>([]);
  const [categoryDraft, setCategoryDraft] = useState<{ id: string; label: string } | null>(null);
  const [tagDraft, setTagDraft] = useState<{ id: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const seq = useRef(0);
  const categorySelect = useRef<HTMLSelectElement>(null);
  const addSelect = useRef<HTMLSelectElement>(null);
  const restoreFocus = useRef<'category' | 'tag' | null>(null);
  useEffect(() => {
    if (!busy && restoreFocus.current) {
      const target = restoreFocus.current;
      restoreFocus.current = null;
      if (online && document.activeElement === document.body) (target === 'category' ? categorySelect : addSelect).current?.focus();
    }
  }, [busy, online]);
  const load = useCallback(async () => {
    const current = ++seq.current;
    try {
      const [catalog, availableCategories, availableTags] = await Promise.all([
        request<State>(`/api/v1/articles/${articleId}/catalog`),
        request<{ items: Item[] }>('/api/v1/categories'), request<{ items: Item[] }>('/api/v1/tags'),
      ]);
      if (current === seq.current) { setState(catalog); setCategories(availableCategories.items); setTags(availableTags.items); setError(''); }
    } catch (e) { if (current === seq.current) throw e; }
  }, [articleId]);
  useEffect(() => {
    if (online) void load().catch(() => setError('Could not load article catalog.'));
    return () => { seq.current++; };
  }, [load, online, refresh]);
  async function change(path: string, method: 'PATCH' | 'PUT' | 'DELETE', body: object) {
    if (!online || !navigator.onLine || busy) return;
    setBusy(true); setError(''); setStatus('');
    try {
      await request(`/api/v1/articles/${articleId}/${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      setCategoryDraft(null); setTagDraft(null);
      await load(); onChanged(); setStatus('Article catalog saved.');
    } catch { try { await load(); } catch { /* keep the error visible */ } setError('Could not confirm catalog change. Reload to check.'); }
    finally { restoreFocus.current = path === 'category' ? 'category' : 'tag'; setBusy(false); }
  }
  const available = tags.filter(tag => !tag.archivedAt && !state?.tags.some(item => item.id === tag.id));
  const activeCategories = categories.filter(item => !item.archivedAt);
  const categoryId = categoryDraft?.id ?? state?.category.id ?? '';
  const tagId = tagDraft?.id ?? '';
  const categoryUnavailable = categoryDraft && categoryDraft.id !== state?.category.id && !activeCategories.some(item => item.id === categoryDraft.id);
  const tagUnavailable = tagDraft && !available.some(item => item.id === tagDraft.id);
  return <section className="article-catalog" aria-label="Article catalog">
    <h3>Category and tags</h3>
    {!online && <p role="status">Offline. Catalog changes are unavailable.</p>}
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    {!state ? <p>Catalog unavailable.</p> : <>
      <form onSubmit={e => { e.preventDefault(); void change('category', 'PATCH', { categoryId }); }}>
        <label>Category<select ref={categorySelect} value={categoryId} disabled={!online || busy} onChange={e => setCategoryDraft(e.target.value === state.category.id ? null : { id: e.target.value, label: e.target.selectedOptions[0].text })}>
          {state.category.archivedAt && <option value={state.category.id} disabled>{state.category.label} (archived)</option>}
          {categoryUnavailable && <option value={categoryDraft.id} disabled>{categoryDraft.label} (unavailable)</option>}
          {activeCategories.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label><button disabled={!online || busy || !!categoryUnavailable || categoryId === state.category.id}>Save category</button>
      </form>
      <ul>{state.tags.map(tag => <li key={tag.id}>{tag.label}{tag.archivedAt && ' (archived)'} <button disabled={!online || busy} onClick={() => void change(`tags/${tag.id}`, 'DELETE', {})}>Remove {tag.label}</button></li>)}</ul>
      <form onSubmit={e => { e.preventDefault(); if (tagId) void change(`tags/${tagId}`, 'PUT', {}); }}>
        <label>Add tag<select ref={addSelect} value={tagId} disabled={!online || busy} onChange={e => setTagDraft(e.target.value ? { id: e.target.value, label: e.target.selectedOptions[0].text } : null)}><option value="">Choose a tag</option>{tagUnavailable && <option value={tagDraft.id} disabled>{tagDraft.label} (unavailable)</option>}{available.map(tag => <option key={tag.id} value={tag.id}>{tag.label}</option>)}</select></label>
        <button disabled={!online || busy || !tagId || !!tagUnavailable}>Add tag</button>
      </form>
    </>}
  </section>;
}
