import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ScoreRows } from '../../components/Charts';
import { rpc, signedUrl } from '../../lib/api';
import { answerText, DIFFICULTY_LABEL, fmtDate, fmtDuration, num, pct, RELEASE_LABEL, TYPE_LABEL } from '../../lib/format';
import { ErrorNote, Loading, MathText, useAsync } from '../../lib/ui';
import type { Breakdown } from './types';

interface ReviewQ {
  id: string; position: number; section_key: string; type: string; subject: string | null; chapter: string | null; topic: string | null;
  difficulty: string | null; marks: number; negative_marks: number; statement: string; image_path: string | null;
  options: { label: string; content: string }[]; your_answer: { options?: string[]; value?: string } | null; state: string;
  time_spent: number | null; correct_answer: { options?: string[]; value?: number; tolerance?: number; min?: number; max?: number };
  solution: string | null; concepts: string | null; outcome: string; awarded: number;
}
interface ResultData {
  status: string; released: boolean; title: string; submitted_at?: string; started_at?: string; submit_reason?: string;
  release_policy?: string; release_at?: string | null;
  result?: { score: number; max_score: number; correct: number; incorrect: number; partial: number; unanswered: number;
    accuracy: number | null; percentage: number | null; time_taken_seconds: number | null;
    breakdown: { subject?: Breakdown[]; chapter?: Breakdown[]; topic?: Breakdown[]; difficulty?: Breakdown[] } };
  questions?: ReviewQ[];
}

const OUTCOME_LABEL: Record<string, string> = { correct: 'Correct', incorrect: 'Incorrect', partial: 'Partially correct', unanswered: 'Not answered' };
type Filter = 'all' | 'incorrect' | 'unanswered' | 'correct' | 'partial';

export default function Result() {
  const { attemptId } = useParams();
  const { data, error, loading } = useAsync(() => rpc<ResultData>('get_attempt_result', { p_attempt: attemptId }), [attemptId]);
  const [filter, setFilter] = useState<Filter>('all');
  const [images, setImages] = useState<Record<string, string>>({});

  useEffect(() => {
    const paths = [...new Set((data?.questions ?? []).map((q) => q.image_path).filter(Boolean) as string[])];
    for (const p of paths) void signedUrl('question-images', p).then((u) => { if (u) setImages((m) => ({ ...m, [p]: u })); });
  }, [data]);

  const shown = useMemo(() => (data?.questions ?? []).filter((q) => filter === 'all' || q.outcome === filter), [data, filter]);

  if (loading) return <div className="page"><Loading /></div>;
  if (error || !data) return <div className="page"><ErrorNote error={error ?? 'Result not found'} /></div>;
  if (data.status === 'in_progress') {
    return <div className="page"><div className="notice">This test is still in progress. <Link to={`/attempt/${attemptId}`}>Resume it</Link>.</div></div>;
  }
  if (!data.released || !data.result) {
    return (
      <div className="page" style={{ maxWidth: 680 }}>
        <div className="panel">
          <h1>{data.title}</h1>
          <p>Submitted {fmtDate(data.submitted_at)}. Results are released {RELEASE_LABEL[data.release_policy ?? 'manual']?.toLowerCase()}
            {data.release_at ? `, on ${fmtDate(data.release_at)}` : ''}.</p>
          <Link className="btn" to="/history">Back to my attempts</Link>
        </div>
      </div>
    );
  }

  const r = data.result;
  const b = r.breakdown ?? {};

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{data.title}</h1><p>Submitted {fmtDate(data.submitted_at)}{data.status === 'auto_submitted' ? ' (time ran out)' : ''}</p></div>
        <Link className="btn" to="/history">All attempts</Link>
      </div>

      <section className="panel score-hero" style={{ marginBottom: '1.25rem' }}>
        <div className="score-big num">{num(r.score)}<small> / {num(r.max_score)}</small></div>
        <div className="grid-4">
          <div className="stat"><b>{pct(r.percentage)}</b><span>Score</span></div>
          <div className="stat"><b>{pct(r.accuracy)}</b><span>Accuracy of attempted</span></div>
          <div className="stat"><b className="num">{r.correct}<span className="muted small"> / {r.incorrect} / {r.partial} / {r.unanswered}</span></b><span>Correct / wrong / partial / skipped</span></div>
          <div className="stat"><b>{fmtDuration(r.time_taken_seconds)}</b><span>Time used</span></div>
        </div>
      </section>

      <div className="grid-2" style={{ marginBottom: '1.25rem' }}>
        <section className="panel">
          <h2>By subject</h2>
          <ScoreRows rows={(b.subject ?? []).map((x) => ({ label: x.label, score: Number(x.score), max: Number(x.max) }))} />
          <h3 style={{ marginTop: '1.2rem' }}>By difficulty</h3>
          <ScoreRows rows={(b.difficulty ?? []).map((x) => ({ label: DIFFICULTY_LABEL[x.label] ?? x.label, score: Number(x.score), max: Number(x.max) }))} />
        </section>
        <section className="panel">
          <h2>By chapter</h2>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Chapter</th><th>Marks</th><th>✓ / ✗ / –</th><th>Time</th></tr></thead>
            <tbody>{(b.chapter ?? []).slice().sort((x, y) => Number(x.score) / Number(x.max || 1) - Number(y.score) / Number(y.max || 1)).map((c) => (
              <tr key={c.key ?? c.label}><td>{c.label}</td><td className="num">{num(c.score)} / {num(c.max)}</td>
                <td className="num">{c.correct + c.partial} / {c.incorrect} / {c.unanswered}</td><td className="num">{fmtDuration(c.time_spent)}</td></tr>
            ))}</tbody>
          </table></div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Questions and solutions</h2>
          <div className="btn-row" role="group" aria-label="Filter questions">
            {(['all', 'incorrect', 'partial', 'unanswered', 'correct'] as Filter[]).map((f) => (
              <button key={f} className={`btn sm ${filter === f ? 'primary' : ''}`} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : OUTCOME_LABEL[f]} ({(data.questions ?? []).filter((q) => f === 'all' || q.outcome === f).length})
              </button>
            ))}
          </div>
        </div>
        {shown.map((q) => {
          const correctSet = new Set(q.correct_answer?.options ?? []);
          const mine = new Set(q.your_answer?.options ?? []);
          return (
            <article key={q.id} className="review-q">
              <div className="spread" style={{ marginBottom: '0.6rem' }}>
                <h3 style={{ margin: 0 }}><span className="qnum">Q{q.position}</span>
                  <span className={`outcome-${q.outcome}`}>{OUTCOME_LABEL[q.outcome]} ({Number(q.awarded) > 0 ? '+' : ''}{num(q.awarded)})</span></h3>
                <div className="flag-list small">
                  <span className="badge">{q.subject}</span>{q.chapter && <span className="badge">{q.chapter}</span>}
                  <span className="badge">{TYPE_LABEL[q.type]}</span>{q.difficulty && <span className="badge">{DIFFICULTY_LABEL[q.difficulty]}</span>}
                  {q.time_spent ? <span className="badge num">{fmtDuration(q.time_spent)}</span> : null}
                </div>
              </div>
              <MathText className="read qtext" text={q.statement} />
              {q.image_path && images[q.image_path] && <img className="qimg" src={images[q.image_path]} alt="Figure" style={{ maxWidth: '100%' }} />}
              {q.options.length > 0 ? (
                <div className="options">
                  {q.options.map((o) => (
                    <div key={o.label} className={`option ${correctSet.has(o.label) ? 'correct' : mine.has(o.label) ? 'wrong' : ''}`}>
                      <span className="small" style={{ minWidth: '4.5rem' }}>{correctSet.has(o.label) ? 'Correct' : mine.has(o.label) ? 'Your pick' : ''}{correctSet.has(o.label) && mine.has(o.label) ? ' · yours' : ''}</span>
                      <span className="lbl">{o.label}</span><MathText as="span" className="read" text={o.content} />
                    </div>
                  ))}
                </div>
              ) : (
                <dl className="kv" style={{ marginTop: '1rem' }}>
                  <dt>Your answer</dt><dd className="num">{answerText(q.type, q.your_answer)}</dd>
                  <dt>Correct answer</dt><dd className="num">{answerText(q.type, q.correct_answer as { value?: unknown })}</dd>
                </dl>
              )}
              {q.solution && <div className="solution"><b>Solution</b><MathText className="read" text={q.solution} />
                {q.concepts && <><b>Concepts</b><MathText className="read" text={q.concepts} /></>}</div>}
            </article>
          );
        })}
      </section>
    </div>
  );
}
