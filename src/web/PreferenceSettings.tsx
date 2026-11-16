import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import { SourcePermissionSettings } from './SourcePermissionSettings';

type Kind = 'tags' | 'sources';
type Item = { id: string; label: string; positive: number; negative: number; weight: number; manualOffset: number };
type Page = { items: Item[]; nextCursor: string | null; asOf: string; halfLifeDays: number };
const json = (method: string, body: object): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const message = (e: unknown) => e instanceof Error ? e.message : 'Request failed';

function useFocusRestore(busy: boolean) {
  const tracking = useRef<{ moved: boolean; stop: () => void } | null>(null);
  const [destination, setDestination] = useState<HTMLElement | null>(null);
  useEffect(() => () => { tracking.current?.stop(); }, []);
  useEffect(() => {
    if (busy || !destination) return;
    const current = tracking.current;
    current?.stop();
    tracking.current = null;
    if (current && !current.moved && document.activeElement === document.body) destination.focus();
    setDestination(null);
  }, [busy, destination]);
  function start(container: HTMLElement | null) {
    tracking.current?.stop();
    tracking.current = null;
    if (!container?.contains(document.activeElement)) return;
    const current = { moved: false, stop: () => document.removeEventListener('focusin', onFocus) };
    function onFocus() { current.moved = true; }
    tracking.current = current;
    document.addEventListener('focusin', onFocus);
  }
  return { start, finish: setDestination };
}

export function PreferenceSettings({ online, onBack }: { online: boolean; onBack: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const saveGeneration = useRef(0);
  const [halfLife, setHalfLife] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const focus = useFocusRestore(busy);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [revision, setRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    let active = true;
    const generation = saveGeneration.current;
    // Odd generations mean a save is in flight; neither its concurrent nor older reads may update the form.
    const current = () => active && generation % 2 === 0 && generation === saveGeneration.current;
    if (online) request<{ halfLifeDays: number }>('/api/v1/settings/preferences').then(result => {
      if (current()) { setHalfLife(String(result.halfLifeDays)); setLoaded(true); setError(''); }
    }).catch(e => { if (current()) { setLoaded(false); setError(message(e)); } });
    return () => { active = false; };
  }, [online, retry]);
  async function save() {
    const value = Number(halfLife);
    if (!online || !navigator.onLine || busy || saveGeneration.current % 2 !== 0) return;
    if (!halfLife.trim() || !Number.isFinite(value) || value <= 0) { setError('Half-life must be greater than zero.'); return; }
    saveGeneration.current++;
    focus.start(form.current);
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await request<{ halfLifeDays: number }>('/api/v1/settings/preferences', json('PATCH', { halfLifeDays: value }));
      setHalfLife(String(result.halfLifeDays)); setRevision(r => r + 1); setStatus('Half-life saved.');
    } catch (e) { setError(message(e)); } finally { saveGeneration.current++; setBusy(false); focus.finish(saveButton.current); }
  }
  return <main className="list catalog-settings">
    <button onClick={onBack}>← Back to reader</button>
    <h1 ref={heading} tabIndex={-1}>Preferences</h1>
    {!online && <p role="status">Offline. Preference changes and browsing are unavailable.</p>}
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    {!loaded && online && <button onClick={() => setRetry(r => r + 1)}>Retry preference settings</button>}
    <form ref={form} onSubmit={e => { e.preventDefault(); void save(); }}>
      <label>Vote half-life (days)<input type="number" min="0" step="any" required value={halfLife} disabled={!online || !loaded || busy} onChange={e => setHalfLife(e.target.value)} /></label>
      <button ref={saveButton} disabled={!online || !loaded || busy}>Save half-life</button>
    </form>
    <PreferenceList kind="tags" online={online} revision={revision} />
    <PreferenceList kind="sources" online={online} revision={revision} />
    <SourcePermissionSettings online={online} />
  </main>;
}

function PreferenceList({ kind, online, revision }: { kind: Kind; online: boolean; revision: number }) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name');
  const [direction, setDirection] = useState('asc');
  const [cursors, setCursors] = useState<string[]>([]);
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const focus = useFocusRestore(busy);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [target, setTarget] = useState('');
  const mergeFieldset = useRef<HTMLFieldSetElement>(null);
  const mergeButton = useRef<HTMLButtonElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (lastRevision.current !== revision) { lastRevision.current = revision; setCursors([]); return; }
    if (!online) return;
    let active = true;
    setLoading(true); setError('');
    const params = new URLSearchParams({ query, sort, direction, limit: '50' });
    if (cursors.length) params.set('cursor', cursors[cursors.length - 1]!);
    request<Page>(`/api/v1/preferences/${kind}?${params}`).then(result => { if (active) setPage(result); }).catch(e => { if (active) { setPage(null); setError(message(e)); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [kind, online, query, sort, direction, cursors, refresh, revision]);
  function reload() { setCursors([]); setRefresh(r => r + 1); }
  async function offset(id: string, value: number) {
    if (!online || !navigator.onLine || busy || !Number.isFinite(value)) return false;
    setBusy(true); setError(''); setStatus('');
    try { await request(`/api/v1/${kind}/${encodeURIComponent(id)}/preference`, json('PATCH', { manualOffset: value })); reload(); setStatus('Manual offset saved.'); return true; }
    catch (e) { setError(message(e)); return false; } finally { setBusy(false); }
  }
  async function merge() {
    const sourceIds = Object.keys(selected).filter(id => id !== target);
    if (!online || !navigator.onLine || busy || !target || !sourceIds.length || sourceIds.length > 100) return;
    if (!window.confirm(`Merge ${sourceIds.length} source tag(s) into ${selected[target]}? Source tags will be deleted.`)) return;
    focus.start(mergeFieldset.current);
    setBusy(true); setError(''); setStatus('');
    let succeeded = false;
    try { await request('/api/v1/tags/merge', json('POST', { targetId: target, sourceIds })); setSelected({}); setTarget(''); reload(); setStatus('Tags merged.'); succeeded = true; }
    catch (e) { setError(message(e)); } finally { setBusy(false); focus.finish(succeeded ? listHeading.current : mergeButton.current); }
  }
  const title = kind === 'tags' ? 'Tag' : 'Source';
  return <section aria-labelledby={`${kind}-preferences-heading`}>
    <h2 ref={listHeading} id={`${kind}-preferences-heading`} tabIndex={-1}>{title} preferences</h2>
    {error && <p role="alert">{error} <button disabled={!online || busy} onClick={reload}>Retry from first page</button></p>}
    {status && <p role="status">{status}</p>}
    <form onSubmit={e => { e.preventDefault(); setCursors([]); setQuery(draft); }}>
      <label>Search {kind}<input maxLength={200} value={draft} onChange={e => setDraft(e.target.value)} /></label>
      <button disabled={!online || busy}>Search</button>
    </form>
    <label>Sort {kind}<select value={sort} disabled={!online || busy} onChange={e => { setCursors([]); setSort(e.target.value); }}><option value="name">Name</option><option value="weight">Weight</option><option value="positive">Positive votes</option><option value="negative">Negative votes</option></select></label>
    <label>Order {kind}<select value={direction} disabled={!online || busy} onChange={e => { setCursors([]); setDirection(e.target.value); }}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
    {loading && online && <p role="status">Loading {kind}…</p>}
    {page && <><p>Weights as of {page.asOf}; half-life {page.halfLifeDays} days. Weight includes manual offset and decayed votes.</p>
      {!page.items.length && <p>No {kind} match.</p>}
      <ul>{page.items.map(item => <li key={item.id}>
        <strong>{item.label}</strong> — Positive votes: {item.positive}; Negative votes: {item.negative}; Decayed weight: {item.weight}
        <OffsetForm item={item} disabled={!online || busy || loading} save={value => offset(item.id, value)} />
        {kind === 'tags' && <label><input type="checkbox" disabled={!online || busy || loading || (!selected[item.id] && Object.keys(selected).length >= 101)} checked={item.id in selected} onChange={e => { const checked = e.target.checked; setSelected(previous => { const next = { ...previous }; if (checked) next[item.id] = item.label; else delete next[item.id]; return next; }); if (!checked && target === item.id) setTarget(''); }} />Select {item.label} for merge</label>}
      </li>)}</ul>
    </>}
    <nav className="pagination" aria-label={`${title} preference pages`}><button disabled={!online || loading || busy || !cursors.length} onClick={() => setCursors(c => c.slice(0, -1))}>Previous</button><span>Page {cursors.length + 1}</span><button disabled={!online || loading || busy || !page?.nextCursor} onClick={() => { if (page?.nextCursor) setCursors(c => [...c, page.nextCursor!]); }}>Next</button></nav>
    {kind === 'tags' && <fieldset ref={mergeFieldset} disabled={!online || busy}><legend>Merge selected tags</legend>
      <p>Select tags across pages, then choose the target. Source tags are deleted; archived tags cannot be merged.</p>
      {Object.entries(selected).map(([id, label]) => <div key={id}><label><input type="radio" name="merge-target" checked={target === id} onChange={() => setTarget(id)} />Target: {label}</label> <button type="button" onClick={() => { setSelected(previous => { const next = { ...previous }; delete next[id]; return next; }); if (target === id) setTarget(''); }}>Remove {label} from merge</button></div>)}
      <button ref={mergeButton} type="button" disabled={!target || Object.keys(selected).length < 2} onClick={() => void merge()}>Merge tags</button>
    </fieldset>}
  </section>;
}

function OffsetForm({ item, disabled, save }: { item: Item; disabled: boolean; save: (value: number) => Promise<boolean> }) {
  const [draft, setDraft] = useState(String(item.manualOffset));
  const [restoreFocus, setRestoreFocus] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(String(item.manualOffset)); }, [item.manualOffset]);
  useEffect(() => { if (restoreFocus && !disabled) { if (document.activeElement === document.body) input.current?.focus(); setRestoreFocus(false); } }, [restoreFocus, disabled]);
  return <form onSubmit={e => { e.preventDefault(); if (draft.trim() && Number.isFinite(Number(draft))) void save(Number(draft)).then(() => setRestoreFocus(true)); }}>
    <label>Manual offset for {item.label}<input ref={input} type="number" step="any" required value={draft} disabled={disabled} onChange={e => setDraft(e.target.value)} /></label>
    <button disabled={disabled}>Save offset for {item.label}</button>
  </form>;
}
