import { Link } from 'react-router-dom';
import { rpc } from '../../lib/api';
import { fmtDate, num } from '../../lib/format';
import { ErrorNote, Loading, useAsync } from '../../lib/ui';

interface OverviewData {
  students: number; admins: number; questions: Record<string, number>; exams_published: number; exams_draft: number;
  attempts_in_progress: number; attempts_completed: number; documents: Record<string, number>;
  ai_cost_30d: number; ai_calls_30d: number; ai_failures_30d: number;
  recent_attempts: { id: string; status: string; started_at: string; email: string; full_name: string | null; title: string; score: number | null; max_score: number | null }[];
}

export default function Overview() {
  const { data, error, loading, reload } = useAsync(() => rpc<OverviewData>('admin_overview'), []);
  if (loading) return <Loading />;
  if (error || !data) return <ErrorNote error={error} onRetry={reload} />;
  const q = data.questions;
  const pendingReview = (q.draft ?? 0) + (q.in_review ?? 0);
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Overview</h1><p>What's happening across the portal.</p></div>
        <div className="btn-row"><Link className="btn" to="/admin/questions/new">Add a question</Link><Link className="btn primary" to="/admin/generate">Build a paper</Link></div>
      </div>
      <div className="grid-4">
        <div className="panel stat"><b>{data.students}</b><span>Registered students</span></div>
        <div className="panel stat"><b>{q.approved ?? 0}</b><span>Approved questions</span></div>
        <div className="panel stat"><b>{data.exams_published}</b><span>Published exams ({data.exams_draft} drafts)</span></div>
        <div className="panel stat"><b>{data.attempts_completed}</b><span>Completed attempts ({data.attempts_in_progress} in progress)</span></div>
      </div>
      {pendingReview > 0 && (
        <div className="notice warn spread"><span><b>{pendingReview}</b> question{pendingReview === 1 ? '' : 's'} waiting for review. Nothing reaches students until you approve it.</span>
          <Link className="btn sm" to="/admin/questions?status=draft">Review now</Link></div>
      )}
      <div className="grid-2">
        <section className="panel">
          <h2>AI usage, last 30 days</h2>
          <div className="grid-3">
            <div className="stat"><b>${num(data.ai_cost_30d, 4)}</b><span>Estimated cost</span></div>
            <div className="stat"><b>{data.ai_calls_30d}</b><span>Model calls</span></div>
            <div className="stat"><b>{data.ai_failures_30d}</b><span>Failed calls</span></div>
          </div>
          <p className="small muted" style={{ marginTop: '0.8rem' }}>Cost is estimated from token counts and the prices in Settings. Check your provider's dashboard for billed amounts.</p>
        </section>
        <section className="panel">
          <h2>Study material</h2>
          <div className="grid-3">
            <div className="stat"><b>{data.documents.ready ?? 0}</b><span>Indexed</span></div>
            <div className="stat"><b>{data.documents.needs_ocr ?? 0}</b><span>Need OCR</span></div>
            <div className="stat"><b>{data.documents.failed ?? 0}</b><span>Failed</span></div>
          </div>
          <p style={{ marginTop: '0.8rem' }}><Link to="/admin/documents">Manage study material</Link></p>
        </section>
      </div>
      <section className="panel flush">
        <div className="panel-head" style={{ padding: '1rem 1.2rem 0' }}><h2>Recent attempts</h2></div>
        {data.recent_attempts.length === 0 ? <p className="muted" style={{ padding: '0 1.2rem 1rem' }}>No attempts yet.</p> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Student</th><th>Exam</th><th>Started</th><th>Status</th><th>Score</th></tr></thead>
            <tbody>{data.recent_attempts.map((a) => (
              <tr key={a.id}><td>{a.full_name || a.email}</td><td>{a.title}</td><td className="num">{fmtDate(a.started_at)}</td>
                <td>{a.status === 'in_progress' ? <span className="badge warn">In progress</span> : <span className="badge ok">Submitted</span>}</td>
                <td className="num">{a.score != null ? `${num(a.score)} / ${num(a.max_score)}` : '—'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
