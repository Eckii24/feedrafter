import { useEffect, useRef, useState } from 'react';
import { HttpError, request, type ScoreAdmission, type ScoreTask } from './api';

type Entry = { admission: ScoreAdmission; task?: ScoreTask; error?: string };
const terminal = (state: string) => ['succeeded', 'failed', 'needs_input', 'superseded', 'cancelled'].includes(state);
const pollLimit = 20;

export function ScoreReevaluation({ articleId, online, refresh }: { articleId: string; online: boolean; refresh: number }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const taskIds = JSON.stringify(entries?.map(entry => entry.admission.taskId) ?? []);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!online) return;
    let active = true;
    const timers: number[] = [];
    const admissions = new Map(entries?.map(entry => [entry.admission.taskId, entry.admission]) ?? []);
    const update = async (taskId: string, attempt: number) => {
      let done = false;
      try {
        const task = await request<ScoreTask>(`/api/v1/processing-tasks/${encodeURIComponent(taskId)}`);
        if (!active) return;
        const admission = admissions.get(taskId);
        if (!admission || task.id !== taskId || task.articleId !== articleId || task.action !== 'scores' || typeof task.state !== 'string' || task.generation !== admission.generation || (task.scoreTargetId !== null && task.scoreTargetId !== admission.scoreTargetId) || (task.errorCode !== null && typeof task.errorCode !== 'string')) throw new Error('Unexpected task response');
        done = terminal(task.state);
        setEntries(current => current?.map(entry => entry.admission.taskId === taskId ? { ...entry, task, error: undefined } : entry) ?? current);
      } catch {
        if (!active) return;
        setEntries(current => current?.map(entry => entry.admission.taskId === taskId ? { ...entry, error: 'Status could not be confirmed.' } : entry) ?? current);
      }
      if (!done && active) {
        if (attempt < pollLimit) timers.push(window.setTimeout(() => void update(taskId, attempt + 1), 3000));
        else setEntries(current => current?.map(entry => entry.admission.taskId === taskId ? { ...entry, error: 'Polling paused; status will refresh on the next server update or reconnect.' } : entry) ?? current);
      }
    };
    for (const taskId of JSON.parse(taskIds) as string[]) void update(taskId, 1);
    return () => { active = false; for (const timer of timers) window.clearTimeout(timer); };
  }, [articleId, online, refresh, taskIds]);

  async function submit() {
    if (!online || !navigator.onLine || pending.current) return;
    pending.current = true; setBusy(true); setEntries(null); setMessage('');
    try {
      const result = await request<{ tasks: ScoreAdmission[] }>(`/api/v1/articles/${encodeURIComponent(articleId)}/reevaluations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!Array.isArray(result?.tasks) || !result.tasks.every(task => task && typeof task.taskId === 'string' && typeof task.scoreTargetId === 'string' && Number.isInteger(task.generation) && typeof task.state === 'string') || new Set(result.tasks.map(task => task.taskId)).size !== result.tasks.length) throw new Error('Unexpected admission response');
      if (!alive.current) return;
      setEntries(result.tasks.map(admission => ({ admission })));
      setMessage(result.tasks.length ? 'Request admitted. Checking authoritative task status.' : 'No active score definitions; no tasks were created.');
    } catch (error) {
      if (!alive.current) return;
      setMessage(error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408
        ? `Reevaluation request rejected: ${error.message}`
        : 'Could not confirm reevaluation request. Tasks may have been created, but their IDs are unknown. A new reevaluation creates fresh generations and may supersede them.');
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return <section aria-label="Score reevaluation">
    <h3>Score reevaluation</h3>
    <p>Each request creates fresh generations and may supersede unfinished tasks. Model execution requires authorized configuration.</p>
    <button disabled={!online || busy} onClick={() => void submit()}>Reevaluate scores</button>
    {!online && <p>Offline. Reevaluation and status updates are unavailable.</p>}
    <div role="status" aria-live="polite">
      {message && <p>{message}</p>}
      {entries && entries.length > 0 && <ul>{entries.map(({ admission, task, error }) => <li key={admission.taskId}>
        Target: {task ? task.scoreTargetId ?? 'Unavailable' : admission.scoreTargetId} · Generation: {task?.generation ?? admission.generation} · {task ? `State: ${task.state}` : 'State: awaiting authoritative status'} · Error code: {task ? task.errorCode ?? 'None' : 'Unknown'}
        {task?.errorCode === 'configuration_required' && <> · Configuration required; model execution is not available.</>}
        {error && <> · {error}{task && ' Last confirmed state shown.'}</>}
      </li>)}</ul>}
    </div>
  </section>;
}
