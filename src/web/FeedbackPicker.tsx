import { useEffect, useRef, useState } from 'react';
import { request } from './api';

type Target = { type: 'tag' | 'source'; id: string; label: string; detached: boolean; value: -1 | 0 | 1 | null; votedAt: string | null };
const key = (target: Target) => `${target.type}:${target.id}`;

export function FeedbackPicker({ articleId, online }: { articleId: string; online: boolean }) {
  const [direction, setDirection] = useState<-1 | 0 | 1 | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const positiveRef = useRef<HTMLButtonElement>(null);
  const negativeRef = useRef<HTMLButtonElement>(null);
  const neutralRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => { setDirection(null); setTargets([]); setSelected([]); setError(''); setStatus(''); restoreFocus.current = false; }, [articleId]);
  useEffect(() => {
    if (!busy && restoreFocus.current) {
      restoreFocus.current = false;
      if (online) (direction === 1 ? positiveRef : direction === -1 ? negativeRef : neutralRef).current?.focus();
    }
  }, [busy, direction, online]);
  async function chooseDirection(value: -1 | 0 | 1) {
    if (busy) return;
    setSelected([]); setError(''); setStatus('');
    if (direction === value) { setDirection(null); return; }
    setBusy(true);
    try { const result = await request<{ targets: Target[] }>(`/api/v1/articles/${articleId}/feedback`); setTargets(result.targets); setDirection(value); }
    catch { setError('Could not load feedback targets.'); }
    finally { setBusy(false); }
  }
  async function vote(value: -1 | 0 | 1) {
    setBusy(true); setError(''); setStatus('');
    try {
      const chosen = targets.filter(target => selected.includes(key(target))).map(({ type, id }) => ({ type, id }));
      const result = await request<{ targets: Target[] }>(`/api/v1/articles/${articleId}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value, targets: chosen }) });
      setTargets(result.targets); setSelected([]); setStatus('Feedback saved.');
    } catch { setError('Could not confirm feedback. Reload targets to check.'); }
    finally { restoreFocus.current = true; setBusy(false); }
  }
  async function remove(target: Target) {
    setBusy(true); setError(''); setStatus('');
    try {
      await request(`/api/v1/articles/${articleId}/feedback/${target.type === 'tag' ? 'tags' : 'sources'}/${target.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
      const result = await request<{ targets: Target[] }>(`/api/v1/articles/${articleId}/feedback`); setTargets(result.targets); setSelected([]); setStatus('Vote removed.');
    } catch { setError('Could not confirm removal. Reload targets to check.'); }
    finally { restoreFocus.current = true; setBusy(false); }
  }
  const render = (items: Target[]) => items.map(target => <div key={key(target)}><label><input type="checkbox" checked={selected.includes(key(target))} disabled={!online || busy} onChange={event => setSelected(current => event.target.checked ? [...current, key(target)] : current.filter(item => item !== key(target)))} /> {target.type}: {target.label}</label> <span>{target.value === null ? 'Not voted' : target.value === 1 ? 'Positive' : target.value === -1 ? 'Negative' : 'Neutral'}</span>{target.value !== null && <button disabled={!online || busy} onClick={() => void remove(target)} aria-label={`Remove vote for ${target.type}: ${target.label}`}>Remove vote</button>}</div>);
  return <section aria-label="Targeted feedback"><button ref={positiveRef} disabled={!online} aria-disabled={busy} aria-expanded={direction === 1} onClick={() => void chooseDirection(1)}>👍 Positive feedback</button><button ref={negativeRef} disabled={!online} aria-disabled={busy} aria-expanded={direction === -1} onClick={() => void chooseDirection(-1)}>👎 Negative feedback</button><button ref={neutralRef} disabled={!online} aria-disabled={busy} aria-expanded={direction === 0} onClick={() => void chooseDirection(0)}>Neutral feedback</button><p role="status">{status}</p>{error && <p role="alert">{error}</p>}{direction !== null && <div><p>Select one or more targets, then submit {direction === 1 ? 'positive' : direction === -1 ? 'negative' : 'neutral'} feedback.</p><fieldset><legend>Current targets</legend>{render(targets.filter(t => !t.detached))}</fieldset>{targets.some(t => t.detached) && <fieldset><legend>Previously voted detached tags</legend>{render(targets.filter(t => t.detached))}</fieldset>}{!targets.length && <p>No feedback targets available.</p>}<button disabled={!online || busy || !selected.length} onClick={() => void vote(direction)}>Submit feedback</button></div>}</section>;
}
