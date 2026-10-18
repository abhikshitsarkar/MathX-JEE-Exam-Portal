import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ScoreRows, TrendChart } from '../../components/Charts';
import { friendlyError, rpc } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDuration, num, pct } from '../../lib/format';
import { Confirm, Empty, ErrorNote, Loading, useAsync, useToast } from '../../lib/ui';
import type { AttemptListItem, ExamListItem, Performance } from './types';

export default function StudentDashboard() {
  const { profile } = useAuth();
  const { data, error, loading, reload } = useAsync(async () => {
    const [exams, attempts, perf] = await Promise.all([
      rpc<ExamListItem[]>('list_my_exams'), rpc<AttemptListItem[]>('list_my_attempts'), rpc<Performance>('my_performance'),
    ]);
    return { exams, attempts, perf };
  }, []);

  const toast = useToast();
  const [removing, setRemoving] = useState<ExamListItem | null>(null);
  const first = profile?.full_name?.split(' ')[0];
  const official = data?.exams.filter((e) => !e.is_mine) ?? [];
  const mine = data?.exams.filter((e) => e.is_mine) ?? [];
  const remove = async (e: ExamListItem) => {
    try { await rpc('practice_archive', { p_exam: e.exam_id }); toast('Paper removed from your list'); reload(); }
    catch (err) { toast(friendlyError(err), true); }
    setRemoving(null);
  };
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{first ? `Hello, ${first}` : 'Your tests'}</h1>
          <p>Pick a paper and start when you have the full time available. The timer keeps running if you close the page.</p>
        </div>
      </div>
      <ErrorNote error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : data && (
        <div className="dash-grid">
          <div className="stack">
            <section className="panel">
              <div className="panel-head"><h2>Available tests</h2></div>
              {official.length === 0 ? (
                <Empty title="No tests are published yet">New papers appear here as soon as your teacher publishes them.</Empty>
              ) : (
                <div className="exam-list">
                  {official.map((e) => <ExamRow key={e.version_id} e={e} />)}
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-head"><h2>My papers</h2><Link to="/make" className="btn sm primary">Make a paper</Link></div>
              {mine.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>Make your own practice paper from the chapters you choose. Only you can see your papers and your marks.</p>
              ) : (
                <div className="exam-list">
                  {mine.map((e) => <ExamRow key={e.version_id} e={e} onRemove={() => setRemoving(e)} />)}
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-head"><h2>Recent attempts</h2><Link to="/history" className="small">See all</Link></div>
              {data.attempts.length === 0 ? <p className="muted">Your attempts will appear here.</p> : (
                <div className="table-wrap"><table className="data"><thead><tr><th>Test</th><th>Date</th><th>Score</th><th /></tr></thead>
                  <tbody>{data.attempts.slice(0, 5).map((a) => (
                    <tr key={a.attempt_id}>
                      <td>{a.title}</td><td className="num">{fmtDate(a.started_at, false)}</td>
                      <td className="num">{a.status === 'in_progress' ? <span className="badge warn">In progress</span>
                        : a.released ? `${num(a.score)} / ${num(a.max_score)}` : <span className="badge">Result pending</span>}</td>
                      <td>{a.status === 'in_progress' ? <Link to={`/attempt/${a.attempt_id}`}>Resume</Link>
                        : <Link to={`/result/${a.attempt_id}`}>{a.released ? 'Analysis' : 'Details'}</Link>}</td>
                    </tr>))}
                  </tbody></table></div>
              )}
            </section>
          </div>

          <aside className="stack">
            <section className="panel">
              <div className="panel-head"><h2>Your progress</h2></div>
              {data.perf.attempts === 0 ? (
                <p className="muted">Analysis appears after your first result is released. It is built only from your own recorded answers.</p>
              ) : (
                <div className="stack">
                  <div className="grid-3">
                    <div className="stat"><b>{data.perf.attempts}</b><span>Tests analysed</span></div>
                    <div className="stat"><b>{pct(avg(data.perf.trend.map((t) => t.percentage)))}</b><span>Average score</span></div>
                    <div className="stat"><b>{data.perf.totals ? pct(accuracy(data.perf.totals)) : '—'}</b><span>Accuracy</span></div>
                  </div>
                  <TrendChart points={data.perf.trend.map((t) => ({ label: t.title, value: Number(t.percentage) }))} />
                  <h3>By subject</h3>
                  <ScoreRows rows={data.perf.by_subject.map((s) => ({ label: s.label, score: Number(s.score), max: Number(s.max_score), accuracy: s.accuracy }))} />
                </div>
              )}
            </section>
            {data.perf.weak_areas.length > 0 && (
              <section className="panel">
                <div className="panel-head"><h2>Revise next</h2></div>
                <p className="small muted">Chapters and topics where you have earned less than half the marks across at least two questions.</p>
                <ul style={{ paddingLeft: '1.1rem', margin: 0 }}>
                  {data.perf.weak_areas.map((w) => (
                    <li key={`${w.key}`} className="small" style={{ marginBottom: '0.3rem' }}>
                      <b>{w.label}</b> <span className="muted num">— {num(w.score)} of {num(w.max_score)} marks over {w.total} questions</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        </div>
      )}
      {removing && <Confirm title="Remove this paper?" confirmLabel="Remove" onClose={() => setRemoving(null)} onConfirm={() => void remove(removing)}
        body={<p>“{removing.title}” leaves your list. Your attempts and marks stay in My attempts.</p>} />}
    </div>
  );
}

function ExamRow({ e, onRemove }: { e: ExamListItem; onRemove?: () => void }) {
  const left = e.max_attempts - e.my_attempts;
  return (
    <article className="exam-item">
      <div>
        <h3>{e.title}</h3>
        <div className="exam-facts num">
          <span>{e.question_count} questions</span><span>{num(e.total_marks)} marks</span>
          <span>{fmtDuration(e.duration_minutes * 60)}</span>
          {e.closes_at && <span>Closes {fmtDate(e.closes_at)}</span>}
          {e.availability === 'upcoming' && <span>Opens {fmtDate(e.opens_at)}</span>}
        </div>
      </div>
      <div className="btn-row">
        {e.open_attempt_id ? (
          <Link className="btn primary" to={`/attempt/${e.open_attempt_id}`}>Resume test</Link>
        ) : e.availability === 'open' && left > 0 ? (
          <Link className="btn primary" to={`/exam/${e.version_id}`}>{e.my_attempts ? 'Attempt again' : 'View instructions'}</Link>
        ) : (
          <span className="badge">{e.availability === 'upcoming' ? 'Not open yet' : e.availability === 'closed' ? 'Closed' : 'No attempts left'}</span>
        )}
        {onRemove && !e.open_attempt_id && <button className="btn ghost sm" onClick={onRemove}>Remove</button>}
      </div>
    </article>
  );
}

function avg(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + Number(b || 0), 0) / xs.length : null; }
function accuracy(t: { correct: number; partial: number; incorrect: number }) {
  const n = t.correct + t.partial + t.incorrect;
  return n ? (100 * (t.correct + t.partial)) / n : null;
}
