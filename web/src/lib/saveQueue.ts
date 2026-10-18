// Reliable autosave for exam responses.
// - Every change gets a per-question sequence number; the server ignores
//   anything older than what it already has, so retries and out-of-order
//   delivery are harmless.
// - Unsent changes are kept in localStorage, so a refresh or a dropped
//   connection never loses a saved answer.
// - Failed sends retry with backoff until they succeed or the attempt closes.

export type Answer = { options?: string[]; value?: string } | null;
export type ResponseState = 'not_visited' | 'not_answered' | 'answered' | 'marked' | 'answered_marked';

export interface PendingItem {
  exam_question_id: string;
  answer: Answer;
  state: ResponseState;
  seq: number;
  time_delta: number;
}

export interface SaveResult { saved: number; status: string; deadline_at: string; server_now: string }
export type QueueState = 'idle' | 'saving' | 'retrying' | 'offline';
export interface QueueStatus { state: QueueState; pending: number; lastSavedAt: number | null; lastError: string | null }

interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

function safeStorage(): StorageLike | null {
  try {
    const s = globalThis.localStorage;
    const probe = '__probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export class SaveQueue {
  private pending = new Map<string, PendingItem>();
  private inflight: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;
  private status: QueueStatus = { state: 'idle', pending: 0, lastSavedAt: null, lastError: null };
  private storage: StorageLike | null;

  constructor(
    private send: (items: PendingItem[]) => Promise<SaveResult>,
    private key: string,
    private hooks: { onStatus?: (s: QueueStatus) => void; onClosed?: (status: string) => void; onServerTime?: (r: SaveResult) => void } = {},
    storage?: StorageLike | null,
    private delays = { debounce: 300, retry: [1000, 2000, 5000, 10000, 20000] },
  ) {
    this.storage = storage === undefined ? safeStorage() : storage;
    try {
      const raw = this.storage?.getItem(this.key);
      if (raw) for (const it of JSON.parse(raw) as PendingItem[]) this.pending.set(it.exam_question_id, it);
    } catch { /* ignore corrupt storage */ }
    this.emit({});
  }

  /** Items restored from a previous session (e.g. after a refresh). */
  restored(): PendingItem[] { return [...this.pending.values()]; }

  /** Drop restored items the server already has (seq not newer). */
  reconcile(serverSeq: Map<string, number>) {
    for (const [qid, it] of this.pending) if ((serverSeq.get(qid) ?? 0) >= it.seq) this.pending.delete(qid);
    this.persist();
    this.emit({});
  }

  get size() { return this.pending.size; }

  enqueue(item: PendingItem, immediate = false) {
    if (this.closed) return;
    const prev = this.pending.get(item.exam_question_id);
    const merged = prev && prev.seq < item.seq ? { ...item, time_delta: item.time_delta + prev.time_delta } : item;
    if (!prev || prev.seq < item.seq) this.pending.set(item.exam_question_id, merged);
    this.persist();
    this.emit({});
    this.schedule(immediate ? 0 : this.delays.debounce);
  }

  /** Send everything now; resolves true when nothing is left pending. */
  async flush(): Promise<boolean> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.inflight) await this.inflight;
    if (this.closed) return this.pending.size === 0;
    if (this.pending.size === 0) return true;

    const batch = [...this.pending.values()].slice(0, 100);
    this.emit({ state: 'saving' });
    this.inflight = (async () => {
      try {
        const res = await this.send(batch);
        for (const sent of batch) {
          const cur = this.pending.get(sent.exam_question_id);
          if (cur && cur.seq === sent.seq) this.pending.delete(sent.exam_question_id);
          else if (cur) cur.time_delta = Math.max(0, cur.time_delta - sent.time_delta);
        }
        this.persist();
        this.attempt = 0;
        this.hooks.onServerTime?.(res);
        this.emit({ state: 'idle', lastSavedAt: Date.now(), lastError: null });
        if (res.status !== 'in_progress') {
          this.closed = true;
          this.hooks.onClosed?.(res.status);
          return this.pending.size === 0;
        }
        if (this.pending.size) this.schedule(0);
        return this.pending.size === 0;
      } catch (e) {
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        const delay = this.delays.retry[Math.min(this.attempt, this.delays.retry.length - 1)];
        this.attempt++;
        this.emit({ state: offline ? 'offline' : 'retrying', lastError: (e as Error).message });
        this.schedule(delay);
        return false;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Called when the attempt is known to be closed (submitted / time over). */
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.pending.clear();
    try { this.storage?.removeItem(this.key); } catch { /* ignore */ }
    this.emit({ state: 'idle' });
  }

  private schedule(ms: number) {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, ms);
  }

  private persist() {
    try {
      if (this.pending.size) this.storage?.setItem(this.key, JSON.stringify([...this.pending.values()]));
      else this.storage?.removeItem(this.key);
    } catch { /* storage full or blocked: in-memory queue still works */ }
  }

  private emit(patch: Partial<QueueStatus>) {
    this.status = { ...this.status, ...patch, pending: this.pending.size };
    this.hooks.onStatus?.(this.status);
  }
}
