import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { renderRich } from './richText';

// ---------------------------------------------------------------- maths text
export function MathText({ text, className, as = 'div' }: { text: string | null | undefined; className?: string; as?: 'div' | 'span' }) {
  const html = useMemo(() => renderRich(text), [text]);
  const Tag = as;
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------------------------------------------------------------- feedback
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="loading" role="status"><span className="spinner" aria-hidden /> {label}</div>;
}

export function ErrorNote({ error, onRetry }: { error: string | null | undefined; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="notice bad" role="alert">
      <div className="spread"><span>{error}</span>{onRetry && <button className="btn sm" onClick={onRetry}>Try again</button>}</div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3>{children}</div>;
}

// ---------------------------------------------------------------- toasts
type Toast = { id: number; text: string; bad?: boolean };
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, bad?: boolean) => {
    const id = ++seq.current;
    setItems((t) => [...t, { id, text, bad }]);
    setTimeout(() => setItems((t) => t.filter((x) => x.id !== id)), bad ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.bad ? 'bad' : ''}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------------------------------------------------------------- modal
export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Confirm({ title, body, confirmLabel, danger, onConfirm, onClose, busy }: {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        <div>{body}</div>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- data hook
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fn().then((d) => { if (live) setData(d); })
      .catch((e: Error) => { if (live) setError(e.message || 'Something went wrong'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1), setData };
}

// ---------------------------------------------------------------- pagination
export function Pager({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (o: number) => void }) {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  return (
    <div className="spread" style={{ marginTop: '0.8rem' }}>
      <span className="muted small num">Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
      <div className="btn-row">
        <button className="btn sm" disabled={page <= 1} onClick={() => onChange(offset - limit)}>Previous</button>
        <span className="small num">Page {page} of {pages}</span>
        <button className="btn sm" disabled={page >= pages} onClick={() => onChange(offset + limit)}>Next</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- theme
export function useTheme() {
  const [theme, setTheme] = useState<string>(() => {
    try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* storage unavailable */ }
  }, [theme]);
  const cycle = () => setTheme((t) => (t === 'system' ? 'dark' : t === 'dark' ? 'light' : 'system'));
  return { theme, cycle };
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="12" fill="rgba(255,255,255,0.12)" />
      <path d="M16 46 L28 18 L36 36 L48 14" fill="none" stroke="#F5C518" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
