import { useEffect, useRef, useState } from 'react';
import { request } from './api';

type Choice = 'inherit' | 'allow' | 'deny';
type Permissions = {
  sources: { id: string; contextId: string; externalFeedId: string; title: string | null; override: boolean | null }[];
  hostRules: { host: string; allowed: boolean }[];
};
const choice = (value: boolean | null): Choice => value === null ? 'inherit' : value ? 'allow' : 'deny';
const json = (method: string, body: object): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const message = (e: unknown) => e instanceof Error ? e.message : 'Request failed';

export function SourcePermissionSettings({ online }: { online: boolean }) {
  const [data, setData] = useState<Permissions | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Choice>>({});
  const [host, setHost] = useState('');
  const [hostChoice, setHostChoice] = useState<'allow' | 'deny'>('allow');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const generation = useRef(0);
  const writing = useRef(false);
  const savedSource = useRef<string | null>(null);

  async function load() {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await request<Permissions>('/api/v1/settings/source-permissions');
      if (current !== generation.current) return;
      setData(result); setStale(false); setError('');
      if (savedSource.current !== null) {
        const id = savedSource.current;
        setDrafts(previous => { const next = { ...previous }; delete next[id]; return next; });
        savedSource.current = null;
      }
    } catch (e) {
      if (current === generation.current) { setStale(true); setError(`Could not refresh source permissions: ${message(e)}`); }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    if (online && navigator.onLine && !writing.current) void load();
  }, [online]);

  async function save(url: string, method: string, body: object, sourceId?: string) {
    if (!online || !navigator.onLine || writing.current || loading || stale) return;
    writing.current = true;
    generation.current++;
    setBusy(true); setError(''); setStatus('');
    try {
      await request(url, json(method, body));
      if (sourceId) savedSource.current = sourceId;
      setStatus('Permission saved. Refreshing from server…');
      await load();
      setStatus('Permission saved.');
    } catch (e) {
      setStale(true);
      setError(`Save failed or could not be confirmed: ${message(e)}. Your selection is retained; refresh before retrying.`);
    } finally { writing.current = false; setBusy(false); }
  }
  const disabled = !online || !navigator.onLine || busy || loading || stale;
  return <section aria-labelledby="source-permissions-heading">
    <h2 id="source-permissions-heading">Source fallback permissions</h2>
    <p>For the original host, source overrides take precedence over exact-host rules. Linked and redirect hosts need their own exact-host allow rule; source overrides do not apply to them. Otherwise the default is deny (false). Seeded allow rules are youtube.com, www.youtube.com, m.youtube.com and youtu.be. Rules do not match subdomains or wildcards. These settings do not yet enable fallback processing.</p>
    {!online && <p role="status">Offline. Source permission changes are unavailable.</p>}
    {loading && <p role="status">Loading source permissions…</p>}
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {stale && <button type="button" disabled={!online || !navigator.onLine || busy || loading} onClick={() => void load()}>Retry source permissions</button>}
    {data && <>
      <h3>Source overrides</h3>
      {!data.sources.length && <p>No sources.</p>}
      <ul>{data.sources.map(source => {
        const label = `${source.title || 'Untitled source'} (${source.externalFeedId}) — context ${source.contextId}`;
        const selected = drafts[source.id] ?? choice(source.override);
        return <li key={source.id}>
          <p>{label} — Saved: {choice(source.override)}</p>
          <form onSubmit={e => { e.preventDefault(); void save(`/api/v1/sources/${encodeURIComponent(source.id)}/fallback-permission`, 'PATCH', { override: selected === 'inherit' ? null : selected === 'allow' }, source.id); }}>
            <label>Override for {label}<select value={selected} disabled={disabled} onChange={e => setDrafts(previous => ({ ...previous, [source.id]: e.target.value as Choice }))}>
              <option value="inherit">Inherit</option><option value="allow">Allow</option><option value="deny">Deny</option>
            </select></label>
            <button disabled={disabled || selected === choice(source.override)}>Save override for {label}</button>
          </form>
        </li>;
      })}</ul>
      <h3>Exact-host rules</h3>
      {!data.hostRules.length && <p>No host rules.</p>}
      <ul>{data.hostRules.map(rule => <li key={rule.host}>{rule.host} — {rule.allowed ? 'allow' : 'deny'}</li>)}</ul>
      <form onSubmit={e => { e.preventDefault(); void save('/api/v1/settings/source-permissions/host', 'PUT', { host, allowed: hostChoice === 'allow' }); }}>
        <label>Exact host<input required maxLength={1024} value={host} disabled={disabled} onChange={e => setHost(e.target.value)} /></label>
        <label>Host permission<select value={hostChoice} disabled={disabled} onChange={e => setHostChoice(e.target.value as 'allow' | 'deny')}><option value="allow">Allow</option><option value="deny">Deny</option></select></label>
        <button disabled={disabled}>Save host rule</button>
      </form>
    </>}
  </section>;
}
