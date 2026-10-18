import { useEffect, useState } from 'react';
import { friendlyError, invokeAi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { TYPE_LABEL } from '../../lib/format';
import { db } from '../../lib/db';
import { ErrorNote, Loading, Modal, useAsync, useToast } from '../../lib/ui';
import { type ExamTemplate, type MarkingScheme, must, type Rules, useTaxonomy } from './common';

interface AiSettings {
  provider: string; model: string; base_url: string | null; max_output_tokens: number; temperature: number | null;
  price_input_per_mtok: number; price_output_per_mtok: number; batch_size: number; max_questions_per_job: number;
  daily_question_quota: number; monthly_budget_usd: number; context_chunks: number; student_daily_questions?: number;
}

export default function Settings() {
  const [tab, setTab] = useState<'ai' | 'schemes' | 'templates' | 'syllabus'>('ai');
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Settings</h1><p>Runtime configuration. Changes apply immediately — no rebuild needed.</p></div></div>
      <div className="btn-row" role="tablist">
        {([['ai', 'AI provider'], ['schemes', 'Marking schemes'], ['templates', 'Exam templates'], ['syllabus', 'Syllabus']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`btn sm ${tab === k ? 'primary' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'ai' && <AiPanel />}
      {tab === 'schemes' && <SchemesPanel />}
      {tab === 'templates' && <TemplatesPanel />}
      {tab === 'syllabus' && <SyllabusPanel />}
    </div>
  );
}

function AiPanel() {
  const toast = useToast();
  const { session } = useAuth();
  const s = useAsync(() => must<{ value: AiSettings }>(db.from('app_settings').select('value').eq('key', 'ai').single()), []);
  const status = useAsync(() => invokeAi<{ provider: string; model: string; has_key: boolean }>({ action: 'status' }), []);
  const [f, setF] = useState<AiSettings | null>(null);
  useEffect(() => { if (s.data) setF(s.data.value); }, [s.data]);
  if (s.loading || !f) return <Loading />;
  const set = <K extends keyof AiSettings>(k: K, v: AiSettings[K]) => setF({ ...f, [k]: v });
  const n = (k: keyof AiSettings) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never);

  const save = async () => {
    try {
      await must(db.from('app_settings').update({ value: f, updated_by: session?.user.id, updated_at: new Date().toISOString() }).eq('key', 'ai'));
      toast('AI settings saved');
      status.reload();
    } catch (e) { toast(friendlyError(e), true); }
  };

  return (
    <section className="panel stack">
      {status.data ? (
        <div className={`notice ${status.data.provider === 'mock' || status.data.has_key ? 'ok' : 'bad'}`}>
          Server status: provider <b>{status.data.provider}</b>{status.data.provider !== 'mock' && <> — API key {status.data.has_key ? 'configured' : <b>missing</b>}</>}.
        </div>
      ) : status.error ? <div className="notice bad">The <span className="code">api</span> Neon Function is not reachable: {status.error}</div> : null}
      <div className="grid-3">
        <label className="field">Provider
          <select value={f.provider} onChange={(e) => set('provider', e.target.value)}>
            <option value="mock">Mock (free, placeholder questions)</option>
            <option value="anthropic">Anthropic Claude API</option>
            <option value="openai_compatible">OpenAI-compatible API</option>
          </select></label>
        <label className="field">Model ID<input type="text" value={f.model} onChange={(e) => set('model', e.target.value)} /></label>
        {f.provider === 'openai_compatible' && <label className="field">Base URL <small>ending in /v1</small><input type="text" value={f.base_url ?? ''} onChange={(e) => set('base_url', e.target.value || null)} /></label>}
        <label className="field">Max output tokens per call<input type="number" min={500} value={f.max_output_tokens} onChange={n('max_output_tokens')} /></label>
        <label className="field">Temperature <small>empty = provider default</small><input type="number" step={0.1} min={0} max={1} value={f.temperature ?? ''} onChange={(e) => set('temperature', e.target.value === '' ? null : Number(e.target.value))} /></label>
        <label className="field">Questions per batch<input type="number" min={1} max={10} value={f.batch_size} onChange={n('batch_size')} /></label>
        <label className="field">Study excerpts per batch<input type="number" min={0} max={20} value={f.context_chunks} onChange={n('context_chunks')} /></label>
        <label className="field">Input price ($ per million tokens)<input type="number" step="any" min={0} value={f.price_input_per_mtok} onChange={n('price_input_per_mtok')} /></label>
        <label className="field">Output price ($ per million tokens)<input type="number" step="any" min={0} value={f.price_output_per_mtok} onChange={n('price_output_per_mtok')} /></label>
        <label className="field">Max new questions per paper<input type="number" min={1} value={f.max_questions_per_job} onChange={n('max_questions_per_job')} /></label>
        <label className="field">Daily AI question limit <small>everyone together</small><input type="number" min={0} value={f.daily_question_quota} onChange={n('daily_question_quota')} /></label>
        <label className="field">Daily AI questions per student <small>for their own papers</small><input type="number" min={0} value={f.student_daily_questions ?? 20} onChange={n('student_daily_questions')} /></label>
        <label className="field">30-day budget ($)<input type="number" step="any" min={0} value={f.monthly_budget_usd} onChange={n('monthly_budget_usd')} /></label>
      </div>
      <p className="small muted">The API key is never stored here. Set it as the <span className="code">AI_API_KEY</span> environment variable of the <span className="code">api</span> Neon Function. Prices are used only for estimates — check your provider's current price list.</p>
      <div className="btn-row"><button className="btn primary" onClick={save}>Save AI settings</button></div>
    </section>
  );
}

const TYPES = ['single', 'multiple', 'integer', 'numerical'];

function SchemesPanel() {
  const toast = useToast();
  const { session } = useAuth();
  const list = useAsync(() => must<MarkingScheme[]>(db.from('marking_schemes').select('*').order('name').order('version', { ascending: false })), []);
  const [edit, setEdit] = useState<MarkingScheme | null>(null);

  const saveVersion = async () => {
    if (!edit) return;
    try {
      const max = Math.max(0, ...(list.data ?? []).filter((x) => x.name === edit.name).map((x) => x.version));
      await must(db.from('marking_schemes').insert({ name: edit.name, version: max + 1, description: edit.description, rules: edit.rules, created_by: session?.user.id }));
      toast(`Saved ${edit.name} v${max + 1}`);
      setEdit(null);
      list.reload();
    } catch (e) { toast(friendlyError(e), true); }
  };
  const toggle = async (m: MarkingScheme) => {
    await db.from('marking_schemes').update({ is_active: !m.is_active }).eq('id', m.id);
    list.reload();
  };

  if (list.loading) return <Loading />;
  return (
    <section className="panel stack">
      <p className="small">Schemes are versioned: editing saves a new version, so exams that already copied an older version keep their rules. Verify each scheme against the current official pattern before use.</p>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Scheme</th>{TYPES.map((t) => <th key={t}>{TYPE_LABEL[t]}</th>)}<th /></tr></thead>
        <tbody>{(list.data ?? []).map((m) => (
          <tr key={m.id} style={{ opacity: m.is_active ? 1 : 0.55 }}>
            <td><b>{m.name}</b> <span className="muted">v{m.version}</span><div className="small muted">{m.description}</div></td>
            {TYPES.map((t) => { const r = m.rules[t]; return <td key={t} className="num small">{r ? `+${r.marks} / −${r.negative}${r.partial === 'per_option' ? ' (partial)' : ''}` : '—'}</td>; })}
            <td><div className="btn-row" style={{ flexWrap: 'nowrap' }}>
              <button className="btn sm" onClick={() => setEdit(JSON.parse(JSON.stringify(m)))}>Edit as new version</button>
              <button className="btn sm ghost" onClick={() => void toggle(m)}>{m.is_active ? 'Hide' : 'Show'}</button></div></td>
          </tr>
        ))}</tbody>
      </table></div>
      <div><button className="btn" onClick={() => setEdit({ id: '', name: 'New scheme', version: 1, description: '', is_active: true,
        rules: Object.fromEntries(TYPES.map((t) => [t, { marks: 4, negative: 1, unanswered: 0, partial: 'none' }])) as Rules })}>New scheme</button></div>
      {edit && (
        <Modal title="Marking scheme" onClose={() => setEdit(null)} wide>
          <div className="stack">
            <div className="grid-2">
              <label className="field">Name<input type="text" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
              <label className="field">Description<input type="text" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
            </div>
            <table className="data"><thead><tr><th>Type</th><th>Correct</th><th>Wrong (deduct)</th><th>Unanswered</th><th>Partial</th></tr></thead>
              <tbody>{TYPES.map((t) => {
                const r = edit.rules[t] ?? { marks: 4, negative: 0 };
                const upd = (p: Partial<typeof r>) => setEdit({ ...edit, rules: { ...edit.rules, [t]: { ...r, ...p } } });
                return (<tr key={t}><td>{TYPE_LABEL[t]}</td>
                  <td><input type="number" step={0.25} value={r.marks} onChange={(e) => upd({ marks: Number(e.target.value) })} /></td>
                  <td><input type="number" step={0.25} min={0} value={r.negative} onChange={(e) => upd({ negative: Number(e.target.value) })} /></td>
                  <td><input type="number" step={0.25} value={r.unanswered ?? 0} onChange={(e) => upd({ unanswered: Number(e.target.value) })} /></td>
                  <td>{t === 'multiple' ? <div className="row"><select value={r.partial ?? 'none'} onChange={(e) => upd({ partial: e.target.value })}>
                    <option value="none">None</option><option value="per_option">Per correct option</option></select>
                    {r.partial === 'per_option' && <input type="number" step={0.25} style={{ width: 80 }} value={r.partial_per_option ?? 1} onChange={(e) => upd({ partial_per_option: Number(e.target.value) })} aria-label="Marks per option" />}</div> : '—'}</td></tr>);
              })}</tbody></table>
            <div className="btn-row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={saveVersion}>Save as new version</button></div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function TemplatesPanel() {
  const toast = useToast();
  const list = useAsync(async () => ({
    templates: await must<ExamTemplate[]>(db.from('exam_templates').select('*').order('name').order('version', { ascending: false })),
    schemes: await must<MarkingScheme[]>(db.from('marking_schemes').select('*').eq('is_active', true)),
  }), []);
  const [edit, setEdit] = useState<{ t: ExamTemplate; json: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!edit) return;
    setErr(null);
    let config: ExamTemplate['config'];
    try { config = JSON.parse(edit.json); } catch { setErr('The configuration is not valid JSON.'); return; }
    if (!Array.isArray(config.sections) || !config.duration_minutes) { setErr('The configuration needs "duration_minutes" and a "sections" list.'); return; }
    try {
      const max = Math.max(0, ...(list.data?.templates ?? []).filter((x) => x.name === edit.t.name).map((x) => x.version));
      await must(db.from('exam_templates').insert({ name: edit.t.name, kind: edit.t.kind, version: max + 1, description: edit.t.description, config, marking_scheme_id: edit.t.marking_scheme_id }));
      toast(`Saved ${edit.t.name} v${max + 1}`);
      setEdit(null);
      list.reload();
    } catch (e) { setErr(friendlyError(e)); }
  };

  if (list.loading) return <Loading />;
  return (
    <section className="panel stack">
      <p className="small">Templates pre-fill the paper generator. Saving creates a new version; older versions stay available.</p>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Template</th><th>Sections</th><th>Duration</th><th /></tr></thead>
        <tbody>{(list.data?.templates ?? []).map((t) => (
          <tr key={t.id} style={{ opacity: t.is_active ? 1 : 0.55 }}>
            <td><b>{t.name}</b> <span className="muted">v{t.version}</span><div className="small muted">{t.description}</div></td>
            <td className="small">{t.config.sections.length} sections, {t.config.sections.reduce((a, s) => a + s.count, 0)} questions, {t.config.sections.reduce((a, s) => a + s.count * s.marks, 0)} marks</td>
            <td className="num">{t.config.duration_minutes} min</td>
            <td><div className="btn-row" style={{ flexWrap: 'nowrap' }}>
              <button className="btn sm" onClick={() => setEdit({ t, json: JSON.stringify(t.config, null, 2) })}>Edit as new version</button>
              <button className="btn sm ghost" onClick={async () => { await db.from('exam_templates').update({ is_active: !t.is_active }).eq('id', t.id); list.reload(); }}>{t.is_active ? 'Hide' : 'Show'}</button></div></td>
          </tr>
        ))}</tbody>
      </table></div>
      {edit && (
        <Modal title={`Edit ${edit.t.name}`} onClose={() => setEdit(null)} wide>
          <div className="stack">
            <div className="grid-2">
              <label className="field">Description<input type="text" value={edit.t.description ?? ''} onChange={(e) => setEdit({ ...edit, t: { ...edit.t, description: e.target.value } })} /></label>
              <label className="field">Marking scheme<select value={edit.t.marking_scheme_id ?? ''} onChange={(e) => setEdit({ ...edit, t: { ...edit.t, marking_scheme_id: e.target.value || null } })}>
                <option value="">None</option>{list.data?.schemes.map((s) => <option key={s.id} value={s.id}>{s.name} v{s.version}</option>)}</select></label>
            </div>
            <label className="field">Configuration <small>sections: key, title, subject_code (PHY/CHE/MAT), type, count, marks, negative</small>
              <textarea rows={16} value={edit.json} onChange={(e) => setEdit({ ...edit, json: e.target.value })} /></label>
            <ErrorNote error={err} />
            <div className="btn-row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={save}>Save as new version</button></div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function SyllabusPanel() {
  const toast = useToast();
  const { tax, refresh } = useTaxonomy();
  const [subject, setSubject] = useState('');
  const [chapter, setChapter] = useState('');
  const [newChapter, setNewChapter] = useState('');
  const [newTopic, setNewTopic] = useState('');
  useEffect(() => { if (tax && !subject) setSubject(tax.subjects[0]?.id ?? ''); }, [tax, subject]);
  if (!tax) return <Loading />;

  const chapters = tax.chapters.filter((c) => c.subject_id === subject);
  const topics = tax.topics.filter((t) => t.chapter_id === chapter);
  const act = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) => {
    const { error } = await fn();
    if (error) toast(friendlyError(error), true); else { toast(ok); await refresh(); }
  };

  return (
    <section className="panel stack">
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <label className="field">Subject<select value={subject} onChange={(e) => { setSubject(e.target.value); setChapter(''); }}>
            {tax.subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}><table className="data"><tbody>
            {chapters.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => setChapter(c.id)} style={c.id === chapter ? { background: 'var(--surface-2)' } : undefined}>
                <td>{c.name}</td>
                <td><button className="btn sm ghost" onClick={async (e) => {
                  e.stopPropagation();
                  const { count } = await db.from('questions').select('id', { count: 'exact', head: true }).eq('chapter_id', c.id);
                  if (count) { toast(`${count} question(s) use this chapter, so it cannot be removed.`, true); return; }
                  void act(() => db.from('chapters').delete().eq('id', c.id), 'Chapter removed');
                }}>Remove</button></td>
              </tr>
            ))}</tbody></table></div>
          <div className="row"><input type="text" placeholder="New chapter name" value={newChapter} onChange={(e) => setNewChapter(e.target.value)} style={{ flex: 1 }} />
            <button className="btn" disabled={!newChapter.trim()} onClick={() => void act(() => db.from('chapters').insert({ subject_id: subject, name: newChapter.trim(), sort: chapters.length + 1 }), 'Chapter added').then(() => setNewChapter(''))}>Add chapter</button></div>
        </div>
        <div className="stack">
          <h3>{chapter ? `Topics in ${tax.chapters.find((c) => c.id === chapter)?.name}` : 'Choose a chapter to see its topics'}</h3>
          {chapter && <>
            {topics.length === 0 ? <p className="small muted">No topics yet. Topics make analysis and generation more precise.</p> : (
              <ul className="small" style={{ paddingLeft: '1.1rem', margin: 0 }}>{topics.map((t) => (
                <li key={t.id} style={{ marginBottom: '0.25rem' }}>{t.name} <button className="btn sm ghost" onClick={() => void act(() => db.from('topics').delete().eq('id', t.id), 'Topic removed')}>Remove</button></li>
              ))}</ul>
            )}
            <div className="row"><input type="text" placeholder="New topic name" value={newTopic} onChange={(e) => setNewTopic(e.target.value)} style={{ flex: 1 }} />
              <button className="btn" disabled={!newTopic.trim()} onClick={() => void act(() => db.from('topics').insert({ chapter_id: chapter, name: newTopic.trim() }), 'Topic added').then(() => setNewTopic(''))}>Add topic</button></div>
          </>}
          <p className="small muted">Chapters already used by questions cannot be removed.</p>
        </div>
      </div>
    </section>
  );
}
