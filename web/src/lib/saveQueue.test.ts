import { describe, expect, it, vi } from 'vitest';
import { type PendingItem, SaveQueue } from './saveQueue';

class MemStore {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
const ok = { saved: 1, status: 'in_progress', deadline_at: '', server_now: '' };
const item = (q: string, seq: number, extra: Partial<PendingItem> = {}): PendingItem =>
  ({ exam_question_id: q, answer: { options: ['A'] }, state: 'answered', seq, time_delta: 5, ...extra });
const fast = { debounce: 1, retry: [5, 5] };

describe('SaveQueue', () => {
  it('coalesces changes per question, keeps the newest and sums time', async () => {
    const send = vi.fn(async () => ok);
    const q = new SaveQueue(send, 'k', {}, new MemStore(), fast);
    q.enqueue(item('q1', 1));
    q.enqueue(item('q1', 2, { answer: { options: ['B'] } }));
    q.enqueue(item('q1', 1, { answer: { options: ['C'] } })); // stale
    expect(await q.flush()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = (send.mock.calls[0] as unknown as [PendingItem[]])[0];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ seq: 2, answer: { options: ['B'] }, time_delta: 10 });
  });

  it('keeps unsent answers in storage and restores them after a reload', async () => {
    const store = new MemStore();
    const failing = vi.fn(async () => { throw new Error('offline'); });
    const q1 = new SaveQueue(failing, 'att', {}, store, { debounce: 1000, retry: [1000] });
    q1.enqueue(item('q1', 3));
    expect(await q1.flush()).toBe(false);
    expect(store.getItem('att')).toContain('q1');

    const send = vi.fn(async () => ok);
    const q2 = new SaveQueue(send, 'att', {}, store, fast);
    expect(q2.restored().map((i) => i.seq)).toEqual([3]);
    q2.reconcile(new Map([['q1', 1]])); // server is older → keep
    expect(q2.size).toBe(1);
    expect(await q2.flush()).toBe(true);
    expect(store.getItem('att')).toBeNull();
  });

  it('drops restored items the server already has', () => {
    const store = new MemStore();
    store.setItem('att', JSON.stringify([item('q1', 2), item('q2', 5)]));
    const q = new SaveQueue(async () => ok, 'att', {}, store, fast);
    q.reconcile(new Map([['q1', 2], ['q2', 4]]));
    expect(q.restored().map((i) => i.exam_question_id)).toEqual(['q2']);
  });

  it('retries after a failure and reports status', async () => {
    let calls = 0;
    const statuses: string[] = [];
    const send = vi.fn(async () => { calls++; if (calls === 1) throw new Error('500'); return ok; });
    const q = new SaveQueue(send, 'k', { onStatus: (s) => statuses.push(s.state) }, new MemStore(), fast);
    q.enqueue(item('q1', 1), true);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(2);
    expect(q.size).toBe(0);
    expect(statuses).toContain('retrying');
    expect(statuses.at(-1)).toBe('idle');
  });

  it('a change made while a save is in flight is not lost', async () => {
    let release!: () => void;
    const send = vi.fn(() => new Promise<typeof ok>((r) => { release = () => r(ok); }));
    const q = new SaveQueue(send, 'k', {}, new MemStore(), { debounce: 1000, retry: [5] });
    q.enqueue(item('q1', 1));
    const p = q.flush();
    q.enqueue(item('q1', 2, { answer: { options: ['D'] } }));
    release();
    await p;
    expect(q.size).toBe(1);
    expect(q.restored()[0].seq).toBe(2);
  });

  it('stops when the server reports the attempt is closed', async () => {
    const onClosed = vi.fn();
    const q = new SaveQueue(async () => ({ ...ok, status: 'auto_submitted' }), 'k', { onClosed }, new MemStore(), fast);
    q.enqueue(item('q1', 1));
    await q.flush();
    expect(onClosed).toHaveBeenCalledWith('auto_submitted');
    q.enqueue(item('q2', 1));
    expect(q.size).toBe(0);
  });
});
