import { useCallback, useEffect, useRef, useState } from 'react';
import { HttpError, request, safeLink, type Article, type Page, type Run } from './api';
import { FeedbackPicker } from './FeedbackPicker';
import { CatalogSettings } from './CatalogSettings';
import { ArticleCatalog } from './ArticleCatalog';

type Filters = { read: string; kind: string; source: string; title: string; sort: string; direction: string; scoreId: string };
type ScoreOption = { id: string; name: string; active: boolean; deletedAt: string | null };
const defaults: Filters = { read: 'unread', kind: '', source: '', title: '', sort: 'date', direction: 'desc', scoreId: '' };
const json = (body: object): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function message(error: unknown) { return error instanceof Error ? error.message : 'Request failed'; }
function date(value: string | null) { return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleDateString() : 'Date unknown'; }

export default function App() {
  const [settings, setSettings] = useState(false);
  const [scores, setScores] = useState<ScoreOption[]>([]);
  const [scoresUnavailable, setScoresUnavailable] = useState(false);
  const [draft, setDraft] = useState(defaults);
  const [filters, setFilters] = useState(defaults);
  const [cursors, setCursors] = useState<string[]>([]);
  const [page, setPage] = useState<Page | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Article | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [error, setError] = useState('');
  const [listStatus, setListStatus] = useState('');
  const [mailError, setMailError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [catalogChanges, setCatalogChanges] = useState(0);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const listSequence = useRef(0);
  const scoresSequence = useRef(0);
  const detailSequence = useRef(0);
  const backRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const invalidate = useCallback(() => { setCursors([]); setRefresh(n => n + 1); }, []);

  useEffect(() => {
    if (selected && window.matchMedia('(max-width: 700px)').matches) backRef.current?.focus();
  }, [selected]);
  useEffect(() => {
    const on = () => { setOnline(true); invalidate(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, [invalidate]);
  useEffect(() => {
    const events = new EventSource('/api/v1/events');
    events.onopen = invalidate;
    events.onmessage = invalidate;
    return () => events.close();
  }, [invalidate]);
  useEffect(() => {
    if (!online || settings) return;
    let current = true;
    const seq = ++scoresSequence.current;
    request<{ items: ScoreOption[] }>('/api/v1/scores').then(result => {
      if (!current || seq !== scoresSequence.current) return;
      const active = result.items.filter(score => score.active && !score.deletedAt);
      setScores(active); setScoresUnavailable(false);
      const available = (id: string) => active.some(score => score.id === id);
      setDraft(value => value.sort === 'score' && value.scoreId && !available(value.scoreId) ? { ...value, sort: 'date', scoreId: '' } : value);
      setFilters(value => value.sort === 'score' && !available(value.scoreId) ? { ...value, sort: 'date', scoreId: '' } : value);
      setCursors([]);
    }).catch(() => { if (current && seq === scoresSequence.current) { setScores([]); setScoresUnavailable(true); } });
    return () => { current = false; };
  }, [online, settings]);
  useEffect(() => {
    if (!online) return;
    const seq = ++listSequence.current;
    const query = new URLSearchParams({ read: filters.read, sort: filters.sort, direction: filters.direction, limit: '30' });
    if (filters.kind) query.set('kind', filters.kind);
    if (filters.source) query.set('source', filters.source);
    if (filters.title) query.set('title', filters.title);
    if (filters.sort === 'score') query.set('scoreId', filters.scoreId);
    if (cursors.length) query.set('cursor', cursors[cursors.length - 1]);
    setLoading(true);
    request<Page>(`/api/v1/articles?${query}`).then(result => { if (seq === listSequence.current) { setPage(result); setError(''); } }).catch(async e => {
      if (seq !== listSequence.current) return;
      if (!(e instanceof HttpError) || e.status !== 400 || filters.sort !== 'score') { setError(message(e)); return; }
      setPage(null);
      const scoreSeq = ++scoresSequence.current;
      try {
        const result = await request<{ items: ScoreOption[] }>('/api/v1/scores');
        if (seq !== listSequence.current || scoreSeq !== scoresSequence.current) return;
        const active = result.items.filter(score => score.active && !score.deletedAt);
        setScores(active); setScoresUnavailable(false);
        if (!active.some(score => score.id === filters.scoreId)) {
          setDraft(value => value.sort === 'score' && value.scoreId === filters.scoreId ? { ...value, sort: 'date', scoreId: '' } : value);
          setFilters(value => ({ ...value, sort: 'date', scoreId: '' }));
          setCursors([]); setError(''); setListStatus('Selected score is no longer active. Showing articles sorted by date.');
        } else if (cursors.length) {
          setCursors([]); setError(''); setListStatus('The score page expired. Showing the first page.');
        } else {
          setListStatus(''); setError(`Could not load score-sorted articles: ${message(e)}`);
        }
      } catch (catalogError) {
        if (seq !== listSequence.current || scoreSeq !== scoresSequence.current) return;
        setScoresUnavailable(true); setListStatus('');
        setError(`Could not refresh scores after the article request failed: ${message(catalogError)}`);
      }
    }).finally(() => { if (seq === listSequence.current) setLoading(false); });
    return () => { listSequence.current++; };
  }, [filters, cursors, refresh, online]);
  useEffect(() => {
    if (!selected || !online) return;
    const seq = ++detailSequence.current;
    request<Article>(`/api/v1/articles/${encodeURIComponent(selected)}`).then(result => { if (seq === detailSequence.current) setDetail(result); }).catch(e => { if (seq === detailSequence.current) setError(message(e)); });
    return () => { detailSequence.current++; };
  }, [selected, refresh, online]);
  useEffect(() => {
    if (!runId || !online) return;
    let active = true;
    const update = () => request<Run>(`/api/v1/pipeline/runs/${encodeURIComponent(runId)}`).then(result => { if (active) setRun(result); }).catch(e => { if (active) setError(message(e)); });
    void update(); const timer = window.setInterval(update, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [runId, refresh, online]);
  async function changeRead() {
    if (!detail || !online || !navigator.onLine || busy) return;
    setBusy(true); setError('');
    try {
      const result = await request<Article>(`/api/v1/articles/${encodeURIComponent(detail.id)}`, { ...json({ isRead: !detail.isRead }), method: 'PATCH' });
      if (selectedRef.current === result.id) setDetail(result);
      invalidate();
    } catch (e) { setError(`Could not confirm read state; refresh to check: ${message(e)}`); }
    finally { setBusy(false); }
  }
  async function changeMailSelection() {
    if (!detail || detail.mailState === 'sent' || !online || !navigator.onLine || busy) return;
    setBusy(true); setError('');
    try {
      const result = await request<Article>(`/api/v1/articles/${encodeURIComponent(detail.id)}/mail-selection`, { ...json({ selected: detail.mailState !== 'selected' }), method: 'PUT' });
      if (selectedRef.current === result.id) setDetail(result);
      setMailError('');
      invalidate();
    } catch (e) { setMailError(`Could not confirm mail selection; refresh to check: ${message(e)}`); invalidate(); }
    finally { setBusy(false); }
  }
  async function startImport() {
    if (!online || !navigator.onLine || busy) return;
    setBusy(true); setError('');
    try { const result = await request<{ runId: string }>('/api/v1/pipeline/runs', json({})); setRun(null); setRunId(result.runId); }
    catch (e) { setError(`Could not confirm import start: ${message(e)}`); }
    finally { setBusy(false); }
  }
  const link = safeLink(detail?.url ?? null);
  if (settings) return <CatalogSettings online={online} onBack={() => { setSettings(false); requestAnimationFrame(() => settingsRef.current?.focus()); }} />;
  return <>
    <header className="top"><div><h1>Feedrafter</h1><p>Your reader</p></div><button ref={settingsRef} onClick={() => setSettings(true)}>Catalog settings</button><button disabled={!online || busy} onClick={() => void startImport()}>Import now</button></header>
    {!online && <div className="notice" role="status">Offline. Previously displayed articles remain visible; changes and imports are unavailable.</div>}
    {error && <div className="error" role="alert">{error}</div>}
    {listStatus && <div className="notice" role="status">{listStatus}</div>}
    {mailError && <div className="error" role="alert">{mailError}</div>}
    {runId && <section className="run" aria-live="polite"><strong>Import</strong> {run ? <>{run.status} · {run.phase} · fetched {run.fetchedCount}, confirmed {run.confirmedCount}, pending {run.pendingCount}{run.errorCode && <> · Error: {run.errorCode}</>}</> : 'Loading progress…'}</section>}
    <main className={`layout ${selected ? 'show-detail' : ''}`}>
      <section className="list" aria-label="Articles">
        <form className="filters" onSubmit={e => { e.preventDefault(); setListStatus(''); setCursors([]); setPage(null); setFilters({ ...draft, source: draft.source.trim(), title: draft.title.trim() }); }}>
          <label>Title search<input maxLength={200} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
          <label>Source ID<input value={draft.source} placeholder="UUID (optional)" pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" onChange={e => setDraft({ ...draft, source: e.target.value })} /></label>
          <label>Status<select value={draft.read} onChange={e => setDraft({ ...draft, read: e.target.value })}><option value="unread">Unread</option><option value="read">Read</option><option value="all">All</option></select></label>
          <label>Kind<select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value })}><option value="">All kinds</option><option value="article">Article</option><option value="video">Video</option></select></label>
          <label>Sort by<select value={draft.sort} onChange={e => setDraft({ ...draft, sort: e.target.value })}><option value="date">Date</option><option value="title">Title</option><option value="score">Score</option></select></label>
          {draft.sort === 'score' && <label>Score<select required value={draft.scoreId} onChange={e => setDraft({ ...draft, scoreId: e.target.value })}><option value="">Select an active score</option>{scores.map(score => <option key={score.id} value={score.id}>{score.name}</option>)}</select>{scoresUnavailable && <span>Scores unavailable. Reopen the reader or reconnect to retry.</span>}</label>}
          <label>Order<select value={draft.direction} onChange={e => setDraft({ ...draft, direction: e.target.value })}><option value="desc">Descending</option><option value="asc">Ascending</option></select></label>
          <button type="submit" disabled={!online}>Apply filters</button>
        </form>
        <div className="list-heading"><h2>Articles</h2>{loading && <span role="status">Loading…</span>}</div>
        {page && page.items.length === 0 && <p>No articles match.</p>}
        <ul className="articles">{page?.items.map(item => <li key={item.id}><button id={`article-${item.id}`} className={selected === item.id ? 'article selected' : 'article'} aria-current={selected === item.id ? 'true' : undefined} onClick={() => { setDetail(null); setSelected(item.id); }}><strong>{item.title || 'Untitled'}</strong><span>{item.kind} · {date(item.publishedAt || item.importedAt)} · {item.isRead ? 'Read' : 'Unread'}</span><small>Source: {item.sourceId || 'Unknown'}</small>{filters.sort === 'score' && <small>Score: {item.scoreValue == null ? 'Not scored' : item.scoreValue}</small>}</button></li>)}</ul>
        <nav className="pagination" aria-label="Article pages"><button disabled={!online || loading || cursors.length === 0} onClick={() => setCursors(c => c.slice(0, -1))}>Previous</button><span>Page {cursors.length + 1}</span><button disabled={!online || loading || !page?.nextCursor} onClick={() => { if (page?.nextCursor) setCursors(c => [...c, page.nextCursor!]); }}>Next</button></nav>
      </section>
      <section className="detail" aria-label="Article detail"><button ref={backRef} className="back" onClick={() => { const previous = selected; setSelected(null); setDetail(null); requestAnimationFrame(() => document.getElementById(`article-${previous}`)?.focus()); }}>← Back to articles</button>{!selected ? <p>Select an article to read its details.</p> : !detail ? <p role="status">Loading article…</p> : <article><p className="eyebrow">{detail.kind} · {detail.isRead ? 'Read' : 'Unread'}</p><h2>{detail.title || 'Untitled'}</h2><p>{detail.author && <>{detail.author} · </>}{date(detail.publishedAt || detail.importedAt)}</p><p>Source: {detail.sourceId || 'Unknown'}</p><div className="actions"><button disabled={!online || busy} onClick={() => void changeRead()}>Mark {detail.isRead ? 'unread' : 'read'}</button>{detail.mailState === 'sent' ? <span>Mail sent</span> : <button disabled={!online || busy} onClick={() => void changeMailSelection()}>{detail.mailState === 'selected' ? 'Remove from mail queue' : 'Select for mail'}</button>}{link && <a href={link} target="_blank" rel="noopener noreferrer">Open original ↗</a>}</div><ArticleCatalog key={detail.id} articleId={detail.id} online={online} refresh={refresh} onChanged={() => setCatalogChanges(n => n + 1)} /><FeedbackPicker key={`${detail.id}:${catalogChanges}`} articleId={detail.id} online={online} /><p className="muted">Preparation unavailable. Article content is available at the original link when provided.</p></article>}</section>
    </main>
  </>;
}
