import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScoreDefinitionInput } from '../shared/scores';
import { fallbackCategoryId } from '../shared/taxonomy';
import { request } from './api';

type Score = ScoreDefinitionInput & { id: string; deletedAt: string | null };
const empty: ScoreDefinitionInput = { name: '', description: '', prompt: '', active: true, includeTitle: true, includeContent: true, includeCategory: true, includeTagWeights: false, includeSourceWeight: false };
const flags = [['active', 'Active'], ['includeTitle', 'Include title'], ['includeContent', 'Include content'], ['includeCategory', 'Include category'], ['includeTagWeights', 'Include tag weights'], ['includeSourceWeight', 'Include source weight']] as const;

type Category = { id: string; label: string; archivedAt: string | null };

export function ScoreSettings({ online, categories }: { online: boolean; categories: Category[] }) {
  const [items, setItems] = useState<Score[]>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [focusTarget, setFocusTarget] = useState<{ key: string } | null>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const sequence = useRef(0);
  useEffect(() => {
    if (focusTarget && !busy && document.activeElement === document.body) {
      (controls.current.get(focusTarget.key) ?? controls.current.get('create'))?.focus();
    }
  }, [busy, focusTarget]);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    const result = await request<{ items: Score[] }>('/api/v1/scores');
    if (current === sequence.current) setItems(result.items);
  }, []);
  useEffect(() => { if (online) void load().catch(e => setError(e instanceof Error ? e.message : 'Could not load scores')); return () => { sequence.current++; }; }, [online, load]);
  async function save(id: string | null, body?: ScoreDefinitionInput) {
    if (!online || !navigator.onLine || busy) return false;
    setBusy(true); setError(''); setStatus('');
    let succeeded = false;
    try {
      await request(`/api/v1/scores${id ? `/${encodeURIComponent(id)}` : ''}`, { method: body ? id ? 'PATCH' : 'POST' : 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
      await load(); setStatus(body ? 'Score saved.' : 'Score deleted.'); succeeded = true; return true;
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save score'); return false; }
    finally {
      setFocusTarget({ key: !id || (!body && succeeded) ? 'create' : `${body ? 'save' : 'delete'}:${id}` });
      setBusy(false);
    }
  }
  return <section aria-labelledby="scores-heading">
    <h2 id="scores-heading">Score definitions</h2>
    <p>Explicit reevaluation is available in article detail; model execution remains unavailable without authorized configuration. The fallback category uses the global prompt.</p>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    <ScoreForm key="new" initial={empty} title="New score" disabled={!online || busy} save={body => save(null, body)} register={(action, node) => { if (node) controls.current.set(action, node); else controls.current.delete(action); }} />
    {items.map(item => item.deletedAt ? <p key={item.id}>{item.name} (deleted)</p> : <div key={item.id}>
      <ScoreForm key={JSON.stringify(item)} initial={item} title={item.name} disabled={!online || busy} save={body => save(item.id, body)} remove={() => save(item.id)} register={(action, node) => { const key = `${action}:${item.id}`; if (node) controls.current.set(key, node); else controls.current.delete(key); }} />
      <CategoryPrompts score={item} categories={categories.filter(category => !category.archivedAt && category.id !== fallbackCategoryId)} online={online} disabled={busy} />
    </div>)}
  </section>;
}
function CategoryPrompts({ score, categories, online, disabled }: { score: Score; categories: Category[]; online: boolean; disabled: boolean }) {
  const [items, setItems] = useState<{ categoryId: string; prompt: string }[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [restoreFocus, setRestoreFocus] = useState(false);
  const sequence = useRef(0);
  const action = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (restoreFocus && !busy) { if (document.activeElement === document.body) action.current?.focus(); setRestoreFocus(false); } }, [busy, restoreFocus]);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    const result = await request<{ items: { categoryId: string; prompt: string }[] }>(`/api/v1/scores/${encodeURIComponent(score.id)}/category-prompts`);
    if (current === sequence.current) { setItems(result.items); setLoaded(true); }
  }, [score.id]);
  useEffect(() => { setLoaded(false); if (online) void load().catch(e => setError(e instanceof Error ? e.message : 'Could not load overrides')); return () => { sequence.current++; }; }, [online, load]);
  async function change(remove: boolean) {
    if (!online || !navigator.onLine || busy || disabled || !categoryId) return;
    setBusy(true); setError(''); setStatus('');
    try {
      await request(`/api/v1/scores/${encodeURIComponent(score.id)}/category-prompts/${encodeURIComponent(categoryId)}`, { method: remove ? 'DELETE' : 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(remove ? {} : { prompt: draft }) });
      await load(); if (remove) setDraft(''); setStatus(remove ? 'Override removed.' : 'Override saved.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save override'); }
    finally { setRestoreFocus(true); setBusy(false); }
  }
  const selected = items.find(item => item.categoryId === categoryId);
  return <form onSubmit={e => { e.preventDefault(); void change(false); }}>
    <fieldset disabled={!online || disabled || busy || !loaded}><legend>Category prompt overrides for {score.name}</legend>
      {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
      <label>Category<select value={categoryId} onChange={e => { const id = e.target.value; setCategoryId(id); setDraft(items.find(item => item.categoryId === id)?.prompt ?? ''); }}><option value="">Select category</option>{categories.map(category => <option key={category.id} value={category.id}>{category.label}{items.some(item => item.categoryId === category.id) ? ' (override)' : ''}</option>)}</select></label>
      <label>Category prompt<textarea required maxLength={10000} value={draft} onChange={e => setDraft(e.target.value)} /></label>
      <button ref={action} type="submit" disabled={!categoryId}>Save override</button>
      <button type="button" disabled={!categoryId || !selected} onClick={() => void change(true)}>Remove override</button>
    </fieldset>
  </form>;
}
function ScoreForm({ initial, title, disabled, save, remove, register }: { initial: ScoreDefinitionInput; title: string; disabled: boolean; save: (value: ScoreDefinitionInput) => Promise<boolean>; remove?: () => Promise<boolean>; register: (action: string, node: HTMLButtonElement | null) => void }) {
  const [draft, setDraft] = useState<ScoreDefinitionInput>(() => ({ name: initial.name, description: initial.description, prompt: initial.prompt, active: initial.active, includeTitle: initial.includeTitle, includeContent: initial.includeContent, includeCategory: initial.includeCategory, includeTagWeights: initial.includeTagWeights, includeSourceWeight: initial.includeSourceWeight }));
  return <form onSubmit={e => { e.preventDefault(); void save(draft).then(ok => { if (ok && !remove) setDraft(empty); }); }}>
    <fieldset disabled={disabled}><legend>{title}</legend>
      <label>Name<input required maxLength={200} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label>Description<textarea required maxLength={2000} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
      <label>Prompt<textarea required maxLength={10000} value={draft.prompt} onChange={e => setDraft({ ...draft, prompt: e.target.value })} /></label>
      {flags.map(([key, label]) => <label key={key}><input type="checkbox" checked={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.checked })} />{label}</label>)}
      <button ref={node => register(remove ? 'save' : 'create', node)} type="submit">{remove ? 'Save score' : 'Create score'}</button>
      {remove && <button ref={node => register('delete', node)} type="button" onClick={() => void remove()}>Delete score</button>}
    </fieldset>
  </form>;
}
