import { Link } from 'react-router-dom';
import { rpc } from '../../lib/api';
import { fmtDate, fmtDuration, num, pct } from '../../lib/format';
import { Empty, ErrorNote, Loading, useAsync } from '../../lib/ui';
import type { AttemptListItem } from './types';

export default function History() {
  const { data, error, loading, reload } = useAsync(() => rpc<AttemptListItem[]>('list_my_attempts'), []);
  return (
    <div className="page">
      <div className="page-head"><div><h1>My attempts</h1><p>Every test you have started, newest first.</p></div></div>
      <ErrorNote error={error} onRetry={reload} />
      {loading ? <Loading /> : !data?.length ? (
        <div className="panel"><Empty title="No attempts yet"><p>Start a test from the <Link to="/">Tests</Link> page.</p></Empty></div>
      ) : (
        <div className="panel flush table-wrap">
          <table className="data">
            <thead><tr><th>Test</th><th>Started</th><th>Time used</th><th>Score</th><th>Percentage</th><th /></tr></thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.attempt_id}>
                  <td>{a.title}{a.attempt_no > 1 && <span className="muted small"> (attempt {a.attempt_no})</span>}</td>
                  <td className="num">{fmtDate(a.started_at)}</td>
                  <td className="num">{a.submitted_at ? fmtDuration((new Date(a.submitted_at).getTime() - new Date(a.started_at).getTime()) / 1000) : '—'}</td>
                  <td className="num">{a.status === 'in_progress' ? <span className="badge warn">In progress</span>
                    : a.released ? `${num(a.score)} / ${num(a.max_score)}` : <span className="badge">Pending release</span>}</td>
                  <td className="num">{a.released ? pct(a.percentage) : '—'}</td>
                  <td>{a.status === 'in_progress' ? <Link to={`/attempt/${a.attempt_id}`}>Resume</Link>
                    : <Link to={`/result/${a.attempt_id}`}>{a.released ? 'View analysis' : 'Status'}</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
