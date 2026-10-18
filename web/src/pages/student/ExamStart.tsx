import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { rpc } from '../../lib/api';
import { fmtDate, fmtDuration, num, RELEASE_LABEL, TYPE_LABEL } from '../../lib/format';
import { ErrorNote, Loading, MathText, useAsync } from '../../lib/ui';

interface Overview {
  version_id: string; title: string; instructions: string; duration_minutes: number; total_marks: number;
  marking_rules: Record<string, { unanswered?: number; partial?: string; partial_per_option?: number }>;
  release_policy: string; opens_at: string | null; closes_at: string | null; max_attempts: number; server_now: string;
  my_attempts: number; open_attempt_id: string | null;
  sections: { key: string; title: string; questions: number; marks: number; types: { type: string; marks: number; negative: number }[] }[];
}

export default function ExamStart() {
  const { versionId } = useParams();
  const nav = useNavigate();
  const { data, error, loading } = useAsync(() => rpc<Overview>('get_exam_overview', { p_version: versionId }), [versionId]);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setStartError(null);
    try {
      const r = await rpc<{ attempt_id: string }>('start_attempt', { p_version: versionId });
      nav(`/attempt/${r.attempt_id}`, { replace: true });
    } catch (e) {
      setStartError((e as Error).message);
      setBusy(false);
    }
  };

  if (loading) return <div className="page"><Loading /></div>;
  if (error || !data) return <div className="page"><ErrorNote error={error ?? 'Not found'} /><p><Link to="/">Back to tests</Link></p></div>;

  const totalQ = data.sections.reduce((a, s) => a + s.questions, 0);
  const left = data.max_attempts - data.my_attempts;
  const deadlineCut = data.closes_at && new Date(data.closes_at).getTime() - new Date(data.server_now).getTime() < data.duration_minutes * 60000;

  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div>
          <h1>{data.title}</h1>
          <p className="num">{totalQ} questions · {num(data.total_marks)} marks · {fmtDuration(data.duration_minutes * 60)}</p>
        </div>
      </div>
      <div className="stack">
        <section className="panel">
          <h2>Paper structure</h2>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Section</th><th>Questions</th><th>Type</th><th>Marking</th></tr></thead>
              <tbody>
                {data.sections.map((s) => (
                  <tr key={s.key}>
                    <td>{s.title}</td><td className="num">{s.questions}</td>
                    <td>{[...new Set(s.types.map((t) => TYPE_LABEL[t.type]))].join(', ')}</td>
                    <td className="num small">{s.types.map((t, i) => (
                      <div key={i}>+{num(t.marks)} correct, {Number(t.negative) ? `−${num(t.negative)}` : 'no penalty'} wrong
                        {t.type === 'multiple' && data.marking_rules.multiple?.partial === 'per_option'
                          ? `, +${num(data.marking_rules.multiple.partial_per_option ?? 1)} per correct option if no wrong option is chosen` : ''}</div>
                    ))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {data.instructions && (
          <section className="panel"><h2>Instructions from your teacher</h2><MathText className="read" text={data.instructions} /></section>
        )}

        <section className="panel">
          <h2>How the test works</h2>
          <ul style={{ paddingLeft: '1.2rem', margin: 0 }} className="stack small">
            <li>The clock starts when you press <b>Start test</b> and is kept by the server. Closing the page, refreshing or changing your computer's time does not pause it.</li>
            <li>An answer counts only after you press <b>Save &amp; Next</b> or <b>Save &amp; Mark for Review</b>. Saved answers are stored on the server as you go.</li>
            <li>Questions marked for review without an answer are not evaluated. Answered questions that are also marked for review are evaluated.</li>
            <li>When time runs out, your saved answers are submitted automatically.</li>
            <li>Results and solutions are released {RELEASE_LABEL[data.release_policy]?.toLowerCase()}.</li>
            {deadlineCut && <li><b>This test closes on {fmtDate(data.closes_at)}, before the full duration — your time will end then.</b></li>}
          </ul>
          <div className="row" style={{ marginTop: '1rem' }}>
            <span className="badge num">{left} of {data.max_attempts} attempt{data.max_attempts === 1 ? '' : 's'} left</span>
          </div>
        </section>

        <ErrorNote error={startError} />
        <div className="panel spread">
          {data.open_attempt_id ? (
            <><span>You have a test in progress.</span><Link className="btn primary lg" to={`/attempt/${data.open_attempt_id}`}>Resume test</Link></>
          ) : (
            <>
              <label className="check"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                I have read the instructions and will attempt this test on my own.</label>
              <button className="btn primary lg" disabled={!agreed || busy || left <= 0} onClick={start}>
                {busy ? 'Starting…' : 'Start test'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
