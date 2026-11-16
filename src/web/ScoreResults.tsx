import { useEffect, useState } from 'react';
import { request } from './api';

type ScoreResult = {
  scoreTargetId: string; name: string; active: boolean; deleted: boolean;
  value: number | null; calculatedAt: string | null; contentRevision: number | null; assignmentRevision: number | null;
  stale: boolean | null; condensed: boolean | null; limited: boolean | null;
  latestTask: { generation: number; state: string; errorCode: string | null } | null;
};

export function ScoreResults({ articleId, online, refresh }: { articleId: string; online: boolean; refresh: number }) {
  const [items, setItems] = useState<ScoreResult[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!online) return;
    let active = true;
    setItems(null); setFailed(false);
    request<{ items: ScoreResult[] }>(`/api/v1/articles/${encodeURIComponent(articleId)}/scores`)
      .then(result => { if (active) setItems(result.items); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [articleId, online, refresh]);
  return <section aria-label="Score results"><h3>Score results</h3>
    {!online ? <p>Score results available online only.</p> : failed ? <p role="status">Could not load score results.</p> : !items ? <p role="status">Loading score results…</p> : items.length === 0 ? <p>No score definitions.</p> :
      <ul>{items.map(item => <li key={item.scoreTargetId}>
        <strong>{item.name}</strong> · Definition: {item.deleted ? 'Deleted' : item.active ? 'Active' : 'Inactive'}
        {item.value === null ? <p>No result.</p> : <>
          <p>{item.stale ? 'Previous result (stale)' : 'Current result'}: {item.value}</p>
          <p>Content revision: {item.contentRevision} · Assignment revision: {item.assignmentRevision} · Calculated: <time dateTime={item.calculatedAt ?? undefined}>{item.calculatedAt}</time></p>
          {item.condensed && <p>Condensed</p>}{item.limited && <p>Limited</p>}
        </>}
        {item.latestTask && <p>Latest processing: generation {item.latestTask.generation} · State: {item.latestTask.state} · Error code: {item.latestTask.errorCode ?? 'None'}</p>}
      </li>)}</ul>}
  </section>;
}
