import { useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { rpc } from '../../lib/api';
import { DIFFICULTY_LABEL, fmtDate, STATUS_LABEL, TYPE_LABEL } from '../../lib/format';
import { Empty, ErrorNote, Loading, MathText, Modal, Pager, useAsync, useToast } from '../../lib/ui';
import { useTaxonomy } from './common';

interface Row {
  id: string; statement: string; type: string; difficulty: string; status: string; origin: string; marks: number;
  subject: string; chapter: string | null; topic: string | null; usage_count: number; flags: string[]; updated_at: string;
}

const LIMIT = 25;
const STATUS_BADGE: Record<string, string> = { approved: 'ok', rejected: 'bad', draft: 'warn', in_review: 'mark', archived: '' };

export default function Questions() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { tax } = useTaxonomy();
  const [offset, setOffset] = useState(0);
  const [showImport, setShowImport] = useState(false);
  const f = Object.fromEntries([...params.entries()].filter(([, v]) => v));
  const { data, error, loading, reload } = useAsync(
    () => rpc<{ total: number; items: Row[] }>('admin_list_questions', { p_filters: f, p_limit: LIMIT, p_offset: offset }),
    [params.toString(), offset],
  );

  const setF = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    if (k === 'subject_id') next.delete('chapter_id');
    setOffset(0);
    setParams(next, { replace: true });
  };

  const exportJson = async () => {
    try {
      const rows = await rpc<unknown[]>('admin_export_questions', { p_filters: { subject_id: f.subject_id, status: f.status } });
      const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `questions-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Exported ${rows.length} questions`);
    } catch (e) { toast((e as Error).message, true); }
  };

  const chapters = tax?.chapters.filter((c) => !f.subject_id || c.subject_id === f.subject_id) ?? [];

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Question bank</h1><p>Only approved questions can be used in published exams.</p></div>
        <div className="btn-row">
          <button className="btn" onClick={() => setShowImport(true)}>Import</button>
          <button className="btn" onClick={exportJson}>Export</button>
          <Link className="btn primary" to="/admin/questions/new">Add question</Link>
        </div>
      </div>

      <div className="filters">
        <input type="search" placeholder="Search text" defaultValue={f.q ?? ''} aria-label="Search question text"
          onKeyDown={(e) => { if (e.key === 'Enter') setF('q', (e.target as HTMLInputElement).value.trim()); }} />
        <select value={f.subject_id ?? ''} onChange={(e) => setF('subject_id', e.target.value)} aria-label="Subject">
          <option value="">All subjects</option>{tax?.subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={f.chapter_id ?? ''} onChange={(e) => setF('chapter_id', e.target.value)} aria-label="Chapter">
          <option value="">All chapters</option>{chapters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={f.type ?? ''} onChange={(e) => setF('type', e.target.value)} aria-label="Question type">
          <option value="">All types</option>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={f.difficulty ?? ''} onChange={(e) => setF('difficulty', e.target.value)} aria-label="Difficulty">
          <option value="">Any difficulty</option>{Object.entries(DIFFICULTY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={f.status ?? ''} onChange={(e) => setF('status', e.target.value)} aria-label="Status">
          <option value="">Active (not archived)</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={f.origin ?? ''} onChange={(e) => setF('origin', e.target.value)} aria-label="Source">
          <option value="">Any source</option><option value="manual">Written by hand</option><option value="ai">AI-generated</option><option value="import">Imported</option>
        </select>
      </div>

      <ErrorNote error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : data && (data.items.length === 0 ? (
        <div className="panel"><Empty title="No questions match">Change the filters, or <Link to="/admin/questions/new">add a question</Link>.</Empty></div>
      ) : (
        <div className="panel flush">
          <div className="table-wrap"><table className="data">
            <thead><tr><th style={{ width: '46%' }}>Question</th><th>Chapter</th><th>Type</th><th>Status</th><th>Used</th><th>Updated</th></tr></thead>
            <tbody>{data.items.map((q) => (
              <tr key={q.id} className="clickable" onClick={() => nav(`/admin/questions/${q.id}`)}>
                <td>
                  <MathText className="clip small" text={q.statement} />
                  {q.flags?.length > 0 && <div className="flag-list" style={{ marginTop: '0.3rem' }}>{q.flags.slice(0, 3).map((fl) => <span key={fl} className="badge warn">{fl.replace(/_/g, ' ')}</span>)}</div>}
                </td>
                <td className="small">{q.subject} · {q.chapter ?? '—'}{q.topic ? <div className="muted">{q.topic}</div> : null}</td>
                <td className="small">{TYPE_LABEL[q.type]}<div className="muted">{DIFFICULTY_LABEL[q.difficulty]}{q.origin === 'ai' ? ' · AI' : ''}</div></td>
                <td><span className={`badge ${STATUS_BADGE[q.status] ?? ''}`}>{STATUS_LABEL[q.status]}</span></td>
                <td className="num">{q.usage_count}</td>
                <td className="small num">{fmtDate(q.updated_at, false)}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <div style={{ padding: '0 1rem 1rem' }}><Pager total={data.total} limit={LIMIT} offset={offset} onChange={setOffset} /></div>
        </div>
      ))}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onDone={() => { setShowImport(false); reload(); }} />}
    </div>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: string[]; errors: { index: number; error: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setErr(null);
    let items: unknown;
    try { items = JSON.parse(text); } catch { setErr('This is not valid JSON. Check the format in docs/IMPORT_FORMAT.md.'); return; }
    if (!Array.isArray(items)) { setErr('The file must contain a JSON array of questions.'); return; }
    setBusy(true);
    try {
      const all = { imported: [] as string[], errors: [] as { index: number; error: string }[] };
      for (let i = 0; i < items.length; i += 200) {
        const r = await rpc<typeof all>('admin_import_questions', { p_items: items.slice(i, i + 200) });
        all.imported.push(...r.imported);
        all.errors.push(...r.errors.map((e) => ({ ...e, index: e.index + i })));
      }
      setResult(all);
      toast(`Imported ${all.imported.length} questions`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal title="Import questions" onClose={onClose} wide>
      <div className="stack">
        <p className="small">Paste or choose a JSON file in the documented import format (the same format Export produces). Imported questions are saved as drafts unless the item sets <span className="code">"status": "approved"</span>, which still runs the approval checks.</p>
        <div className="row">
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) setText(await file.text());
          }} />
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} placeholder='[{"subject_code": "PHY", "chapter_name": "Kinematics", "type": "single", ...}]' />
        <ErrorNote error={err} />
        {result && (
          <div className={`notice ${result.errors.length ? 'warn' : 'ok'}`}>
            {result.imported.length} imported, {result.errors.length} failed.
            {result.errors.length > 0 && <ul>{result.errors.slice(0, 20).map((e) => <li key={e.index}>Item {e.index}: {e.error}</li>)}</ul>}
          </div>
        )}
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          {result ? <button className="btn primary" onClick={onDone}>Done</button> : <>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={run} disabled={busy || !text.trim()}>{busy ? 'Importing…' : 'Import'}</button>
          </>}
        </div>
      </div>
    </Modal>
  );
}
