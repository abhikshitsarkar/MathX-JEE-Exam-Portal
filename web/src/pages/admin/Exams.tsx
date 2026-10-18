import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { friendlyError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, num } from '../../lib/format';
import { db } from '../../lib/db';
import { Empty, ErrorNote, Loading, Modal, useAsync } from '../../lib/ui';
import { type ExamTemplate, type MarkingScheme, must } from './common';

interface ExamRow {
  id: string; title: string; kind: string; is_archived: boolean; created_at: string;
  exam_versions: { id: string; version_no: number; status: string; total_marks: number; duration_minutes: number; published_at: string | null; closes_at: string | null }[];
}
const KIND_LABEL: Record<string, string> = { jee_main: 'JEE Main style', jee_advanced: 'JEE Advanced style', custom: 'Custom' };

export default function Exams() {
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const { data, error, loading, reload } = useAsync(() => must<ExamRow[]>(db.from('exams')
    .select('id, title, kind, is_archived, created_at, exam_versions(id, version_no, status, total_marks, duration_minutes, published_at, closes_at)')
    .is('owner_id', null).eq('is_archived', showArchived).order('created_at', { ascending: false }).limit(200)), [showArchived]);

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Exams</h1><p>Build papers by hand, or let the generator assemble one from the bank and AI.</p></div>
        <div className="btn-row">
          <label className="check small"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
          <button className="btn" onClick={() => setCreating(true)}>New empty exam</button>
          <Link className="btn primary" to="/admin/generate">Generate a paper</Link>
        </div>
      </div>
      <ErrorNote error={error} onRetry={reload} />
      {loading ? <Loading /> : !data?.length ? (
        <div className="panel"><Empty title={showArchived ? 'No archived exams' : 'No exams yet'}>Create one by hand or generate a paper.</Empty></div>
      ) : (
        <div className="panel flush table-wrap">
          <table className="data">
            <thead><tr><th>Exam</th><th>Status</th><th>Marks</th><th>Duration</th><th>Closes</th><th /></tr></thead>
            <tbody>{data.map((e) => {
              const versions = [...e.exam_versions].sort((a, b) => b.version_no - a.version_no);
              const live = versions.find((v) => v.status === 'published');
              const draft = versions.find((v) => v.status === 'draft');
              const shown = live ?? draft ?? versions[0];
              return (
                <tr key={e.id}>
                  <td><Link to={`/admin/exams/${e.id}`}><b>{e.title}</b></Link><div className="small muted">{KIND_LABEL[e.kind]} · created {fmtDate(e.created_at, false)}</div></td>
                  <td>{live && <span className="badge ok">Published v{live.version_no}</span>} {draft && <span className="badge warn">Draft v{draft.version_no}</span>}
                    {!live && !draft && <span className="badge">Archived</span>}</td>
                  <td className="num">{shown ? num(shown.total_marks) : '—'}</td>
                  <td className="num">{shown ? `${shown.duration_minutes} min` : '—'}</td>
                  <td className="num small">{fmtDate(shown?.closes_at)}</td>
                  <td>{live && <Link className="small" to={`/admin/reports/${live.id}`}>Results</Link>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {creating && <CreateExam onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateExam({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { session } = useAuth();
  const { data } = useAsync(async () => ({
    schemes: await must<MarkingScheme[]>(db.from('marking_schemes').select('*').eq('is_active', true).order('name')),
    templates: await must<ExamTemplate[]>(db.from('exam_templates').select('*').eq('is_active', true).order('name')),
  }), []);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('custom');
  const [scheme, setScheme] = useState('');
  const [duration, setDuration] = useState(180);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    if (!title.trim()) { setErr('Give the exam a name.'); return; }
    const rules = data?.schemes.find((s) => s.id === scheme)?.rules;
    if (!rules) { setErr('Choose a marking scheme.'); return; }
    setBusy(true);
    try {
      const exam = await must<{ id: string }>(db.from('exams').insert({ title: title.trim(), kind, created_by: session?.user.id }).select('id').single());
      await must(db.from('exam_versions').insert({
        exam_id: exam.id, version_no: 1, title: title.trim(), duration_minutes: duration, marking_rules: rules,
        sections: [{ key: 'PHY', title: 'Physics' }, { key: 'CHE', title: 'Chemistry' }, { key: 'MAT', title: 'Mathematics' }],
        created_by: session?.user.id,
      }));
      nav(`/admin/exams/${exam.id}`);
    } catch (e) { setErr(friendlyError(e)); setBusy(false); }
  };

  return (
    <Modal title="New exam" onClose={onClose}>
      <div className="stack">
        <label className="field">Name<input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weekly Test 4 — Mechanics" /></label>
        <div className="grid-2">
          <label className="field">Style<select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Duration (minutes)<input type="number" min={1} max={720} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></label>
        </div>
        <label className="field">Marking scheme <small>Copied into the exam; edit it later in the exam settings.</small>
          <select value={scheme} onChange={(e) => setScheme(e.target.value)}>
            <option value="">Choose…</option>{data?.schemes.map((s) => <option key={s.id} value={s.id}>{s.name} (v{s.version})</option>)}</select></label>
        <p className="small muted">Sections start as Physics, Chemistry and Mathematics. You add questions from the bank on the next screen.</p>
        <ErrorNote error={err} />
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create exam'}</button>
        </div>
      </div>
    </Modal>
  );
}
