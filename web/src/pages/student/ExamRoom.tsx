import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { rpc, signedUrl } from '../../lib/api';
import { clock, num, TYPE_LABEL } from '../../lib/format';
import { type Answer, type PendingItem, type QueueStatus, type ResponseState, SaveQueue } from '../../lib/saveQueue';
import { db } from '../../lib/db';
import { Confirm, ErrorNote, Loading, MathText, useTheme } from '../../lib/ui';

interface PaperQuestion {
  id: string; position: number; section_key: string; subject: { id: string; code: string; name: string } | null;
  type: 'single' | 'multiple' | 'integer' | 'numerical'; marks: number; negative_marks: number;
  statement: string; image_path: string | null; options: { label: string; content: string }[];
}
interface Paper {
  server_now: string;
  attempt: { id: string; status: string; started_at: string; deadline_at: string; submitted_at: string | null; attempt_no: number };
  exam: { version_id: string; title: string; instructions: string; duration_minutes: number; total_marks: number; sections: { key: string; title: string }[] };
  questions: PaperQuestion[];
  responses: { exam_question_id: string; answer: Answer; state: ResponseState; seq: number }[];
}
interface QState { saved: Answer; draft: Answer; state: ResponseState; seq: number }

const NUMERIC_TYPING = /^[+-]?\d*\.?\d*(e[+-]?\d*)?$/i;

function hasAnswer(a: Answer): boolean {
  return !!a && ((a.options?.length ?? 0) > 0 || (a.value ?? '').trim() !== '');
}
function sameAnswer(a: Answer, b: Answer): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export default function ExamRoom() {
  const { attemptId = '' } = useParams();
  const nav = useNavigate();
  useTheme();
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [qs, setQs] = useState<Record<string, QState>>({});
  const [current, setCurrent] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [offset, setOffset] = useState(0); // serverTime − localTime
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [images, setImages] = useState<Record<string, string>>({});

  const queueRef = useRef<SaveQueue | null>(null);
  const seqRef = useRef<Record<string, number>>({});
  const timeRef = useRef<{ qid: string | null; since: number; acc: Record<string, number> }>({ qid: null, since: Date.now(), acc: {} });
  const finishingRef = useRef(false);
  const draftKey = `drafts:${attemptId}`;

  const goSubmitted = useCallback(() => {
    queueRef.current?.close();
    try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
    nav(`/attempt/${attemptId}/submitted`, { replace: true });
  }, [attemptId, draftKey, nav]);

  // ------------------------------------------------------------ load
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const t0 = Date.now();
        const p = await rpc<Paper>('get_attempt', { p_attempt: attemptId });
        const rtt = Date.now() - t0;
        if (!live) return;
        if (p.attempt.status !== 'in_progress') { goSubmitted(); return; }
        setOffset(new Date(p.server_now).getTime() + rtt / 2 - Date.now());

        const queue = new SaveQueue(
          (items) => rpc('save_responses', { p_attempt: attemptId, p_items: items }),
          `pending:${attemptId}`,
          {
            onStatus: setQueueStatus,
            onClosed: () => { if (!finishingRef.current) goSubmitted(); },
            onServerTime: (r) => setOffset(new Date(r.server_now).getTime() - Date.now()),
          },
        );
        const serverSeq = new Map(p.responses.map((r) => [r.exam_question_id, r.seq]));
        queue.reconcile(serverSeq);
        queueRef.current = queue;

        const base: Record<string, QState> = {};
        for (const q of p.questions) base[q.id] = { saved: null, draft: null, state: 'not_visited', seq: 0 };
        for (const r of p.responses) base[r.exam_question_id] = { saved: r.answer, draft: r.answer, state: r.state, seq: r.seq };
        for (const it of queue.restored()) base[it.exam_question_id] = { saved: it.answer, draft: it.answer, state: it.state, seq: it.seq };
        let drafts: Record<string, Answer> = {};
        try { drafts = JSON.parse(localStorage.getItem(draftKey) || '{}'); } catch { /* ignore */ }
        for (const [qid, a] of Object.entries(drafts)) if (base[qid]) base[qid].draft = a;
        seqRef.current = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.seq]));

        setQs(base);
        setPaper(p);
        const firstUnseen = p.questions.findIndex((q) => base[q.id].state === 'not_visited');
        setCurrent(firstUnseen > 0 ? firstUnseen : 0);
        if (queue.size) void queue.flush();
        void rpc('log_attempt_event', { p_attempt: attemptId, p_kind: 'resume', p_details: {} }).catch(() => {});
      } catch (e) {
        if (live) setLoadError((e as Error).message);
      }
    })();
    return () => { live = false; };
  }, [attemptId, draftKey, goSubmitted]);

  // ------------------------------------------------------------ clock
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const deadline = paper ? new Date(paper.attempt.deadline_at).getTime() : 0;
  const remaining = paper ? deadline - (now + offset) : 0;

  // ------------------------------------------------------------ connectivity & integrity signals
  useEffect(() => {
    const log = (kind: string) => { void rpc('log_attempt_event', { p_attempt: attemptId, p_kind: kind, p_details: {} }).catch(() => {}); };
    const onOnline = () => { setOnline(true); log('online'); void queueRef.current?.flush(); };
    const onOffline = () => { setOnline(false); };
    const onVis = () => {
      if (document.visibilityState === 'hidden') { log('visibility_hidden'); void queueRef.current?.flush(); }
      else log('visibility_visible');
    };
    const beforeUnload = (e: BeforeUnloadEvent) => { if ((queueRef.current?.size ?? 0) > 0) { e.preventDefault(); } };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [attemptId]);

  // ------------------------------------------------------------ helpers
  const questions = paper?.questions ?? [];
  const q = questions[current];

  const sections = useMemo(() => {
    if (!paper) return [];
    const declared = paper.exam.sections ?? [];
    const keys = [...new Set(paper.questions.map((x) => x.section_key))];
    return keys.map((k) => ({ key: k, title: declared.find((s) => s.key === k)?.title ?? paper.questions.find((x) => x.section_key === k)?.subject?.name ?? k }));
  }, [paper]);

  const takeTime = useCallback((qid: string) => {
    const t = timeRef.current;
    let secs = t.acc[qid] ?? 0;
    if (t.qid === qid) { secs += (Date.now() - t.since) / 1000; t.since = Date.now(); }
    t.acc[qid] = 0;
    return Math.round(secs);
  }, []);

  // track time on the question being viewed
  useEffect(() => {
    if (!q) return;
    const t = timeRef.current;
    if (t.qid && t.qid !== q.id) t.acc[t.qid] = (t.acc[t.qid] ?? 0) + (Date.now() - t.since) / 1000;
    t.qid = q.id;
    t.since = Date.now();
  }, [q]);

  const persistDrafts = (next: Record<string, QState>) => {
    try {
      const drafts: Record<string, Answer> = {};
      for (const [k, v] of Object.entries(next)) if (!sameAnswer(v.draft, v.saved)) drafts[k] = v.draft;
      localStorage.setItem(draftKey, JSON.stringify(drafts));
    } catch { /* ignore */ }
  };

  const commit = useCallback((qid: string, answer: Answer, state: ResponseState, immediate = true) => {
    const seq = (seqRef.current[qid] ?? 0) + 1;
    seqRef.current[qid] = seq;
    const item: PendingItem = { exam_question_id: qid, answer, state, seq, time_delta: takeTime(qid) };
    queueRef.current?.enqueue(item, immediate);
    setQs((prev) => {
      const next = { ...prev, [qid]: { saved: answer, draft: answer, state, seq } };
      persistDrafts(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeTime]);

  // visiting an unseen question marks it "not answered"
  useEffect(() => {
    if (!q) return;
    const s = qs[q.id];
    if (s && s.state === 'not_visited') commit(q.id, null, 'not_answered', false);
  }, [q, qs, commit]);

  const setDraft = (answer: Answer) => {
    if (!q) return;
    setQs((prev) => {
      const next = { ...prev, [q.id]: { ...prev[q.id], draft: answer } };
      persistDrafts(next);
      return next;
    });
  };

  const go = (i: number) => { if (i >= 0 && i < questions.length) { setCurrent(i); setPaletteOpen(false); } };

  const saveAndNext = () => {
    if (!q) return;
    const d = qs[q.id].draft;
    commit(q.id, hasAnswer(d) ? d : null, hasAnswer(d) ? 'answered' : 'not_answered');
    go(current + 1 < questions.length ? current + 1 : current);
  };
  const saveAndMark = () => {
    if (!q) return;
    const d = qs[q.id].draft;
    commit(q.id, hasAnswer(d) ? d : null, hasAnswer(d) ? 'answered_marked' : 'marked');
    go(current + 1 < questions.length ? current + 1 : current);
  };
  const markAndNext = () => {
    if (!q) return;
    const s = qs[q.id];
    commit(q.id, s.saved, hasAnswer(s.saved) ? 'answered_marked' : 'marked');
    go(current + 1 < questions.length ? current + 1 : current);
  };
  const clearResponse = () => { if (q) commit(q.id, null, 'not_answered'); };

  // ------------------------------------------------------------ submission
  const finish = useCallback(async (reason: 'manual' | 'timer') => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await queueRef.current?.flush();
      const { error } = await db.rpc('submit_attempt', { p_attempt: attemptId, p_reason: reason });
      if (error) throw error;
      goSubmitted();
    } catch (e) {
      finishingRef.current = false;
      setSubmitting(false);
      setSubmitError(`${(e as Error).message || 'Submission failed'}. Your saved answers are safe — try again.`);
    }
  }, [attemptId, goSubmitted]);

  useEffect(() => {
    if (paper && remaining <= 0 && !finishingRef.current) void finish('timer');
  }, [paper, remaining, finish]);

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!q || confirmSubmit) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toUpperCase();
      if ((q.type === 'single' || q.type === 'multiple') && q.options.some((o) => o.label === k)) {
        e.preventDefault();
        toggleOption(k);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ------------------------------------------------------------ images
  useEffect(() => {
    if (q?.image_path && !images[q.image_path]) {
      const path = q.image_path;
      void signedUrl('question-images', path, 3600).then((u) => { if (u) setImages((m) => ({ ...m, [path]: u })); });
    }
  }, [q, images]);

  function toggleOption(label: string) {
    if (!q) return;
    const d = qs[q.id]?.draft;
    const cur = d?.options ?? [];
    if (q.type === 'single') setDraft({ options: cur[0] === label ? [] : [label] });
    else setDraft({ options: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label].sort() });
  }

  // ------------------------------------------------------------ render
  if (loadError) {
    return <div className="page"><ErrorNote error={loadError} /><p><Link to="/">Back to your tests</Link></p></div>;
  }
  if (!paper || !q) return <Loading label="Loading your paper…" />;

  const counts = { answered: 0, not_answered: 0, marked: 0, answered_marked: 0, not_visited: 0 } as Record<ResponseState, number>;
  for (const x of questions) counts[qs[x.id]?.state ?? 'not_visited']++;
  const sectionQs = questions.map((x, i) => ({ x, i })).filter(({ x }) => x.section_key === q.section_key);
  const s = qs[q.id];
  const unsavedChange = !sameAnswer(s.draft, s.saved) && hasAnswer(s.draft);
  const lowTime = remaining < 5 * 60 * 1000;

  const saveText = !online ? 'Offline — answers are kept on this device and will be sent when you reconnect'
    : queueStatus?.state === 'saving' ? 'Saving…'
    : queueStatus?.state === 'retrying' ? 'Retrying save…'
    : queueStatus?.pending ? 'Waiting to save…'
    : 'All answers saved';

  return (
    <div className="cbt">
      <header className="cbt-top">
        <h1>{paper.exam.title}</h1>
        <span className="save-state" aria-live="polite">{saveText}</span>
        <span className={`timer ${lowTime ? 'low' : ''}`} role="timer" aria-label="Time left">{clock(remaining)}</span>
      </header>
      {!online && <div className="offline-banner">You are offline. Keep working — saved answers will sync automatically.</div>}

      <nav className="cbt-sections" aria-label="Sections">
        {sections.map((sec) => (
          <button key={sec.key} className={sec.key === q.section_key ? 'active' : ''}
            onClick={() => go(questions.findIndex((x) => x.section_key === sec.key))}>{sec.title}</button>
        ))}
      </nav>

      <div className="cbt-body">
        <main className="qpane">
          <div className="qhead">
            <h2><span className="qnum">Q{q.position}</span>{TYPE_LABEL[q.type]}</h2>
            <div className="qmeta">
              <span className="badge ok num">+{num(q.marks)}</span>
              <span className="badge bad num">{Number(q.negative_marks) ? `−${num(q.negative_marks)}` : 'No negative'}</span>
              <button className="btn sm palette-toggle" onClick={() => setPaletteOpen((o) => !o)}>Questions</button>
            </div>
          </div>
          <MathText className="read qtext" text={q.statement} />
          {q.image_path && (images[q.image_path]
            ? <img className="qimg" src={images[q.image_path]} alt="Figure for this question" />
            : <p className="muted small">Loading figure…</p>)}

          {(q.type === 'single' || q.type === 'multiple') ? (
            <div className="options" role={q.type === 'single' ? 'radiogroup' : 'group'} aria-label="Options">
              {q.options.map((o) => {
                const chosen = s.draft?.options?.includes(o.label) ?? false;
                return (
                  <label key={o.label} className={`option ${chosen ? 'selected' : ''}`}>
                    <input type={q.type === 'single' ? 'radio' : 'checkbox'} name={`q-${q.id}`} checked={chosen}
                      onChange={() => toggleOption(o.label)} />
                    <span className="lbl">{o.label}</span>
                    <MathText as="span" className="read" text={o.content} />
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="numeric-answer">
              <label className="field">Your answer{q.type === 'integer' ? ' (whole number)' : ''}
                <input type="text" inputMode={q.type === 'integer' ? 'numeric' : 'decimal'} autoComplete="off"
                  value={s.draft?.value ?? ''} maxLength={20}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    if (q.type === 'integer' ? /^[+-]?\d*$/.test(v) : NUMERIC_TYPING.test(v)) setDraft(v ? { value: v } : null);
                  }} />
              </label>
            </div>
          )}
          {unsavedChange && <p className="small muted" style={{ marginTop: '1rem' }}>This choice is not saved yet. Use <b>Save &amp; Next</b> to record it.</p>}
        </main>

        <aside className={`palette-pane ${paletteOpen ? 'open' : ''}`} aria-label="Question palette">
          <div className="legend num">
            <span><i className="pal sm answered">{counts.answered}</i>Answered</span>
            <span><i className="pal sm not_answered">{counts.not_answered}</i>Not answered</span>
            <span><i className="pal sm not_visited">{counts.not_visited}</i>Not visited</span>
            <span><i className="pal sm marked">{counts.marked}</i>Marked</span>
            <span style={{ gridColumn: '1 / -1' }}><i className="pal sm answered_marked">{counts.answered_marked}</i>Answered &amp; marked (will be evaluated)</span>
          </div>
          <div>
            <h3 className="small" style={{ marginBottom: '0.5rem' }}>{sections.find((x) => x.key === q.section_key)?.title}</h3>
            <div className="palette">
              {sectionQs.map(({ x, i }) => (
                <button key={x.id} className={`pal ${qs[x.id]?.state ?? 'not_visited'} ${i === current ? 'current' : ''}`}
                  onClick={() => go(i)} aria-label={`Question ${x.position}, ${(qs[x.id]?.state ?? 'not_visited').replace('_', ' ')}`}
                  aria-current={i === current ? 'true' : undefined}>{x.position}</button>
              ))}
            </div>
          </div>
          <button className="btn primary" onClick={() => setConfirmSubmit(true)}>Submit test</button>
        </aside>
      </div>

      <footer className="cbt-actions">
        <div className="btn-row">
          <button className="btn ok" onClick={saveAndNext}>Save &amp; Next</button>
          <button className="btn" onClick={saveAndMark}>Save &amp; Mark for Review</button>
          <button className="btn" onClick={clearResponse}>Clear Response</button>
          <button className="btn mark" onClick={markAndNext}>Mark for Review &amp; Next</button>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => go(current - 1)} disabled={current === 0}>Back</button>
          <button className="btn" onClick={() => go(current + 1)} disabled={current === questions.length - 1}>Next</button>
          <button className="btn primary" onClick={() => setConfirmSubmit(true)}>Submit</button>
        </div>
      </footer>

      {(confirmSubmit || submitting || submitError) && (
        <Confirm
          title={remaining <= 0 ? 'Time is up' : 'Submit the test?'}
          busy={submitting}
          confirmLabel="Submit test"
          onClose={() => { if (!submitting) { setConfirmSubmit(false); setSubmitError(null); } }}
          onConfirm={() => void finish(remaining <= 0 ? 'timer' : 'manual')}
          body={(
            <div className="stack">
              {remaining <= 0 ? <p>Your time has ended. Submitting your saved answers…</p> : <p>You cannot change answers after submitting.</p>}
              <div className="table-wrap"><table className="data num"><tbody>
                <tr><td>Answered</td><td>{counts.answered + counts.answered_marked}</td></tr>
                <tr><td>Not answered</td><td>{counts.not_answered}</td></tr>
                <tr><td>Marked for review (no answer)</td><td>{counts.marked}</td></tr>
                <tr><td>Not visited</td><td>{counts.not_visited}</td></tr>
              </tbody></table></div>
              {(queueStatus?.pending ?? 0) > 0 && <p className="small">Unsent answers will be saved before submitting.</p>}
              <ErrorNote error={submitError} />
            </div>
          )}
        />
      )}
    </div>
  );
}
