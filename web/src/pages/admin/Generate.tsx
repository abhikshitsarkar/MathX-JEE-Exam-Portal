import { buildBlueprint } from '@shared/blueprint.ts';
import type { GenerationRequest, SectionRequest } from '@shared/types.ts';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { invokeAi } from '../../lib/api';
import { fmtDate, num, RELEASE_LABEL, TYPE_LABEL } from '../../lib/format';
import { db } from '../../lib/db';
import { ErrorNote, Loading, Modal, useAsync } from '../../lib/ui';
import { type ExamTemplate, fromLocalInput, type MarkingScheme, must, toLocalInput, useTaxonomy } from './common';

type Section = SectionRequest & { chapter_ids: string[] };

export default function Generate({ practice = false }: { practice?: boolean }) {
  const nav = useNavigate();
  const { tax } = useTaxonomy();
  const refs = useAsync(async () => ({
    schemes: await must<MarkingScheme[]>(db.from('marking_schemes').select('*').eq('is_active', true).order('name')),
    templates: await must<ExamTemplate[]>(db.from('exam_templates').select('*').eq('is_active', true).order('name')),
    jobs: await must<{ id: string; status: string; created_at: string; request: { title: string }; questions_requested: number; questions_generated: number; exam_id: string | null; actual_cost_usd: number }[]>(
      db.from('generation_jobs').select('id, status, created_at, request, questions_requested, questions_generated, exam_id, actual_cost_usd')
        .eq('is_practice', practice).order('created_at', { ascending: false }).limit(10)),
    documents: await must<{ id: string; title: string; subject_id: string | null; page_count: number | null }[]>(
      db.from('documents').select('id, title, subject_id, page_count').eq('is_active', true).eq('status', 'ready').order('title')),
  }), []);
  const status = useAsync(() => invokeAi<{ provider: string; model: string; has_key: boolean; daily_limit?: number | null; left_today?: number | null }>(
    { action: 'status', practice }), []);

  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<GenerationRequest['kind']>('jee_main');
  const [duration, setDuration] = useState(180);
  const [schemeId, setSchemeId] = useState('');
  const [mix, setMix] = useState({ easy: 30, medium: 50, hard: 20 });
  const [sections, setSections] = useState<Section[]>([]);
  const [targetMarks, setTargetMarks] = useState('');
  const [release, setRelease] = useState<GenerationRequest['release_policy']>('immediate');
  const [releaseAt, setReleaseAt] = useState<string | null>(null);
  const [opensAt, setOpensAt] = useState<string | null>(null);
  const [closesAt, setClosesAt] = useState<string | null>(null);
  const [maxAttempts, setMaxAttempts] = useState(practice ? 3 : 1);
  const [instructions, setInstructions] = useState('');
  const [allowAi, setAllowAi] = useState(true);
  const [docIds, setDocIds] = useState<string[]>([]);
  const [chapterPicker, setChapterPicker] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; details?: string[] } | null>(null);

  const applyTemplate = (t: ExamTemplate) => {
    setKind(t.kind as GenerationRequest['kind']);
    setDuration(t.config.duration_minutes);
    if (t.config.difficulty_mix) setMix({ easy: t.config.difficulty_mix.easy ?? 0, medium: t.config.difficulty_mix.medium ?? 0, hard: t.config.difficulty_mix.hard ?? 0 });
    setSections(t.config.sections.map((s) => ({ ...s, type: s.type as Section['type'], chapter_ids: [] })));
    if (t.marking_scheme_id) setSchemeId(t.marking_scheme_id);
    setTargetMarks(String(t.config.sections.reduce((a, s) => a + s.count * s.marks, 0)));
  };
  // a student's first paper: short — one single-correct section per subject, 5 questions each
  const applyStarter = (t: ExamTemplate) => {
    applyTemplate(t);
    const seen = new Set<string>();
    const starter = t.config.sections.filter((s) => s.type === 'single' && !seen.has(s.subject_code) && seen.add(s.subject_code))
      .map((s) => ({ ...s, type: s.type as Section['type'], count: 5, chapter_ids: [] }));
    if (starter.length) setSections(starter);
    setDuration(30);
    setTargetMarks('');
  };

  useEffect(() => {
    const first = refs.data?.templates.find((t) => t.kind === 'jee_main') ?? refs.data?.templates[0];
    if (first && sections.length === 0) (practice ? applyStarter : applyTemplate)(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs.data]);

  const scheme = refs.data?.schemes.find((s) => s.id === schemeId);
  const request: GenerationRequest = {
    title: title.trim() || (practice ? 'My practice paper' : ''), kind, duration_minutes: duration, total_marks: targetMarks ? Number(targetMarks) : undefined,
    marking_rules: (scheme?.rules ?? {}) as GenerationRequest['marking_rules'], sections, difficulty_mix: mix,
    release_policy: release, release_at: releaseAt, opens_at: opensAt, closes_at: closesAt, max_attempts: maxAttempts,
    instructions, allow_ai: allowAi, document_ids: allowAi && docIds.length ? docIds : undefined,
  };
  const preview = useMemo(() => (tax ? buildBlueprint(request, tax as never) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tax, JSON.stringify(request)]);

  const updSection = (i: number, patch: Partial<Section>) => setSections((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const plan = async () => {
    setErr(null);
    if (!scheme) { setErr({ message: 'Choose a marking scheme.' }); return; }
    setBusy(true);
    try {
      const r = await invokeAi<{ job_id: string }>({ action: 'plan', request, practice });
      nav(practice ? `/make/${r.job_id}` : `/admin/generate/${r.job_id}`);
    } catch (e) {
      setErr({ message: (e as Error).message, details: (e as Error & { details?: string[] }).details });
      setBusy(false);
    }
  };

  if (refs.loading || !tax) return <Loading />;
  if (refs.error) return <ErrorNote error={refs.error} onRetry={refs.reload} />;

  const materialLink = practice ? '/material' : '/admin/documents';
  return (
    <div className={practice ? 'page stack' : 'stack'}>
      <div className="page-head">
        {practice
          ? <div><h1>Make a paper</h1><p>Choose subjects, chapters and the number of questions. Questions come from the question bank first; AI writes new ones from the shared study material for anything missing. Only you can see your paper and your marks.</p></div>
          : <div><h1>Generate a paper</h1><p>The generator first takes approved questions from your bank, then writes new ones only for what is missing. New questions are saved as drafts for your review.</p></div>}
      </div>

      {practice && status.data && (
        <div className="notice small">
          {status.data.provider === 'mock'
            ? <>AI is in demo mode: new questions written for your paper are placeholders until the administrator connects an AI provider.</>
            : status.data.left_today != null
              ? <>You can get <b>{status.data.left_today}</b> more AI-written questions today (limit {status.data.daily_limit} a day). Questions from the bank do not count.</>
              : null}
        </div>
      )}
      {!practice && status.data && (
        <div className={`notice ${status.data.provider === 'mock' ? 'warn' : status.data.has_key ? 'ok' : 'bad'}`}>
          {status.data.provider === 'mock'
            ? <>AI provider: <b>mock</b>. No paid calls are made; generated questions are clearly-labelled placeholders. Switch provider in <Link to="/admin/settings">Settings</Link>.</>
            : status.data.has_key ? <>AI provider: <b>{status.data.provider}</b>, model <span className="code">{status.data.model}</span>. API key configured on the server.</>
            : <>AI provider <b>{status.data.provider}</b> is selected but no API key is configured. Set the <span className="code">AI_API_KEY</span> environment variable on the <span className="code">api</span> Neon Function.</>}
        </div>
      )}
      {status.error && <div className="notice bad">The generation service is not reachable: {status.error}. Deploy the <span className="code">api</span> Neon Function and set VITE_API_URL (see README).</div>}

      <section className="panel stack">
        <h2>Paper</h2>
        <div className="grid-3">
          <label className="field">{practice ? 'Paper name' : 'Exam name'}<input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={practice ? 'e.g. Mechanics practice' : 'e.g. Full Mock Test 3'} /></label>
          <label className="field">Start from template
            <select defaultValue="" onChange={(e) => { const t = refs.data?.templates.find((x) => x.id === e.target.value); if (t) applyTemplate(t); }}>
              <option value="" disabled>Choose a template…</option>
              {refs.data?.templates.map((t) => <option key={t.id} value={t.id}>{t.name} (v{t.version})</option>)}</select></label>
          <label className="field">Marking scheme
            <select value={schemeId} onChange={(e) => setSchemeId(e.target.value)}><option value="">Choose…</option>
              {refs.data?.schemes.map((s) => <option key={s.id} value={s.id}>{s.name} (v{s.version})</option>)}</select></label>
          <label className="field">Duration (minutes)<input type="number" min={1} max={720} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></label>
          {!practice && <label className="field">Total marks <small>optional check</small><input type="number" value={targetMarks} onChange={(e) => setTargetMarks(e.target.value)} /></label>}
          <label className="field">{practice ? 'Attempts allowed' : 'Attempts per student'}<input type="number" min={1} max={practice ? 10 : 50} value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value))} /></label>
        </div>
        <div>
          <h3>Difficulty mix <small className="muted">(relative weights)</small></h3>
          <div className="grid-3">
            {(['easy', 'medium', 'hard'] as const).map((d) => (
              <label key={d} className="field">{d[0].toUpperCase() + d.slice(1)}<input type="number" min={0} value={mix[d]} onChange={(e) => setMix({ ...mix, [d]: Number(e.target.value) })} /></label>
            ))}
          </div>
        </div>
      </section>

      <section className="panel stack">
        <div className="panel-head"><h2>Sections</h2>
          <button className="btn sm" onClick={() => setSections([...sections, { key: `S${sections.length + 1}`, title: 'New section', subject_code: 'PHY', type: 'single', count: 5, marks: 4, negative: 1, chapter_ids: [] }])}>Add section</button></div>
        {sections.map((s, i) => {
          const subject = tax.subjects.find((x) => x.code === s.subject_code);
          return (
            <div key={i} className="section-row">
              <label className="field">Title<input type="text" value={s.title} onChange={(e) => updSection(i, { title: e.target.value })} /></label>
              <label className="field">Subject<select value={s.subject_code} onChange={(e) => updSection(i, { subject_code: e.target.value, chapter_ids: [] })}>
                {tax.subjects.map((x) => <option key={x.id} value={x.code}>{x.name}</option>)}</select></label>
              <label className="field">Type<select value={s.type} onChange={(e) => updSection(i, { type: e.target.value as Section['type'] })}>
                {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
              <label className="field">Questions<input type="number" min={1} max={100} value={s.count} onChange={(e) => updSection(i, { count: Number(e.target.value) })} /></label>
              <label className="field">+ marks<input type="number" step={0.25} value={s.marks} onChange={(e) => updSection(i, { marks: Number(e.target.value) })} /></label>
              <label className="field">− marks<input type="number" step={0.25} min={0} value={s.negative} onChange={(e) => updSection(i, { negative: Number(e.target.value) })} /></label>
              <div className="btn-row">
                <button className="btn sm" onClick={() => setChapterPicker(i)}>{s.chapter_ids.length ? `${s.chapter_ids.length} chapters` : `All ${subject?.name ?? ''} chapters`}</button>
                <button className="btn sm ghost" onClick={() => setSections(sections.filter((_, j) => j !== i))}>Remove</button>
              </div>
            </div>
          );
        })}
      </section>

      {practice ? (
        <section className="panel stack">
          <label className="check"><input type="checkbox" checked={allowAi} onChange={(e) => setAllowAi(e.target.checked)} /> Write new questions with AI where the question bank has too few</label>
          <p className="small muted" style={{ margin: 0 }}>Your paper opens as soon as it is ready, and your result and solutions appear right after you submit.</p>
        </section>
      ) : (
      <section className="panel stack">
        <h2>Availability and results</h2>
        <div className="grid-3">
          <label className="field">Opens <small>empty = when published</small><input type="datetime-local" value={toLocalInput(opensAt)} onChange={(e) => setOpensAt(fromLocalInput(e.target.value))} /></label>
          <label className="field">Closes <small>empty = never</small><input type="datetime-local" value={toLocalInput(closesAt)} onChange={(e) => setClosesAt(fromLocalInput(e.target.value))} /></label>
          <label className="field">Show results and solutions<select value={release} onChange={(e) => setRelease(e.target.value as GenerationRequest['release_policy'])}>
            {Object.entries(RELEASE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {release === 'scheduled' && <label className="field">Release time<input type="datetime-local" value={toLocalInput(releaseAt)} onChange={(e) => setReleaseAt(fromLocalInput(e.target.value))} /></label>}
        </div>
        <label className="field">Instructions for students <small>optional</small><textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} style={{ fontFamily: 'var(--font-ui)' }} /></label>
        <label className="check"><input type="checkbox" checked={allowAi} onChange={(e) => setAllowAi(e.target.checked)} /> Write new questions with AI where the bank has too few</label>
      </section>
      )}

      {allowAi && (
        <section className="panel stack">
          <h2>Study material for new questions</h2>
          {refs.data!.documents.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>No indexed PDFs yet. Upload them in <Link to={materialLink}>Study material</Link>; until then the AI writes from the standard JEE syllabus.</p>
          ) : (
            <>
              <p className="small muted" style={{ margin: 0 }}>
                Tick the PDFs the AI should write from. Leave all unticked to use every indexed PDF of the matching subject.
                The AI reads the most relevant pages of the ticked PDFs and writes original questions on them, with page references for your review.
              </p>
              <div className="stack" style={{ gap: '0.4rem' }}>
                {refs.data!.documents.map((d) => (
                  <label key={d.id} className="check">
                    <input type="checkbox" checked={docIds.includes(d.id)}
                      onChange={(e) => setDocIds((ids) => (e.target.checked ? [...ids, d.id] : ids.filter((x) => x !== d.id)))} />
                    {d.title}
                    <span className="small muted">
                      {tax.subjects.find((x) => x.id === d.subject_id)?.name ?? 'Any subject'}{d.page_count ? ` · ${d.page_count} pages` : ''}
                    </span>
                  </label>
                ))}
              </div>
              {docIds.length > 0 && <p className="small" style={{ margin: 0 }}><b>{docIds.length}</b> PDF{docIds.length === 1 ? '' : 's'} selected. New questions will be written only from {docIds.length === 1 ? 'it' : 'these'}.</p>}
            </>
          )}
        </section>
      )}

      <section className="panel stack">
        <h2>Blueprint check</h2>
        {preview?.errors.length ? (
          <div className="notice warn"><b>Fix these before planning:</b><ul>{preview.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>
        ) : preview?.blueprint && (
          <div className="grid-4">
            <div className="stat"><b>{preview.blueprint.totals.questions}</b><span>Questions</span></div>
            <div className="stat"><b>{num(preview.blueprint.totals.marks)}</b><span>Total marks</span></div>
            <div className="stat"><b className="num">{preview.blueprint.totals.by_difficulty.easy} / {preview.blueprint.totals.by_difficulty.medium} / {preview.blueprint.totals.by_difficulty.hard}</b><span>Easy / medium / hard</span></div>
            <div className="stat"><b>{Object.entries(preview.blueprint.totals.by_subject).map(([k, v]) => `${k} ${v.questions}`).join(' · ')}</b><span>By subject</span></div>
          </div>
        )}
        <ErrorNote error={err ? `${err.message}${err.details?.length ? ` — ${err.details.join(' ')}` : ''}` : null} />
        <div className="btn-row">
          {practice ? <>
            <button className="btn primary lg" onClick={plan} disabled={busy || !!preview?.errors.length}>{busy ? 'Preparing…' : 'Make my paper'}</button>
            <span className="small muted">Usually ready in a minute or two.</span>
          </> : <>
            <button className="btn primary lg" onClick={plan} disabled={busy || !!preview?.errors.length || !title.trim()}>{busy ? 'Searching the bank…' : 'Search bank and estimate'}</button>
            <span className="small muted">Nothing is generated or charged in this step.</span>
          </>}
        </div>
      </section>

      {refs.data && refs.data.jobs.length > 0 && (
        <section className="panel flush">
          <div className="panel-head" style={{ padding: '1rem 1.2rem 0' }}><h2>{practice ? 'Papers you made recently' : 'Recent generation jobs'}</h2></div>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Paper</th><th>Created</th><th>Status</th><th>New questions</th>{!practice && <th>Cost</th>}</tr></thead>
            <tbody>{refs.data.jobs.map((j) => (
              <tr key={j.id} className="clickable" onClick={() => nav(practice ? `/make/${j.id}` : `/admin/generate/${j.id}`)}>
                <td>{j.request?.title}</td><td className="num small">{fmtDate(j.created_at)}</td>
                <td><span className={`badge ${j.exam_id ? 'ok' : j.status === 'failed' ? 'bad' : ''}`}>{j.exam_id ? (practice ? 'Ready' : 'Exam created') : practice ? 'Not finished' : j.status}</span></td>
                <td className="num">{j.questions_generated} / {j.questions_requested}</td>{!practice && <td className="num">${num(j.actual_cost_usd, 4)}</td>}
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      {chapterPicker !== null && sections[chapterPicker] && (
        <Modal title={`Chapters for ${sections[chapterPicker].title}`} onClose={() => setChapterPicker(null)}>
          <div className="stack">
            <p className="small muted">Leave all unticked to use every chapter of the subject. Questions are spread evenly across the chosen chapters.</p>
            <div style={{ maxHeight: 360, overflowY: 'auto', display: 'grid', gap: '0.35rem' }}>
              {tax.chapters.filter((c) => c.subject_id === tax.subjects.find((x) => x.code === sections[chapterPicker].subject_code)?.id).map((c) => (
                <label key={c.id} className="check"><input type="checkbox" checked={sections[chapterPicker].chapter_ids.includes(c.id)}
                  onChange={(e) => updSection(chapterPicker, { chapter_ids: e.target.checked ? [...sections[chapterPicker].chapter_ids, c.id] : sections[chapterPicker].chapter_ids.filter((x) => x !== c.id) })} />{c.name}</label>
              ))}
            </div>
            <div className="btn-row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={() => setChapterPicker(null)}>Done</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
