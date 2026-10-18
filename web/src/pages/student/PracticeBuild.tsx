import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { friendlyError, invokeAi, rpc } from '../../lib/api';
import { ErrorNote, Loading } from '../../lib/ui';

interface Slot { slot_id: string; label: string; count: number; approved: number; remaining: number; attempts?: number }
interface Progress { job: { id: string; exam_id: string | null; request: { title?: string; allow_ai?: boolean } }; slots: Slot[] }
interface Finish { ok: boolean; version_id?: string; missing?: { label: string; needed: number; have: number }[] }

type Phase =
  | { kind: 'working'; note: string }
  | { kind: 'stuck'; reason: string }
  | { kind: 'error'; message: string };

/**
 * Builds a student's own paper: asks the server for AI questions batch by
 * batch until every slot is filled, then publishes the paper privately and
 * opens its instructions page. The student never sees the questions or keys
 * before the test.
 */
export default function PracticeBuild() {
  const { jobId = '' } = useParams();
  const nav = useNavigate();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'working', note: 'Preparing your paper…' });
  const running = useRef(false);

  const load = useCallback(() => rpc<Progress>('generation_job_progress', { p_job: jobId }).then((p) => { setProgress(p); return p; }), [jobId]);

  const finish = useCallback(async (partial: boolean) => {
    setPhase({ kind: 'working', note: 'Putting your paper together…' });
    const r = await rpc<Finish>('practice_finish', { p_job: jobId, p_allow_partial: partial });
    if (r.ok && r.version_id) { nav(`/exam/${r.version_id}`, { replace: true }); return; }
    const short = (r.missing ?? []).reduce((a, m) => a + (m.needed - m.have), 0);
    setPhase({ kind: 'stuck', reason: `${short} question${short === 1 ? '' : 's'} could not be prepared — the question bank has too few for your choices, or new questions failed the automatic checks more than once.` });
  }, [jobId, nav]);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      let p = await load();
      if (p.job.exam_id) { await finish(false); return; }
      let failuresInARow = 0;
      for (let round = 0; round < 60; round++) {
        const remaining = p.slots.filter((s) => (s.attempts ?? 0) < 6).reduce((a, s) => a + s.remaining, 0);
        if (remaining === 0 || p.job.request?.allow_ai === false) break;
        setPhase({ kind: 'working', note: `Writing new questions… ${remaining} to go` });
        try {
          await invokeAi({ action: 'generate', job_id: jobId, practice: true });
          failuresInARow = 0;
        } catch (e) {
          const status = (e as Error & { status?: number }).status;
          if (status === 429) { setPhase({ kind: 'stuck', reason: (e as Error).message }); return; }
          if (status === 409) { await new Promise((r) => setTimeout(r, 4000)); }
          else if (++failuresInARow >= 3) { setPhase({ kind: 'error', message: friendlyError(e) }); return; }
        }
        p = await load();
      }
      await finish(false);
    } catch (e) {
      setPhase({ kind: 'error', message: friendlyError(e) });
    } finally {
      running.current = false;
    }
  }, [finish, jobId, load]);

  useEffect(() => { void run(); }, [run]);

  const total = progress?.slots.reduce((a, s) => a + s.count, 0) ?? 0;
  const ready = progress?.slots.reduce((a, s) => a + Math.min(s.count, s.approved), 0) ?? 0;

  return (
    <div className="page" style={{ maxWidth: 680 }}>
      <div className="page-head"><div><h1>{progress?.job.request?.title || 'Your paper'}</h1>
        <p>Your paper is being prepared. You can stay on this page; it opens by itself when it is ready.</p></div></div>
      <section className="panel stack">
        {total > 0 && (
          <div className="stack" style={{ gap: '0.4rem' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}><b>Questions ready</b><span className="num">{ready} / {total}</span></div>
            <div className="bar"><i style={{ width: `${total ? (100 * ready) / total : 0}%` }} /></div>
          </div>
        )}
        {phase.kind === 'working' && <Loading label={phase.note} />}
        {phase.kind === 'stuck' && (
          <div className="stack">
            <div className="notice warn">{phase.reason}</div>
            <div className="btn-row">
              {ready > 0 && <button className="btn primary" onClick={() => void finish(true).catch((e) => setPhase({ kind: 'error', message: friendlyError(e) }))}>Start with the {ready} question{ready === 1 ? '' : 's'} ready</button>}
              <button className="btn" onClick={() => void run()}>Try again</button>
              <Link className="btn ghost" to="/make">Make a different paper</Link>
            </div>
          </div>
        )}
        {phase.kind === 'error' && (
          <div className="stack">
            <ErrorNote error={phase.message} />
            <div className="btn-row"><button className="btn" onClick={() => void run()}>Try again</button><Link className="btn ghost" to="/">Back to tests</Link></div>
          </div>
        )}
      </section>
    </div>
  );
}
