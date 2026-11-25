import { useEffect, useRef, useState } from 'react';
import { HttpError, request } from './api';

type Task = { id: string; action: string; generation: number; state: string; errorCode: string | null; scoreTargetId: string | null };
type History = { eligibility: 'eligible' | 'ineligible' | 'already_started' | 'unavailable'; retryFailedTaskId?: string | null; tasks: Task[] };
type Admission = { kind: string };

export function ArticleProcessing({ articleId, online, refresh }: { articleId: string; online: boolean; refresh: number }) {
  const [history, setHistory] = useState<History | null>(null);
  const [status, setStatus] = useState('');
  const [pollError, setPollError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!online) return;
    let active = true;
    let timer = 0;
    const update = async () => {
      try {
        const value = await request<History>(`/api/v1/articles/${encodeURIComponent(articleId)}/processing`);
        if (!['eligible', 'ineligible', 'already_started', 'unavailable'].includes(value.eligibility) || !Array.isArray(value.tasks)) throw new Error('Unexpected processing response');
        if (active) { setHistory(value); setPollError(false); }
      } catch {
        if (active) { setHistory(null); setPollError(true); }
      }
      if (active) timer = window.setTimeout(() => void update(), 3000);
    };
    void update();
    return () => { active = false; window.clearTimeout(timer); };
  }, [articleId, online, refresh, revision]);
  async function submit() {
    if (!online || !navigator.onLine || pending.current || history?.eligibility !== 'eligible') return;
    pending.current = true; setBusy(true); setStatus(''); setHistory(null);
    try {
      const result = await request<Admission>(`/api/v1/articles/${encodeURIComponent(articleId)}/processing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (alive.current) setStatus(result.kind === 'admitted' ? 'Processing admitted. Admission does not mean processing succeeded.' : `Processing result: ${result.kind}. Previous failures are not retried.`);
    } catch (error) {
      if (alive.current) setStatus(error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408
        ? `Processing request rejected: ${error.message}`
        : 'Could not confirm processing request. It may have started; previous failures are not retried.');
    } finally { pending.current = false; if (alive.current) { setBusy(false); setRevision(value => value + 1); } }
  }
  async function retry() {
    const failedTaskId = history?.retryFailedTaskId;
    if (!online || !navigator.onLine || pending.current || !failedTaskId) return;
    pending.current = true; setBusy(true); setStatus('');
    try {
      const result = await request<Admission>(`/api/v1/articles/${encodeURIComponent(articleId)}/processing/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ failedTaskId }) });
      if (alive.current) setStatus(result.kind === 'admitted' ? 'Retry admitted. Admission does not mean processing succeeded.' : `Retry result: ${result.kind}.`);
    } catch (error) {
      if (alive.current) setStatus(error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408
        ? `Retry request rejected: ${error.message}`
        : 'Could not confirm retry request. It may have started; check processing history before taking further action.');
    } finally { pending.current = false; if (alive.current) { setHistory(value => value ? { ...value, retryFailedTaskId: null } : null); setBusy(false); setRevision(value => value + 1); } }
  }
  return <section aria-label="Article processing"><h3>Article processing</h3>
    <p>Prepare and classify this article. Processing may use configured external services. Long content may be classified and tagged using excerpts; the status does not identify which results used them. Previous failures are not retried by this action.</p>
    <button disabled={!online || busy || history?.eligibility !== 'eligible'} onClick={() => void submit()}>{busy ? 'Starting…' : 'Process article'}</button>
    {history?.retryFailedTaskId && <><p>Retrying starts a new preparation attempt. A new AI request may send article content to configured external services. The previous attempt may already have sent content.</p><button disabled={!online || busy} onClick={() => void retry()}>Retry failed preparation</button></>}
    {!online && <p>Offline. Processing and status updates are unavailable.</p>}
    {history?.eligibility === 'ineligible' && <p>First-time processing requires an article or video with a URL.</p>}
    {history?.eligibility === 'unavailable' && <p>Manual processing is unavailable on this server.</p>}
    {history?.eligibility === 'already_started' && <p>Processing has already started or content exists. This action cannot retry previous failures.</p>}
    <div role="status" aria-live="polite">{pollError && <p>Processing status could not be confirmed.</p>}{status && <p>{status}</p>}{history && history.tasks.length > 0 && <ul>{history.tasks.map(task => <li key={task.id}>{task.action}: {task.state}{task.errorCode && ` · ${task.errorCode}`} · generation {task.generation}{task.scoreTargetId && ` · score ${task.scoreTargetId}`}</li>)}</ul>}</div>
  </section>;
}
