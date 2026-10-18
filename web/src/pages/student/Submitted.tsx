import { Link, useParams } from 'react-router-dom';
import { rpc } from '../../lib/api';
import { fmtDate, RELEASE_LABEL } from '../../lib/format';
import { ErrorNote, Loading, useAsync } from '../../lib/ui';

interface Res { status: string; released: boolean; title?: string; submitted_at?: string; release_policy?: string; release_at?: string | null }

export default function Submitted() {
  const { attemptId } = useParams();
  const { data, error, loading } = useAsync(() => rpc<Res>('get_attempt_result', { p_attempt: attemptId }), [attemptId]);
  if (loading) return <div className="page"><Loading /></div>;
  return (
    <div className="page" style={{ maxWidth: 680 }}>
      <ErrorNote error={error} />
      {data && (
        <section className="panel stack" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
          <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden style={{ margin: '0 auto' }}>
            <circle cx="28" cy="28" r="26" fill="var(--ok-soft)" /><path d="M17 29 l7 7 l15 -16" fill="none" stroke="var(--ok)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h1>Test submitted</h1>
          <p>{data.status === 'auto_submitted' ? 'Time ran out, so your saved answers were submitted automatically.' : 'Your answers have been recorded.'}
            {data.submitted_at && <> Submitted {fmtDate(data.submitted_at)}.</>}</p>
          {data.released ? (
            <div className="btn-row" style={{ justifyContent: 'center' }}>
              <Link className="btn primary lg" to={`/result/${attemptId}`}>See your result</Link>
              <Link className="btn lg" to="/">Back to tests</Link>
            </div>
          ) : (
            <>
              <p className="muted">Results for this test are released {RELEASE_LABEL[data.release_policy ?? 'manual']?.toLowerCase()}
                {data.release_at ? ` (${fmtDate(data.release_at)})` : ''}. You'll find them under My attempts.</p>
              <div className="btn-row" style={{ justifyContent: 'center' }}><Link className="btn primary" to="/">Back to tests</Link></div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
