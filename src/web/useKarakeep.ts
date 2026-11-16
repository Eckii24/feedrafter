import { useEffect, useRef, useState } from 'react';
import { HttpError, request } from './api';

type Task = { id: string; articleId: string; state: string; outcome: string | null; nextStep: string | null };
type Entry = { taskId?: string; task?: Task; error?: string; invalid?: boolean };
const terminal = (state: string) => !['queued', 'running', 'paused_auth'].includes(state);

export function suitableKarakeepUrl(value: string | null): boolean {
  if (!value || value.length > 4000 || value !== value.trim() || value.includes('\\') || Array.from(value).some(c => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)) return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password; } catch { return false; }
}

export function useKarakeep(selected: string | null, online: boolean) {
  const [available, setAvailable] = useState(false);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const pending = useRef(new Set<string>());
  const entry = selected ? entries[selected] : undefined;
  const activeTasks = JSON.stringify(Object.entries(entries).filter(([, value]) => value.taskId && (!value.task || !terminal(value.task.state))).map(([id, value]) => [id, value.taskId]));

  useEffect(() => {
    if (!online) return;
    let active = true;
    request<{ available: boolean }>('/api/v1/karakeep').then(result => { if (active) setAvailable(result.available === true); }).catch(() => { if (active) setAvailable(false); });
    return () => { active = false; };
  }, [online]);

  useEffect(() => {
    if (!online) return;
    let active = true;
    const timers = new Map<string, number>();
    const update = async (id: string, taskId: string) => {
      try {
        const task = await request<Task>(`/api/v1/processing-tasks/${encodeURIComponent(taskId)}`);
        if (!active) return;
        if (task.id !== taskId || task.articleId !== id) throw new Error('Unexpected task response');
        setEntries(current => ({ ...current, [id]: { ...current[id], task, error: undefined } }));
        if (terminal(task.state)) return;
      } catch {
        if (!active) return;
        setEntries(current => ({ ...current, [id]: { ...current[id], error: 'Could not confirm Karakeep status; checking again when online.' } }));
      }
      if (active) timers.set(id, window.setTimeout(() => void update(id, taskId), 3000));
    };
    for (const [id, taskId] of JSON.parse(activeTasks) as [string, string][]) void update(id, taskId);
    return () => { active = false; for (const timer of timers.values()) window.clearTimeout(timer); };
  }, [activeTasks, online]);

  async function save(id: string) {
    if (!available || !online || !navigator.onLine || pending.current.has(id)) return;
    pending.current.add(id); setSubmitting(current => ({ ...current, [id]: true }));
    try {
      const result = await request<{ taskId: string }>(`/api/v1/articles/${encodeURIComponent(id)}/karakeep`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      setEntries(current => ({ ...current, [id]: { ...current[id], taskId: result.taskId, error: undefined } }));
    } catch (error) {
      if (error instanceof HttpError && error.status === 503) setAvailable(false);
      setEntries(current => ({ ...current, [id]: { ...current[id], invalid: error instanceof HttpError && error.status === 422, error: error instanceof HttpError && error.status === 503 ? 'Karakeep is unavailable.' : error instanceof HttpError && error.status === 422 ? 'Article has no suitable original URL.' : 'Could not confirm Karakeep request. Check Karakeep manually; retrying reuses any existing task.' } }));
    } finally { pending.current.delete(id); setSubmitting(current => ({ ...current, [id]: false })); }
  }
  return { available, entry, submitting: selected ? !!submitting[selected] : false, save };
}

export function karakeepStatus(entry: Entry | undefined): string {
  if (!entry?.taskId) return '';
  const task = entry.task;
  if (task?.state === 'paused_auth') return `Karakeep authentication paused. ${task.nextStep || 'Repair credentials and restart the worker to resume.'}`;
  if (!task || !terminal(task.state)) return 'Saving to Karakeep…';
  if (task.state === 'succeeded' && task.outcome === 'created') return 'Saved to Karakeep.';
  if (task.state === 'succeeded' && task.outcome === 'existing') return 'Already exists in Karakeep.';
  if (task.state === 'needs_input') return `Karakeep needs input. ${task.nextStep || 'Check Karakeep manually before taking further action; this request will not be retried automatically.'}`;
  return 'Karakeep result not confirmed. Check Karakeep manually before taking further action.';
}
