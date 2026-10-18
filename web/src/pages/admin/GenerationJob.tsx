import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { invokeAi, rpc } from '../../lib/api';
import { DIFFICULTY_LABEL, fmtDate, num, STATUS_LABEL, TYPE_LABEL } from '../../lib/format';
import { db } from '../../lib/db';
import { Confirm, ErrorNote, Loading, MathText, useAsync, useToast } from '../../lib/ui';
import { must } from './common';

interface Progress {
  job: { id: string; status: string; error: string | null; exam_id: string | null; questions_requested: number; questions_generated: number;
    input_tokens: number; output_tokens: number; est_cost_usd: number; actual_cost_usd: number; provider: string; model: string; created_at: string;
    request: { title: string; allow_ai?: boolean } };
  slots: { slot_id: string; label: string; type: string; difficulty: string; count: number; bank_ids?: string[]; approved: number; pending: number; remaining: number; attempts?: number }[];
  estimate: { questions: number; batches: number; input_tokens: number; output_tokens: number; usd: number; note: string } | null;
}
interface GenQ { id: string; statement: string; status: string; type: string; difficulty: string; validation: { verdict?: string; flags?: string[] } }
interface BatchResult { done: boolean; generated: number; flagged: number; failures: { ref: string; slot: string; errors: string[] }[]; remaining: number; cost_usd: number }

const CRITICAL = new Set(['calculation_mismatch', 'calculation_points_to_other_option', 'verification_unparseable', 'unverified_calculation', 'possible_verbatim_copy', 'possible_duplicate']);

export default function GenerationJob() {
  const { jobId } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const prog = useAsync(() => rpc<Progress>('generation_job_progress', { p_job: jobId }), [jobId]);
  const gen = useAsync(() => must<GenQ[]>(db.from('questions').select('id, statement, status, type, difficulty, validation')
    .eq('generation_job_id', jobId).order('created_at')), [jobId]);
  const [running, setRunning] = useState(false);
  const stopRef = useRef(false);
  const [log, setLog] = useState<string[]>([]);
  const [assembleMissing, setAssembleMissing] = useState<{ label: string; needed: number; approved: number }[] | null>(null);
  const [busy, setBusy] = useState(false);

  const addLog = (s: string) => setLog((l) => [`${new Date().toLocaleTimeString()} — ${s}`, ...l].slice(0, 50));

  const runBatches = async (all: boolean) => {
    setRunning(true);
    stopRef.current = false;
    try {
      for (let i = 0; i < 200; i++) {
        const r = await invokeAi<BatchResult>({ action: 'generate', job_id: jobId });
        addLog(`Generated ${r.generated} question(s)${r.flagged ? `, ${r.flagged} flagged for review` : ''}${r.failures.length ? `, ${r.failures.length} rejected by checks` : ''}. ${r.remaining} still needed.`);
        for (const f of r.failures) addLog(`Rejected (${f.slot}): ${f.errors.join(' ')}`);
        prog.reload();
        gen.reload();
        if (r.done || !all || stopRef.current) break;
        if (r.generated === 0 && r.failures.length > 0 && i > 2) { addLog('Stopping: recent batches produced no valid questions.'); break; }
      }
    } catch (e) {
      addLog(`Stopped: ${(e as Error).message}`);
      toast((e as Error).message, true);
      prog.reload();
    } finally {
      setRunning(false);
    }
  };

  const setStatus = async (ids: string[], status: string) => {
    let ok = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try { await rpc('set_question_status', { p_question: id, p_status: status, p_note: null }); ok++; }
      catch (e) { errors.push((e as Error).message); }
    }
    toast(`${ok} question(s) ${STATUS_LABEL[status].toLowerCase()}${errors.length ? `; ${errors.length} could not be changed` : ''}`, errors.length > 0);
    gen.reload();
    prog.reload();
  };

  const assemble = async (partial: boolean) => {
    setBusy(true);
    try {
      const r = await rpc<{ ok: boolean; exam_id?: string; missing: { label: string; needed: number; approved: number }[] }>('assemble_exam_from_job', { p_job: jobId, p_allow_partial: partial });
      if (!r.ok) { setAssembleMissing(r.missing); return; }
      toast('Draft exam created — review it and publish when ready');
      nav(`/admin/exams/${r.exam_id}`);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  if (prog.loading && !prog.data) return <Loading />;
  if (prog.error || !prog.data) return <ErrorNote error={prog.error} onRetry={prog.reload} />;
  const { job, slots, estimate } = prog.data;
  const totalNeeded = slots.reduce((a, s) => a + s.count, 0);
  const fromBank = slots.reduce((a, s) => a + (s.bank_ids?.length ?? 0), 0);
  const remaining = slots.reduce((a, s) => a + s.remaining, 0);
  const approved = slots.reduce((a, s) => a + s.approved, 0);
  const drafts = (gen.data ?? []).filter((q) => q.status === 'draft' || q.status === 'in_review');
  const cleanDrafts = drafts.filter((q) => q.validation?.verdict === 'pass' && !(q.validation.flags ?? []).some((f) => CRITICAL.has(f)));
  const aiAllowed = job.request?.allow_ai !== false;

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>{job.request?.title}</h1><p>Generation job created {fmtDate(job.created_at)} · {job.provider} / {job.model}</p></div>
        <div className="btn-row"><Link className="btn" to="/admin/generate">New paper</Link>
          {job.exam_id && <Link className="btn primary" to={`/admin/exams/${job.exam_id}`}>Open exam</Link>}</div>
      </div>

      <div className="grid-4">
        <div className="panel stat"><b>{totalNeeded}</b><span>Questions in the blueprint</span></div>
        <div className="panel stat"><b>{fromBank}</b><span>Taken from the bank</span></div>
        <div className="panel stat"><b>{approved}</b><span>Approved and ready</span></div>
        <div className="panel stat"><b>{remaining}</b><span>Still to generate</span></div>
      </div>

      {estimate && aiAllowed && !job.exam_id && (
        <div className="notice">
          <b>Estimated AI usage for the gaps:</b> {estimate.questions} questions in about {estimate.batches} batches,
          ~{num(estimate.input_tokens / 1000, 0)}k input and ~{num(estimate.output_tokens / 1000, 0)}k output tokens, <b>≈ ${num(estimate.usd, 4)}</b>. {estimate.note}
          <div className="small muted">Spent so far on this job: ${num(job.actual_cost_usd, 4)} ({num(job.input_tokens)} in / {num(job.output_tokens)} out tokens).</div>
        </div>
      )}
      {job.error && <div className="notice warn">Last batch: {job.error}</div>}

      {!job.exam_id && (
        <section className="panel stack">
          <div className="spread">
            <h2 style={{ margin: 0 }}>1. Generate the missing questions</h2>
            <div className="btn-row">
              {running ? <button className="btn" onClick={() => { stopRef.current = true; }}>Stop after this batch</button> : <>
                <button className="btn" disabled={!aiAllowed || remaining === 0} onClick={() => void runBatches(false)}>Generate one batch</button>
                <button className="btn primary" disabled={!aiAllowed || remaining === 0} onClick={() => void runBatches(true)}>Generate all remaining</button>
              </>}
            </div>
          </div>
          {!aiAllowed && <p className="small muted">AI generation was turned off for this job; only bank questions are used.</p>}
          {running && <Loading label="Generating — each batch can take up to a minute…" />}
          {log.length > 0 && <pre className="code small" style={{ maxHeight: 160, overflowY: 'auto' }}>{log.join('\n')}</pre>}
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Blueprint slot</th><th>Need</th><th>From bank</th><th>Awaiting review</th><th>Approved</th><th>To generate</th></tr></thead>
            <tbody>{slots.map((s) => (
              <tr key={s.slot_id}><td className="small">{s.label}<div className="muted">{TYPE_LABEL[s.type]}</div></td>
                <td className="num">{s.count}</td><td className="num">{s.bank_ids?.length ?? 0}</td><td className="num">{s.pending}</td>
                <td className="num">{s.approved}</td><td className="num">{s.remaining}{(s.attempts ?? 0) >= 6 && s.remaining > 0 ? <span className="badge bad"> gave up</span> : ''}</td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      <section className="panel stack">
        <div className="spread">
          <h2 style={{ margin: 0 }}>2. Review generated questions</h2>
          {cleanDrafts.length > 0 && <button className="btn" onClick={() => void setStatus(cleanDrafts.map((q) => q.id), 'approved')}>Approve {cleanDrafts.length} that passed every check</button>}
        </div>
        <p className="small muted">Open each question to check the working before approving. Rejected questions are replaced the next time you generate.</p>
        {gen.loading && !gen.data ? <Loading /> : (gen.data ?? []).length === 0 ? <p className="muted">No generated questions yet.</p> : (
          <div className="table-wrap"><table className="data">
            <tbody>{(gen.data ?? []).map((q) => (
              <tr key={q.id}>
                <td style={{ width: '55%' }}><MathText className="clip small" text={q.statement} />
                  <div className="flag-list" style={{ marginTop: '0.3rem' }}>{(q.validation?.flags ?? []).map((f) => <span key={f} className={`badge ${CRITICAL.has(f) ? 'bad' : 'warn'}`}>{f.replace(/_/g, ' ')}</span>)}</div></td>
                <td className="small">{TYPE_LABEL[q.type]}<div className="muted">{DIFFICULTY_LABEL[q.difficulty]}</div></td>
                <td><span className={`badge ${q.status === 'approved' ? 'ok' : q.status === 'rejected' ? 'bad' : 'warn'}`}>{STATUS_LABEL[q.status]}</span></td>
                <td><div className="btn-row" style={{ flexWrap: 'nowrap' }}>
                  <Link className="btn sm" to={`/admin/questions/${q.id}`}>Review</Link>
                  {q.status !== 'approved' && <button className="btn sm" onClick={() => void setStatus([q.id], 'approved')}>Approve</button>}
                  {q.status !== 'rejected' && <button className="btn sm danger" onClick={() => void setStatus([q.id], 'rejected')}>Reject</button>}
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      {!job.exam_id && (
        <section className="panel spread">
          <div><h2 style={{ margin: 0 }}>3. Create the exam</h2><p className="small muted" style={{ margin: 0 }}>Builds a draft exam from the bank questions and every approved generated question.</p></div>
          <button className="btn primary lg" disabled={busy || running} onClick={() => void assemble(false)}>Create draft exam</button>
        </section>
      )}

      {assembleMissing && (
        <Confirm title="Some slots are not filled" confirmLabel="Create with what is available" busy={busy}
          onClose={() => setAssembleMissing(null)} onConfirm={() => { setAssembleMissing(null); void assemble(true); }}
          body={<div className="stack"><p>These parts of the blueprint do not have enough approved questions:</p>
            <ul className="small">{assembleMissing.map((m, i) => <li key={i}>{m.label}: {m.approved} of {m.needed} approved</li>)}</ul>
            <p className="small">You can approve or generate more first, or create the exam now and add questions by hand.</p></div>} />
      )}
    </div>
  );
}
