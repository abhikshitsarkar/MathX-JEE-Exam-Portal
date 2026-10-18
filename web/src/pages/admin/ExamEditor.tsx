import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { friendlyError, rpc } from '../../lib/api';
import { DIFFICULTY_LABEL, fmtDate, num, RELEASE_LABEL, STATUS_LABEL, TYPE_LABEL } from '../../lib/format';
import { db } from '../../lib/db';
import { Confirm, Empty, ErrorNote, Loading, MathText, Modal, useAsync, useToast } from '../../lib/ui';
import { fromLocalInput, must, type Rules, toLocalInput, useTaxonomy } from './common';

interface Version {
  id: string; exam_id: string; version_no: number; title: string; instructions: string; duration_minutes: number; total_marks: number;
  marking_rules: Rules; sections: { key: string; title: string }[]; release_policy: string; release_at: string | null;
  opens_at: string | null; closes_at: string | null; max_attempts: number; status: string; published_at: string | null;
}
interface EQ {
  id: string; position: number; section_key: string; question_id: string | null; marks: number; negative_marks: number;
  type: string | null; difficulty: string | null; content: { statement?: string } | null;
  questions: { statement: string; type: string; difficulty: string; status: string } | null;
}
const TYPES = ['single', 'multiple', 'integer', 'numerical'];

export default function ExamEditor() {
  const { examId } = useParams();
  const toast = useToast();
  const [versionId, setVersionId] = useState<string | null>(null);
  const exam = useAsync(async () => {
    const e = await must<{ id: string; title: string; kind: string; is_archived: boolean }>(db.from('exams').select('id, title, kind, is_archived').eq('id', examId).single());
    const versions = await must<Version[]>(db.from('exam_versions').select('*').eq('exam_id', examId).order('version_no', { ascending: false }));
    return { exam: e, versions };
  }, [examId]);

  useEffect(() => {
    const vs = exam.data?.versions;
    if (vs?.length && (!versionId || !vs.some((v) => v.id === versionId))) {
      setVersionId((vs.find((v) => v.status === 'draft') ?? vs.find((v) => v.status === 'published') ?? vs[0]).id);
    }
  }, [exam.data, versionId]);

  if (exam.loading && !exam.data) return <Loading />;
  if (exam.error || !exam.data) return <ErrorNote error={exam.error} onRetry={exam.reload} />;
  const v = exam.data.versions.find((x) => x.id === versionId);

  const newVersion = async () => {
    try {
      const id = await rpc<string>('create_draft_version', { p_exam: examId });
      toast('New draft version created');
      setVersionId(id);
      exam.reload();
    } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>{exam.data.exam.title}</h1><p>{exam.data.exam.is_archived ? 'Archived exam. ' : ''}Each published version is frozen; to change a live paper, create a new version.</p></div>
        <div className="btn-row">
          <Link className="btn" to="/admin/exams">All exams</Link>
          {!exam.data.versions.some((x) => x.status === 'draft') && <button className="btn" onClick={newVersion}>Create new version</button>}
        </div>
      </div>
      <div className="btn-row" role="tablist" aria-label="Versions">
        {exam.data.versions.map((x) => (
          <button key={x.id} role="tab" aria-selected={x.id === versionId} className={`btn sm ${x.id === versionId ? 'primary' : ''}`} onClick={() => setVersionId(x.id)}>
            Version {x.version_no} · {x.status === 'published' ? 'Published' : x.status === 'draft' ? 'Draft' : 'Archived'}
          </button>
        ))}
      </div>
      {v && <VersionPanel key={v.id} version={v} examArchived={exam.data.exam.is_archived} onChanged={exam.reload} />}
    </div>
  );
}

function VersionPanel({ version, examArchived, onChanged }: { version: Version; examArchived: boolean; onChanged: () => void }) {
  const toast = useToast();
  const draft = version.status === 'draft';
  const [form, setForm] = useState<Version>(version);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ position: number; problem: string }[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<null | 'publish' | 'unpublish' | 'archive' | 'release'>(null);
  const qs = useAsync(() => must<EQ[]>(db.from('exam_questions')
    .select('id, position, section_key, question_id, marks, negative_marks, type, difficulty, content, questions(statement, type, difficulty, status)')
    .eq('exam_version_id', version.id).order('position')), [version.id]);

  const set = <K extends keyof Version>(k: K, val: Version[K]) => setForm((f) => ({ ...f, [k]: val }));
  const totals = useMemo(() => {
    const rows = qs.data ?? [];
    return { count: rows.length, marks: rows.reduce((a, r) => a + Number(r.marks), 0) };
  }, [qs.data]);

  const saveSettings = async () => {
    setSaving(true);
    setErr(null);
    try {
      const patch = draft ? {
        title: form.title, instructions: form.instructions, duration_minutes: form.duration_minutes, marking_rules: form.marking_rules,
        sections: form.sections, release_policy: form.release_policy, release_at: form.release_at, opens_at: form.opens_at,
        closes_at: form.closes_at, max_attempts: form.max_attempts,
      } : { release_policy: form.release_policy, release_at: form.release_at, closes_at: form.closes_at };
      await must(db.from('exam_versions').update(patch).eq('id', version.id));
      if (draft) await must(db.from('exams').update({ title: form.title }).eq('id', version.exam_id));
      toast('Settings saved');
      onChanged();
    } catch (e) { setErr(friendlyError(e)); } finally { setSaving(false); }
  };

  const applySchemeMarks = async () => {
    try {
      for (const t of TYPES) {
        const r = form.marking_rules[t];
        if (!r) continue;
        await must(db.from('exam_questions').update({ marks: r.marks, negative_marks: r.negative }).eq('exam_version_id', version.id).eq('type', t));
      }
      toast('Marks updated from the scheme');
      qs.reload();
    } catch (e) { toast(friendlyError(e), true); }
  };

  const doConfirm = async () => {
    try {
      if (confirm === 'publish') {
        await saveSettings();
        const r = await rpc<{ published: boolean; issues?: { position: number; problem: string }[]; total_marks?: number }>('publish_exam_version', { p_version: version.id });
        if (!r.published) { setIssues(r.issues ?? []); toast('Fix the listed problems before publishing', true); }
        else { setIssues(null); toast(`Published · ${num(r.total_marks)} marks`); onChanged(); }
      } else if (confirm === 'unpublish') {
        await must(db.from('exam_versions').update({ status: 'archived' }).eq('id', version.id));
        toast('Unpublished'); onChanged();
      } else if (confirm === 'archive') {
        await must(db.from('exams').update({ is_archived: !examArchived }).eq('id', version.exam_id));
        toast(examArchived ? 'Exam restored' : 'Exam archived'); onChanged();
      } else if (confirm === 'release') {
        await rpc('release_results_now', { p_version: version.id });
        toast('Results released'); onChanged();
      }
    } catch (e) { toast(friendlyError(e), true); }
    setConfirm(null);
  };

  const rowUpdate = async (row: EQ, patch: Partial<EQ>) => {
    try { await must(db.from('exam_questions').update(patch).eq('id', row.id)); qs.reload(); }
    catch (e) { toast(friendlyError(e), true); }
  };

  return (
    <div className="stack">
      <div className="spread panel">
        <div className="row">
          <span className={`badge ${version.status === 'published' ? 'ok' : version.status === 'draft' ? 'warn' : ''}`}>{version.status === 'published' ? 'Published' : draft ? 'Draft' : 'Archived'}</span>
          <span className="num">{totals.count} questions · {num(totals.marks)} marks · {form.duration_minutes} min</span>
          {version.published_at && <span className="small muted">Published {fmtDate(version.published_at)}</span>}
        </div>
        <div className="btn-row">
          {draft && <button className="btn primary" onClick={() => setConfirm('publish')} disabled={!totals.count}>Publish</button>}
          {version.status === 'published' && <>
            <Link className="btn" to={`/admin/reports/${version.id}`}>Results</Link>
            {version.release_policy !== 'immediate' && <button className="btn" onClick={() => setConfirm('release')}>Release results now</button>}
            <button className="btn danger" onClick={() => setConfirm('unpublish')}>Unpublish</button>
          </>}
          <button className="btn ghost" onClick={() => setConfirm('archive')}>{examArchived ? 'Restore exam' : 'Archive exam'}</button>
        </div>
      </div>

      {issues && issues.length > 0 && (
        <div className="notice bad"><b>This version cannot be published yet:</b>
          <ul>{issues.map((i, k) => <li key={k}>Question {i.position}: {i.problem}</li>)}</ul></div>
      )}

      <section className="panel stack">
        <h2>Settings</h2>
        {!draft && <p className="small muted">This version is frozen. Only its closing time and result release can change.</p>}
        <div className="grid-3">
          <label className="field">Title<input type="text" value={form.title} disabled={!draft} onChange={(e) => set('title', e.target.value)} /></label>
          <label className="field">Duration (minutes)<input type="number" min={1} max={720} value={form.duration_minutes} disabled={!draft} onChange={(e) => set('duration_minutes', Number(e.target.value))} /></label>
          <label className="field">Attempts allowed per student<input type="number" min={1} max={50} value={form.max_attempts} disabled={!draft} onChange={(e) => set('max_attempts', Number(e.target.value))} /></label>
          <label className="field">Opens <small>empty = immediately</small><input type="datetime-local" value={toLocalInput(form.opens_at)} disabled={!draft} onChange={(e) => set('opens_at', fromLocalInput(e.target.value))} /></label>
          <label className="field">Closes <small>empty = never</small><input type="datetime-local" value={toLocalInput(form.closes_at)} onChange={(e) => set('closes_at', fromLocalInput(e.target.value))} /></label>
          <label className="field">Show results and solutions
            <select value={form.release_policy} onChange={(e) => set('release_policy', e.target.value)}>
              {Object.entries(RELEASE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {form.release_policy === 'scheduled' && <label className="field">Release time<input type="datetime-local" value={toLocalInput(form.release_at)} onChange={(e) => set('release_at', fromLocalInput(e.target.value))} /></label>}
        </div>
        <label className="field">Instructions shown before the test <small>maths allowed</small>
          <textarea rows={4} value={form.instructions} disabled={!draft} onChange={(e) => set('instructions', e.target.value)} style={{ fontFamily: 'var(--font-ui)' }} /></label>

        <div>
          <h3>Marking rules</h3>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Question type</th><th>Correct</th><th>Wrong (deduct)</th><th>Unanswered</th><th>Partial credit</th></tr></thead>
            <tbody>{TYPES.map((t) => {
              const r = form.marking_rules[t] ?? { marks: 4, negative: 0, unanswered: 0, partial: 'none' };
              const upd = (patch: Partial<typeof r>) => set('marking_rules', { ...form.marking_rules, [t]: { ...r, ...patch } });
              return (
                <tr key={t}><td>{TYPE_LABEL[t]}</td>
                  <td><input type="number" step={0.25} value={r.marks} disabled={!draft} onChange={(e) => upd({ marks: Number(e.target.value) })} /></td>
                  <td><input type="number" step={0.25} min={0} value={r.negative} disabled={!draft} onChange={(e) => upd({ negative: Number(e.target.value) })} /></td>
                  <td><input type="number" step={0.25} value={r.unanswered ?? 0} disabled={!draft} onChange={(e) => upd({ unanswered: Number(e.target.value) })} /></td>
                  <td>{t === 'multiple' ? (
                    <div className="row">
                      <select value={r.partial ?? 'none'} disabled={!draft} onChange={(e) => upd({ partial: e.target.value })}>
                        <option value="none">None (all or nothing)</option><option value="per_option">Per correct option chosen</option></select>
                      {r.partial === 'per_option' && <input type="number" step={0.25} style={{ width: 80 }} value={r.partial_per_option ?? 1} disabled={!draft} onChange={(e) => upd({ partial_per_option: Number(e.target.value) })} aria-label="Marks per correct option" />}
                    </div>) : <span className="muted small">—</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
          <p className="small muted">Correct and wrong marks set the defaults; each question can override them below. Partial credit applies only when no wrong option is chosen.</p>
        </div>

        {draft && (
          <div>
            <h3>Sections</h3>
            <div className="stack" style={{ gap: '0.4rem' }}>
              {form.sections.map((s, i) => (
                <div key={i} className="row">
                  <input type="text" style={{ maxWidth: 140 }} value={s.key} aria-label="Section key" onChange={(e) => set('sections', form.sections.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
                  <input type="text" style={{ maxWidth: 320 }} value={s.title} aria-label="Section title" onChange={(e) => set('sections', form.sections.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                  <button className="btn sm ghost" onClick={() => set('sections', form.sections.filter((_, j) => j !== i))}>Remove</button>
                </div>
              ))}
              <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => set('sections', [...form.sections, { key: `S${form.sections.length + 1}`, title: 'New section' }])}>Add section</button>
            </div>
          </div>
        )}
        <ErrorNote error={err} />
        <div className="btn-row"><button className="btn primary" onClick={saveSettings} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
          {draft && <button className="btn" onClick={applySchemeMarks}>Apply these marks to all questions</button>}</div>
      </section>

      <section className="panel flush">
        <div className="panel-head" style={{ padding: '1rem 1.2rem 0' }}>
          <h2>Questions</h2>
          {draft && <button className="btn primary" onClick={() => setAdding(true)}>Add from bank</button>}
        </div>
        {qs.loading && !qs.data ? <Loading /> : !qs.data?.length ? (
          <Empty title="No questions yet">{draft ? 'Add approved questions from the bank.' : ''}</Empty>
        ) : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>#</th><th>Section</th><th style={{ width: '42%' }}>Question</th><th>Type</th><th>+ / −</th>{draft && <th />}</tr></thead>
            <tbody>{qs.data.map((row, i) => {
              const text = row.content?.statement ?? row.questions?.statement ?? '(deleted from bank)';
              const type = row.type ?? row.questions?.type ?? '';
              return (
                <tr key={row.id}>
                  <td className="num">{row.position}</td>
                  <td>{draft ? (
                    <select value={row.section_key} onChange={(e) => void rowUpdate(row, { section_key: e.target.value })} aria-label="Section">
                      {[...new Set([...form.sections.map((s) => s.key), row.section_key])].map((k) => <option key={k} value={k}>{form.sections.find((s) => s.key === k)?.title ?? k}</option>)}
                    </select>) : <span className="small">{form.sections.find((s) => s.key === row.section_key)?.title ?? row.section_key}</span>}</td>
                  <td>
                    <MathText className="clip small" text={text} />
                    {draft && row.questions && row.questions.status !== 'approved' && <span className="badge warn">{STATUS_LABEL[row.questions.status]} in bank</span>}
                    {row.question_id && <Link className="small" to={`/admin/questions/${row.question_id}`}> Open</Link>}
                  </td>
                  <td className="small">{TYPE_LABEL[type]}<div className="muted">{DIFFICULTY_LABEL[row.difficulty ?? row.questions?.difficulty ?? ''] ?? ''}</div></td>
                  <td className="num">{draft ? (
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <input type="number" style={{ width: 70 }} step={0.25} defaultValue={row.marks} aria-label="Marks"
                        onBlur={(e) => Number(e.target.value) !== Number(row.marks) && void rowUpdate(row, { marks: Number(e.target.value) })} />
                      <input type="number" style={{ width: 70 }} step={0.25} min={0} defaultValue={row.negative_marks} aria-label="Negative marks"
                        onBlur={(e) => Number(e.target.value) !== Number(row.negative_marks) && void rowUpdate(row, { negative_marks: Number(e.target.value) })} />
                    </div>) : `+${num(row.marks)} / −${num(row.negative_marks)}`}</td>
                  {draft && <td><div className="btn-row" style={{ flexWrap: 'nowrap' }}>
                    <button className="btn sm ghost" disabled={i === 0} aria-label="Move up" onClick={() => void rpc('reorder_exam_question', { p_exam_question: row.id, p_direction: -1 }).then(qs.reload)}>↑</button>
                    <button className="btn sm ghost" disabled={i === qs.data!.length - 1} aria-label="Move down" onClick={() => void rpc('reorder_exam_question', { p_exam_question: row.id, p_direction: 1 }).then(qs.reload)}>↓</button>
                    <button className="btn sm ghost" onClick={() => void rpc('remove_exam_question', { p_exam_question: row.id }).then(qs.reload)}>Remove</button>
                  </div></td>}
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>

      {adding && <AddQuestions versionId={version.id} sections={form.sections} existing={new Set((qs.data ?? []).map((r) => r.question_id ?? ''))}
        onClose={() => setAdding(false)} onAdded={() => { setAdding(false); qs.reload(); }} />}
      {confirm && (
        <Confirm
          title={{ publish: 'Publish this version?', unpublish: 'Unpublish this version?', archive: examArchived ? 'Restore this exam?' : 'Archive this exam?', release: 'Release results now?' }[confirm]}
          body={{
            publish: 'Students will be able to start it immediately (or at the opening time). The questions, answer keys and marking are frozen once published.',
            unpublish: 'Students can no longer start it. Attempts already in progress can still be finished, and results stay available.',
            archive: examArchived ? 'The exam will appear in the main list again.' : 'The exam disappears from students’ lists. Results and attempts are kept.',
            release: 'Every submitted attempt will immediately show its score, answer key and solutions.',
          }[confirm]}
          confirmLabel={{ publish: 'Publish', unpublish: 'Unpublish', archive: examArchived ? 'Restore' : 'Archive', release: 'Release results' }[confirm]}
          danger={confirm === 'unpublish'}
          onClose={() => setConfirm(null)} onConfirm={() => void doConfirm()} />
      )}
    </div>
  );
}

function AddQuestions({ versionId, sections, existing, onClose, onAdded }: {
  versionId: string; sections: { key: string; title: string }[]; existing: Set<string>; onClose: () => void; onAdded: () => void;
}) {
  const { tax } = useTaxonomy();
  const toast = useToast();
  const [filters, setFilters] = useState<Record<string, string>>({ status: 'approved' });
  const [picked, setPicked] = useState<string[]>([]);
  const [section, setSection] = useState(sections[0]?.key ?? '');
  const [busy, setBusy] = useState(false);
  const list = useAsync(() => rpc<{ total: number; items: { id: string; statement: string; type: string; difficulty: string; chapter: string | null; subject: string; usage_count: number }[] }>(
    'admin_list_questions', { p_filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), p_limit: 100, p_offset: 0 }), [JSON.stringify(filters)]);
  const setF = (k: string, val: string) => setFilters((f) => ({ ...f, [k]: val, ...(k === 'subject_id' ? { chapter_id: '' } : {}) }));

  const add = async () => {
    setBusy(true);
    try {
      const n = await rpc<number>('add_questions_to_version', { p_version: versionId, p_question_ids: picked, p_section: section || null });
      toast(`Added ${n} question${n === 1 ? '' : 's'}`);
      onAdded();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };

  return (
    <Modal title="Add approved questions" onClose={onClose} wide>
      <div className="stack">
        <div className="filters">
          <input type="search" placeholder="Search text" onKeyDown={(e) => { if (e.key === 'Enter') setF('q', (e.target as HTMLInputElement).value); }} aria-label="Search" />
          <select value={filters.subject_id ?? ''} onChange={(e) => setF('subject_id', e.target.value)} aria-label="Subject"><option value="">All subjects</option>{tax?.subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <select value={filters.chapter_id ?? ''} onChange={(e) => setF('chapter_id', e.target.value)} aria-label="Chapter"><option value="">All chapters</option>{tax?.chapters.filter((c) => !filters.subject_id || c.subject_id === filters.subject_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select value={filters.type ?? ''} onChange={(e) => setF('type', e.target.value)} aria-label="Type"><option value="">All types</option>{TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select>
          <select value={filters.difficulty ?? ''} onChange={(e) => setF('difficulty', e.target.value)} aria-label="Difficulty"><option value="">Any difficulty</option>{Object.entries(DIFFICULTY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
        {list.loading ? <Loading /> : (
          <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}><table className="data">
            <tbody>{(list.data?.items ?? []).map((q) => {
              const inExam = existing.has(q.id);
              return (
                <tr key={q.id}>
                  <td><input type="checkbox" disabled={inExam} checked={picked.includes(q.id)} aria-label="Select question"
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, q.id] : p.filter((x) => x !== q.id)))} /></td>
                  <td><MathText className="clip small" text={q.statement} />{inExam && <span className="badge">Already in this exam</span>}</td>
                  <td className="small">{q.subject} · {q.chapter}<div className="muted">{TYPE_LABEL[q.type]} · {DIFFICULTY_LABEL[q.difficulty]} · used {q.usage_count}×</div></td>
                </tr>
              );
            })}</tbody>
          </table>{list.data?.items.length === 0 && <Empty title="No approved questions match" />}</div>
        )}
        <div className="spread">
          <label className="field" style={{ minWidth: 220 }}>Add to section
            <select value={section} onChange={(e) => setSection(e.target.value)}>{sections.map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}
              <option value="">Subject's own section</option></select></label>
          <div className="btn-row"><button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!picked.length || busy} onClick={add}>Add {picked.length || ''} question{picked.length === 1 ? '' : 's'}</button></div>
        </div>
      </div>
    </Modal>
  );
}
