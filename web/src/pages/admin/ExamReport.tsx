import { Link, useParams } from 'react-router-dom';
import { rpc } from '../../lib/api';
import { DIFFICULTY_LABEL, fmtDate, fmtDuration, num, pct, TYPE_LABEL } from '../../lib/format';
import { db } from '../../lib/db';
import { Empty, ErrorNote, Loading, MathText, useAsync } from '../../lib/ui';
import { must } from './common';

interface Report {
  summary: { attempts: number; avg: number | null; max: number | null; min: number | null; avg_pct: number | null; max_score: number | null };
  in_progress: number;
  attempts: { attempt_id: string; email: string; full_name: string | null; status: string; started_at: string; submitted_at: string | null;
    submit_reason: string | null; score: number | null; max_score: number | null; percentage: number | null; accuracy: number | null;
    time_taken_seconds: number | null; focus_losses: number }[];
  questions: { position: number; id: string; preview: string; type: string; difficulty: string; correct: number; partial: number; incorrect: number; unanswered: number }[];
}

export default function ExamReport() {
  const { versionId } = useParams();
  const { data, error, loading, reload } = useAsync(async () => {
    const [report, version] = await Promise.all([
      rpc<Report>('admin_exam_report', { p_version: versionId }),
      must<{ title: string; exam_id: string; version_no: number }>(db.from('exam_versions').select('title, exam_id, version_no').eq('id', versionId).single()),
    ]);
    return { report, version };
  }, [versionId]);

  const downloadCsv = () => {
    if (!data) return;
    const rows = [['Name', 'Email', 'Status', 'Started', 'Submitted', 'Score', 'Max', 'Percentage', 'Accuracy', 'Time (s)', 'Focus losses']];
    for (const a of data.report.attempts) rows.push([a.full_name ?? '', a.email, a.status, a.started_at, a.submitted_at ?? '', String(a.score ?? ''), String(a.max_score ?? ''),
      String(a.percentage ?? ''), String(a.accuracy ?? ''), String(a.time_taken_seconds ?? ''), String(a.focus_losses)]);
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${data.version.title.replace(/[^\w]+/g, '-')}-results.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (loading) return <Loading />;
  if (error || !data) return <ErrorNote error={error} onRetry={reload} />;
  const { report: r, version } = data;
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Results: {version.title}</h1><p>Version {version.version_no}. Scores are computed on the server from saved answers.</p></div>
        <div className="btn-row"><Link className="btn" to={`/admin/exams/${version.exam_id}`}>Exam settings</Link><button className="btn" onClick={downloadCsv} disabled={!r.attempts.length}>Download CSV</button></div>
      </div>
      <div className="grid-4">
        <div className="panel stat"><b>{r.summary.attempts}</b><span>Submitted ({r.in_progress} in progress)</span></div>
        <div className="panel stat"><b>{r.summary.avg != null ? num(r.summary.avg) : '—'}</b><span>Average score{r.summary.max_score ? ` of ${num(r.summary.max_score)}` : ''}</span></div>
        <div className="panel stat"><b>{r.summary.max != null ? num(r.summary.max) : '—'}</b><span>Highest score</span></div>
        <div className="panel stat"><b>{pct(r.summary.avg_pct)}</b><span>Average percentage</span></div>
      </div>
      <section className="panel flush">
        <div className="panel-head" style={{ padding: '1rem 1.2rem 0' }}><h2>Students</h2></div>
        {r.attempts.length === 0 ? <Empty title="No attempts yet" /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Student</th><th>Score</th><th>Accuracy</th><th>Time</th><th>Submitted</th><th title="Times the student switched away from the test tab">Tab switches</th></tr></thead>
            <tbody>{r.attempts.map((a) => (
              <tr key={a.attempt_id}>
                <td>{a.full_name || a.email}<div className="small muted">{a.email}</div></td>
                <td className="num">{a.score != null ? `${num(a.score)} / ${num(a.max_score)}` : <span className="badge warn">In progress</span>}</td>
                <td className="num">{pct(a.accuracy)}</td><td className="num">{fmtDuration(a.time_taken_seconds)}</td>
                <td className="small num">{fmtDate(a.submitted_at)}{a.submit_reason && a.submit_reason !== 'manual' ? <div className="muted">auto ({a.submit_reason})</div> : null}</td>
                <td className="num">{a.focus_losses || 0}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <p className="small muted" style={{ padding: '0 1.2rem 1rem' }}>Tab switches are reported by the student's browser and can be missed or blocked; treat them as a signal, not proof.</p>
      </section>
      <section className="panel flush">
        <div className="panel-head" style={{ padding: '1rem 1.2rem 0' }}><h2>Question analysis</h2></div>
        <div className="table-wrap"><table className="data">
          <thead><tr><th>#</th><th style={{ width: '45%' }}>Question</th><th>Type</th><th>Correct</th><th>Partial</th><th>Wrong</th><th>Skipped</th></tr></thead>
          <tbody>{r.questions.map((q) => {
            const n = q.correct + q.partial + q.incorrect + q.unanswered;
            return (
              <tr key={q.id}><td className="num">{q.position}</td><td><MathText className="clip small" text={q.preview} /></td>
                <td className="small">{TYPE_LABEL[q.type]}<div className="muted">{DIFFICULTY_LABEL[q.difficulty]}</div></td>
                <td className="num">{q.correct}{n ? <span className="muted small"> ({Math.round((100 * q.correct) / n)}%)</span> : null}</td>
                <td className="num">{q.partial}</td><td className="num">{q.incorrect}</td><td className="num">{q.unanswered}</td></tr>
            );
          })}</tbody>
        </table></div>
      </section>
    </div>
  );
}
