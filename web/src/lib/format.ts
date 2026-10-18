export const TYPE_LABEL: Record<string, string> = {
  single: 'Single correct', multiple: 'One or more correct', integer: 'Integer answer', numerical: 'Numerical answer',
};
export const DIFFICULTY_LABEL: Record<string, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', in_review: 'In review', approved: 'Approved', rejected: 'Rejected', archived: 'Archived',
};
export const RELEASE_LABEL: Record<string, string> = {
  immediate: 'Right after submission', on_close: 'When the exam closes', scheduled: 'At a scheduled time', manual: 'When I release them',
};

export function fmtDate(v?: string | null, withTime = true): string {
  if (!v) return '—';
  const d = new Date(v);
  return d.toLocaleString(undefined, withTime
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDuration(seconds?: number | null): string {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${sec ? `${sec} s` : ''}`.trim();
  return `${sec} s`;
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function num(v: unknown, digits = 2): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/\.?0+$/, '');
}

export function pct(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${num(n, 1)}%` : '—';
}

export function answerText(type: string, answer: { options?: string[]; value?: unknown; tolerance?: unknown; min?: unknown; max?: unknown } | null | undefined): string {
  if (!answer) return 'Not answered';
  if (type === 'single' || type === 'multiple') return answer.options?.length ? answer.options.join(', ') : 'Not answered';
  if (answer.min != null && answer.max != null) return `${num(answer.min, 4)} to ${num(answer.max, 4)}`;
  if (answer.value == null || answer.value === '') return 'Not answered';
  const tol = Number(answer.tolerance ?? 0);
  return tol > 0 ? `${answer.value} (± ${num(tol, 4)})` : String(answer.value);
}
