import { useEffect, useState } from 'react';
import { request, type SavedSummary } from './api';

export function Summary({ articleId, online, refresh }: { articleId: string; online: boolean; refresh: number }) {
  const [summary, setSummary] = useState<SavedSummary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!online) return;
    let active = true;
    setSummary(null); setFailed(false);
    request<SavedSummary>(`/api/v1/articles/${encodeURIComponent(articleId)}/summary`)
      .then(value => { if (active) setSummary(value); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [articleId, online, refresh]);
  return <section aria-label="Summary"><h3>Summary</h3>
    {!online ? <p>Summary available online only.</p> : failed ? <p role="status">Could not load summary.</p> : !summary ? <p role="status">Loading summary…</p> : summary.status === 'missing' ? <p>No saved summary.</p> : <>
      <p>Status: {summary.status === 'outdated' ? 'Outdated (content has changed)' : summary.status === 'limited' ? 'Limited' : 'Current'}</p>
      <p style={{ whiteSpace: 'pre-wrap' }}>{summary.text}</p>
      <p>Content revision: {summary.contentRevision} · Completed: <time dateTime={summary.completedAt}>{summary.completedAt}</time></p>
      {summary.limitation !== null && <p>Limitation: {summary.limitation}</p>}
    </>}
  </section>;
}
