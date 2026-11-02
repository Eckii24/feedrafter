import { useCallback, useEffect, useRef, useState } from 'react';
import { fallbackCategoryId } from '../shared/taxonomy';
import { request } from './api';
import { ScoreSettings } from './ScoreSettings';

type Kind = 'categories' | 'tags';
type Item = { id: string; label: string; archivedAt: string | null };

export function CatalogSettings({ online, onBack }: { online: boolean; onBack: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const [items, setItems] = useState<Record<Kind, Item[]>>({ categories: [], tags: [] });
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const [focusRow, setFocusRow] = useState<string | null>(null);
  useEffect(() => { if (focusRow) { inputs.current.get(focusRow)?.focus(); setFocusRow(null); } }, [focusRow, items]);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const [categories, tags] = await Promise.all([request<{ items: Item[] }>('/api/v1/categories'), request<{ items: Item[] }>('/api/v1/tags')]);
      if (current === sequence.current) setItems({ categories: categories.items, tags: tags.items });
    } catch (e) { if (current === sequence.current) throw e; }
  }, []);
  useEffect(() => {
    if (online) void load().catch(e => setError(e instanceof Error ? e.message : 'Could not load catalog'));
    return () => { sequence.current++; };
  }, [load, online]);
  async function save(kind: Kind, id: string | null, body: object) {
    if (!online || !navigator.onLine || busy) return false;
    setBusy(true); setError(''); setStatus('');
    try {
      await request(`/api/v1/${kind}${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      await load(); if (id) setFocusRow(`${kind}:${id}`); setStatus('Catalog saved.'); return true;
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save catalog'); if (id) setFocusRow(`${kind}:${id}`); return false; }
    finally { setBusy(false); }
  }
  return <main className="list catalog-settings">
    <button onClick={onBack}>← Back to reader</button>
    <h1 ref={heading} tabIndex={-1}>Catalog settings</h1>
    {!online && <p role="status">Offline. Catalog changes are unavailable.</p>}
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    {(['categories', 'tags'] as const).map(kind => <section key={kind} aria-labelledby={`${kind}-heading`}>
      <h2 id={`${kind}-heading`}>{kind === 'categories' ? 'Categories' : 'Tags'}</h2>
      <CreateForm kind={kind} disabled={!online || busy} save={save} />
      <ul>{items[kind].map(item => <li key={item.id}>
        <RenameForm key={`${item.id}-${item.label}`} kind={kind} item={item} disabled={!online || busy} save={save} inputRef={node => { const key = `${kind}:${item.id}`; if (node) inputs.current.set(key, node); else inputs.current.delete(key); }} />
        {item.id === fallbackCategoryId && kind === 'categories' ? <span> Fallback category (protected)</span> : item.archivedAt ? <span> Archived</span> : <button disabled={!online || busy} onClick={() => void save(kind, item.id, { archived: true })}>Archive {item.label}</button>}
      </li>)}</ul>
    </section>)}
    <ScoreSettings online={online} categories={items.categories} />
  </main>;
}

type Save = (kind: Kind, id: string | null, body: object) => Promise<boolean>;
function CreateForm({ kind, disabled, save }: { kind: Kind; disabled: boolean; save: Save }) {
  const [label, setLabel] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const name = kind === 'categories' ? 'category' : 'tag';
  return <form onSubmit={e => { e.preventDefault(); void save(kind, null, { label }).then(ok => { if (ok) setLabel(''); input.current?.focus(); }); }}>
    <label>New {name}<input ref={input} required maxLength={200} value={label} onChange={e => setLabel(e.target.value)} /></label>
    <button disabled={disabled}>Create {name}</button>
  </form>;
}
function RenameForm({ kind, item, disabled, save, inputRef }: { kind: Kind; item: Item; disabled: boolean; save: Save; inputRef: (node: HTMLInputElement | null) => void }) {
  const [label, setLabel] = useState(item.label);
  return <form onSubmit={e => { e.preventDefault(); void save(kind, item.id, { label }); }}>
    <label>Rename {item.label}<input ref={inputRef} required maxLength={200} value={label} onChange={e => setLabel(e.target.value)} /></label>
    <button disabled={disabled || label === item.label}>Save {item.label}</button>
  </form>;
}
