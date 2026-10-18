import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { friendlyError, rpc, signedUrl, uploadFile } from '../../lib/api';
import { DIFFICULTY_LABEL, fmtDate, STATUS_LABEL, TYPE_LABEL } from '../../lib/format';
import { ErrorNote, Loading, MathText, useToast } from '../../lib/ui';
import { useTaxonomy } from './common';

interface Q {
  id?: string; subject_id: string; chapter_id: string; topic_id: string; topic_name: string; subtopic: string;
  type: 'single' | 'multiple' | 'integer' | 'numerical'; difficulty: string; statement: string; image_path: string;
  marks: number; negative_marks: number; learning_objective: string; tags: string;
  options: { label: string; content: string }[]; correct: string[]; value: string; tolerance: string;
  useRange: boolean; min: string; max: string; solution: string; concepts: string;
  status?: string; origin?: string; validation?: { verdict?: string; flags?: string[]; errors?: string[]; checks?: Record<string, string>; model?: string; review_note?: string };
  source_refs?: { title: string; page_start: number | null; page_end: number | null }[]; problems?: string[];
  usage_count?: number; updated_at?: string;
}

const blank: Q = {
  subject_id: '', chapter_id: '', topic_id: '', topic_name: '', subtopic: '', type: 'single', difficulty: 'medium',
  statement: '', image_path: '', marks: 4, negative_marks: 1, learning_objective: '', tags: '',
  options: ['A', 'B', 'C', 'D'].map((label) => ({ label, content: '' })), correct: [], value: '', tolerance: '0',
  useRange: false, min: '', max: '', solution: '', concepts: '',
};
const LABELS = 'ABCDEF'.split('');

export default function QuestionEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { tax } = useTaxonomy();
  const [q, setQ] = useState<Q | null>(id ? null : blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [similar, setSimilar] = useState<{ id: string; similarity: number; statement: string; status: string }[] | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    rpc<Record<string, unknown>>('admin_get_question', { p_question: id }).then((d) => {
      const ans = (d.answer ?? {}) as { options?: string[]; value?: number; tolerance?: number; min?: number; max?: number };
      setQ({
        ...blank, id: d.id as string, subject_id: d.subject_id as string, chapter_id: (d.chapter_id as string) ?? '',
        topic_id: (d.topic_id as string) ?? '', subtopic: (d.subtopic as string) ?? '', type: d.type as Q['type'],
        difficulty: d.difficulty as string, statement: d.statement as string, image_path: (d.image_path as string) ?? '',
        marks: Number(d.marks), negative_marks: Number(d.negative_marks), learning_objective: (d.learning_objective as string) ?? '',
        tags: ((d.tags as string[]) ?? []).join(', '),
        options: ((d.options as Q['options']) ?? []).length ? (d.options as Q['options']) : blank.options,
        correct: ans.options ?? [], value: ans.value != null ? String(ans.value) : '', tolerance: String(ans.tolerance ?? 0),
        useRange: ans.min != null, min: ans.min != null ? String(ans.min) : '', max: ans.max != null ? String(ans.max) : '',
        solution: (d.solution as string) ?? '', concepts: (d.concepts as string) ?? '', status: d.status as string,
        origin: d.origin as string, validation: d.validation as Q['validation'], source_refs: d.source_refs as Q['source_refs'],
        problems: d.problems as string[], usage_count: d.usage_count as number, updated_at: d.updated_at as string,
      });
    }).catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    if (q?.image_path) void signedUrl('question-images', q.image_path).then(setImageUrl);
    else setImageUrl(null);
  }, [q?.image_path]);

  if (error && !q) return <ErrorNote error={error} />;
  if (!q || !tax) return <Loading />;

  const set = <K extends keyof Q>(k: K, v: Q[K]) => setQ((cur) => (cur ? { ...cur, [k]: v } : cur));
  const chapters = tax.chapters.filter((c) => c.subject_id === q.subject_id);
  const topics = tax.topics.filter((t) => t.chapter_id === q.chapter_id);
  const isMcq = q.type === 'single' || q.type === 'multiple';

  const payload = (status: string) => ({
    id: q.id, subject_id: q.subject_id, chapter_id: q.chapter_id || null,
    topic_id: q.topic_id && q.topic_id !== '__new' ? q.topic_id : null,
    topic_name: q.topic_id === '__new' ? q.topic_name : null,
    subtopic: q.subtopic || null, type: q.type, difficulty: q.difficulty, statement: q.statement,
    image_path: q.image_path || null, marks: q.marks, negative_marks: q.negative_marks,
    learning_objective: q.learning_objective || null,
    tags: q.tags.split(',').map((t) => t.trim()).filter(Boolean),
    options: isMcq ? q.options.filter((o) => o.content.trim()) : [],
    answer: isMcq ? { options: q.correct }
      : q.useRange ? { min: Number(q.min), max: Number(q.max) }
      : { value: q.value === '' ? null : Number(q.value), tolerance: Number(q.tolerance || 0) },
    solution: q.solution, concepts: q.concepts || null, status,
  });

  const save = async (status: 'draft' | 'approved') => {
    setError(null);
    if (!q.subject_id) { setError('Choose a subject.'); return; }
    if (q.statement.trim().length < 5) { setError('Write the question statement.'); return; }
    setBusy(true);
    try {
      const newId = await rpc<string>('admin_upsert_question', { p: payload(status) });
      toast(status === 'approved' ? 'Question saved and approved' : 'Draft saved');
      if (!q.id) nav(`/admin/questions/${newId}`, { replace: true });
      else {
        const d = await rpc<{ status: string; problems: string[]; updated_at: string }>('admin_get_question', { p_question: newId });
        setQ((cur) => (cur ? { ...cur, status: d.status, problems: d.problems, updated_at: d.updated_at } : cur));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const setStatus = async (status: string) => {
    if (!q.id) return;
    setBusy(true);
    try {
      await rpc('set_question_status', { p_question: q.id, p_status: status, p_note: null });
      set('status', status);
      toast(`Marked as ${STATUS_LABEL[status].toLowerCase()}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const checkSimilar = async () => {
    try {
      const rows = await rpc<{ id: string; similarity: number; statement: string; status: string }[]>('find_similar_questions',
        { p_statement: q.statement, p_subject: q.subject_id || null, p_threshold: 0.45, p_limit: 5 });
      setSimilar(rows.filter((r) => r.id !== q.id));
    } catch (e) { setError((e as Error).message); }
  };

  const uploadImage = async (file: File) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { setError('Use a PNG, JPEG, WebP or GIF image.'); return; }
    if (file.size > 5 * 1024 * 1024) { setError('Images must be 5 MB or smaller.'); return; }
    const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
    const path = `questions/${crypto.randomUUID()}.${ext}`;
    try { await uploadFile('question-images', path, file); } catch (e) { setError(friendlyError(e)); return; }
    set('image_path', path);
    toast('Image uploaded — save the question to keep it');
  };

  const v = q.validation;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{q.id ? 'Edit question' : 'New question'}</h1>
          {q.id && <p>{STATUS_LABEL[q.status ?? 'draft']} · {q.origin === 'ai' ? 'AI-generated' : q.origin === 'import' ? 'Imported' : 'Written by hand'} · used in {q.usage_count ?? 0} exam(s) · updated {fmtDate(q.updated_at)}</p>}
        </div>
        <Link className="btn" to="/admin/questions">Back to bank</Link>
      </div>

      {q.status === 'approved' && <div className="notice">Saving changes sends an approved question back to draft until you approve it again. Published exams keep their own copy and are not affected.</div>}
      {v && (v.flags?.length || v.checks) && (
        <section className={`notice ${v.verdict === 'pass' ? 'ok' : 'warn'}`}>
          <b>Automatic checks{v.model ? ` (${v.model})` : ''}: {v.verdict === 'pass' ? 'passed' : 'needs your review'}</b>
          {v.flags && v.flags.length > 0 && <div className="flag-list" style={{ margin: '0.4rem 0' }}>{v.flags.map((f) => <span key={f} className="badge warn">{f.replace(/_/g, ' ')}</span>)}</div>}
          {v.checks && <ul>{Object.entries(v.checks).map(([k, val]) => <li key={k}><b>{k}:</b> {val}</li>)}</ul>}
          <p className="small" style={{ margin: '0.4rem 0 0' }}>AI answers are never trusted automatically — solve the question yourself before approving.</p>
        </section>
      )}
      {q.problems && q.problems.length > 0 && (
        <div className="notice warn"><b>Before this can be approved:</b><ul>{q.problems.map((p) => <li key={p}>{p}</li>)}</ul></div>
      )}

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="panel stack">
          <div className="grid-2">
            <label className="field">Subject
              <select value={q.subject_id} onChange={(e) => setQ({ ...q, subject_id: e.target.value, chapter_id: '', topic_id: '' })}>
                <option value="">Choose…</option>{tax.subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select></label>
            <label className="field">Chapter
              <select value={q.chapter_id} onChange={(e) => setQ({ ...q, chapter_id: e.target.value, topic_id: '' })}>
                <option value="">Choose…</option>{chapters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
            <label className="field">Topic
              <select value={q.topic_id} onChange={(e) => set('topic_id', e.target.value)} disabled={!q.chapter_id}>
                <option value="">None</option>{topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                <option value="__new">+ New topic…</option>
              </select></label>
            {q.topic_id === '__new'
              ? <label className="field">New topic name<input type="text" value={q.topic_name} onChange={(e) => set('topic_name', e.target.value)} /></label>
              : <label className="field">Subtopic <small>optional</small><input type="text" value={q.subtopic} onChange={(e) => set('subtopic', e.target.value)} /></label>}
            <label className="field">Question type
              <select value={q.type} onChange={(e) => {
                const type = e.target.value as Q['type'];
                setQ({ ...q, type, correct: type === 'single' ? q.correct.slice(0, 1) : q.correct });
              }}>{Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field">Difficulty
              <select value={q.difficulty} onChange={(e) => set('difficulty', e.target.value)}>
                {Object.entries(DIFFICULTY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field">Marks if correct<input type="number" min={0.25} step={0.25} value={q.marks} onChange={(e) => set('marks', Number(e.target.value))} /></label>
            <label className="field">Marks deducted if wrong<input type="number" min={0} step={0.25} value={q.negative_marks} onChange={(e) => set('negative_marks', Number(e.target.value))} /></label>
          </div>

          <label className="field">Question <small>Use $…$ for inline maths and $$…$$ for display maths, e.g. {'$\\frac{1}{2}mv^2$'}.</small>
            <textarea rows={6} value={q.statement} onChange={(e) => set('statement', e.target.value)} onBlur={() => q.statement.length > 30 && void checkSimilar()} /></label>

          <div className="field">Figure <small>optional</small>
            <div className="row">
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImage(f); }} />
              {q.image_path && <button className="btn sm danger" onClick={() => set('image_path', '')}>Remove figure</button>}
            </div>
          </div>

          {isMcq ? (
            <div className="stack" style={{ gap: '0.6rem' }}>
              <div className="field">Options <small>{q.type === 'single' ? 'Select the one correct option.' : 'Tick every correct option.'}</small></div>
              {q.options.map((o, i) => (
                <div key={o.label} className="option-edit">
                  <label className="check">
                    <input type={q.type === 'single' ? 'radio' : 'checkbox'} name="correct" checked={q.correct.includes(o.label)}
                      onChange={(e) => set('correct', q.type === 'single' ? [o.label]
                        : e.target.checked ? [...q.correct, o.label].sort() : q.correct.filter((x) => x !== o.label))} />
                    <span className="lbl">{o.label}</span>
                  </label>
                  <input type="text" value={o.content} aria-label={`Option ${o.label}`}
                    onChange={(e) => set('options', q.options.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))} />
                  <button className="btn sm ghost" aria-label={`Remove option ${o.label}`} disabled={q.options.length <= 2}
                    onClick={() => {
                      const rest = q.options.filter((_, j) => j !== i).map((x, j) => ({ ...x, label: LABELS[j] }));
                      const remap = (l: string) => { const k = q.options.findIndex((x) => x.label === l); return k === i ? null : LABELS[k > i ? k - 1 : k]; };
                      setQ({ ...q, options: rest, correct: q.correct.map(remap).filter(Boolean) as string[] });
                    }}>Remove</button>
                </div>
              ))}
              {q.options.length < 6 && <button className="btn sm" style={{ justifySelf: 'start' }}
                onClick={() => set('options', [...q.options, { label: LABELS[q.options.length], content: '' }])}>Add option</button>}
            </div>
          ) : (
            <div className="stack" style={{ gap: '0.6rem' }}>
              {q.type === 'numerical' && <label className="check"><input type="checkbox" checked={q.useRange} onChange={(e) => set('useRange', e.target.checked)} /> Accept a range instead of value ± tolerance</label>}
              {q.useRange && q.type === 'numerical' ? (
                <div className="grid-2">
                  <label className="field">Lowest accepted<input type="number" step="any" value={q.min} onChange={(e) => set('min', e.target.value)} /></label>
                  <label className="field">Highest accepted<input type="number" step="any" value={q.max} onChange={(e) => set('max', e.target.value)} /></label>
                </div>
              ) : (
                <div className="grid-2">
                  <label className="field">Correct answer<input type="number" step={q.type === 'integer' ? 1 : 'any'} value={q.value} onChange={(e) => set('value', e.target.value)} /></label>
                  {q.type === 'numerical' && <label className="field">Tolerance (±)<input type="number" min={0} step="any" value={q.tolerance} onChange={(e) => set('tolerance', e.target.value)} /></label>}
                </div>
              )}
            </div>
          )}

          <label className="field">Step-by-step solution<textarea rows={6} value={q.solution} onChange={(e) => set('solution', e.target.value)} /></label>
          <label className="field">Concepts tested <small>optional, shown with the solution</small><textarea rows={3} value={q.concepts} onChange={(e) => set('concepts', e.target.value)} /></label>
          <div className="grid-2">
            <label className="field">Learning objective <small>optional</small><input type="text" value={q.learning_objective} onChange={(e) => set('learning_objective', e.target.value)} /></label>
            <label className="field">Tags <small>comma separated</small><input type="text" value={q.tags} onChange={(e) => set('tags', e.target.value)} /></label>
          </div>

          <ErrorNote error={error} />
          <div className="btn-row">
            <button className="btn" onClick={() => void save('draft')} disabled={busy}>Save draft</button>
            <button className="btn primary" onClick={() => void save('approved')} disabled={busy}>Save and approve</button>
            {q.id && q.status !== 'approved' && q.status !== 'rejected' && <button className="btn danger" onClick={() => void setStatus('rejected')} disabled={busy}>Reject</button>}
            {q.id && q.status !== 'archived' && <button className="btn ghost" onClick={() => void setStatus('archived')} disabled={busy}>Archive</button>}
            {q.id && q.status === 'archived' && <button className="btn" onClick={() => void setStatus('draft')} disabled={busy}>Restore as draft</button>}
          </div>
        </section>

        <section className="stack" style={{ position: 'sticky', top: 72 }}>
          <div className="panel">
            <h2>Student view</h2>
            <MathText className="read" text={q.statement || 'Question text appears here.'} />
            {imageUrl && <img src={imageUrl} alt="Question figure" style={{ maxWidth: '100%', marginTop: '0.5rem' }} />}
            {isMcq ? (
              <div className="options">{q.options.filter((o) => o.content).map((o) => (
                <div key={o.label} className={`option ${q.correct.includes(o.label) ? 'correct' : ''}`}><span /><span className="lbl">{o.label}</span><MathText as="span" className="read" text={o.content} /></div>
              ))}</div>
            ) : <p className="num" style={{ marginTop: '1rem' }}><b>Answer:</b> {q.useRange ? `${q.min} to ${q.max}` : `${q.value}${Number(q.tolerance) ? ` ± ${q.tolerance}` : ''}`}</p>}
            {q.solution && <div className="solution"><b>Solution</b><MathText className="read" text={q.solution} /></div>}
          </div>
          {similar && (
            <div className="panel">
              <h3>Similar questions in the bank</h3>
              {similar.length === 0 ? <p className="small muted">No close matches found.</p> : similar.map((s) => (
                <p key={s.id} className="small"><Link to={`/admin/questions/${s.id}`}>{Math.round(s.similarity * 100)}% similar</Link> ({STATUS_LABEL[s.status]}): <MathText as="span" text={s.statement} /></p>
              ))}
            </div>
          )}
          {q.source_refs && q.source_refs.length > 0 && (
            <div className="panel"><h3>Source material used</h3><ul className="small" style={{ paddingLeft: '1.1rem', margin: 0 }}>
              {q.source_refs.map((r, i) => <li key={i}>{r.title}{r.page_start ? `, p. ${r.page_start}${r.page_end && r.page_end !== r.page_start ? `–${r.page_end}` : ''}` : ''}</li>)}</ul></div>
          )}
        </section>
      </div>
    </div>
  );
}
