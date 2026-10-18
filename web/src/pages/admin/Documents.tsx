import { useRef, useState } from 'react';
import { deleteFile, downloadFile, friendlyError, rpc, uploadFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { chunkPages, needsOcr } from '../../lib/chunk';
import { fmtDate } from '../../lib/format';
import { extractPdf, sha256Hex } from '../../lib/pdf';
import { db } from '../../lib/db';
import { Confirm, Empty, ErrorNote, Loading, Modal, useAsync, useToast } from '../../lib/ui';
import { must, useTaxonomy } from './common';

interface Doc {
  id: string; title: string; author: string | null; source: string | null; subject_id: string | null; storage_path: string; sha256: string;
  file_size: number; page_count: number | null; status: string; error: string | null; retries: number; version: number;
  previous_id: string | null; is_active: boolean; license_note: string | null; created_at: string; processed_at: string | null;
  uploaded_by: string | null;
}
/** Storage folder for a user's own uploads (matches app.safe_path_id in the database). */
const userFolder = (uid: string) => `u/${uid.replace(/[^A-Za-z0-9._-]/g, '_')}`;
const MAX_MB = 100;
const STATUS_TEXT: Record<string, [string, string]> = {
  uploaded: ['Uploaded', ''], processing: ['Processing', 'warn'], ready: ['Indexed', 'ok'], needs_ocr: ['Scanned — needs OCR', 'bad'], failed: ['Failed', 'bad'],
};

/** Extracts, chunks and stores a PDF's text. Runs in this browser tab. */
async function processDocument(doc: Pick<Doc, 'id'>, data: ArrayBuffer, onStep: (s: string) => void) {
  await must(db.from('documents').update({ status: 'processing', error: null }).eq('id', doc.id));
  try {
    onStep('Reading pages…');
    const pdf = await extractPdf(data, (d, t) => onStep(`Reading page ${d} of ${t}…`));
    if (needsOcr(pdf.pages)) {
      await must(db.from('documents').update({ status: 'needs_ocr', page_count: pdf.pageCount, processed_at: new Date().toISOString() }).eq('id', doc.id));
      return { status: 'needs_ocr', chunks: 0 };
    }
    const chunks = chunkPages(pdf.pages, 2400, 300);
    await must(db.from('document_chunks').delete().eq('document_id', doc.id));
    for (let i = 0; i < chunks.length; i += 200) {
      onStep(`Indexing ${Math.min(i + 200, chunks.length)} of ${chunks.length} sections…`);
      await must(db.from('document_chunks').insert(chunks.slice(i, i + 200).map((c) => ({
        document_id: doc.id, chunk_index: c.index, page_start: c.page_start, page_end: c.page_end, heading: c.heading,
        content: c.content, token_estimate: c.token_estimate,
      }))));
    }
    await must(db.from('documents').update({ status: 'ready', page_count: pdf.pageCount, processed_at: new Date().toISOString() }).eq('id', doc.id));
    return { status: 'ready', chunks: chunks.length };
  } catch (e) {
    const { data: cur } = await db.from('documents').select('retries').eq('id', doc.id).single();
    await db.from('documents').update({ status: 'failed', error: friendlyError(e).slice(0, 500), retries: (cur?.retries ?? 0) + 1 }).eq('id', doc.id);
    throw e;
  }
}

/**
 * Study material. Admin view (/admin/documents): every PDF, with full control.
 * Shared view (/material): everyone's active PDFs; users manage only their own uploads.
 */
export default function Documents({ shared = false }: { shared?: boolean }) {
  const toast = useToast();
  const { tax } = useTaxonomy();
  const { session } = useAuth();
  const uid = session?.user.id ?? '';
  const [showInactive, setShowInactive] = useState(false);
  const docs = useAsync(() => must<Doc[]>(db.from('documents').select('*').eq('is_active', !showInactive).order('created_at', { ascending: false }).limit(300)), [showInactive]);
  const uploaders = useAsync(() => (shared ? rpc<Record<string, string>>('document_uploaders') : Promise.resolve({} as Record<string, string>)), [shared]);
  const mine = (d: Doc) => !shared || d.uploaded_by === uid;
  const [uploading, setUploading] = useState<{ replace?: Doc } | null>(null);
  const [step, setStep] = useState<Record<string, string>>({});
  const [del, setDel] = useState<Doc | null>(null);

  const reprocess = async (d: Doc) => {
    setStep((s) => ({ ...s, [d.id]: 'Downloading…' }));
    try {
      const data = await downloadFile('documents', d.storage_path);
      const r = await processDocument(d, data, (m) => setStep((s) => ({ ...s, [d.id]: m })));
      toast(r.status === 'ready' ? `Indexed ${r.chunks} sections` : 'This PDF looks scanned; it needs OCR before it can be used');
    } catch (e) { toast(friendlyError(e), true); }
    setStep((s) => { const n = { ...s }; delete n[d.id]; return n; });
    docs.reload();
  };

  const toggleActive = async (d: Doc) => {
    try { await must(db.from('documents').update({ is_active: !d.is_active }).eq('id', d.id)); toast(d.is_active ? 'Deactivated — no longer used for generation' : 'Reactivated'); docs.reload(); }
    catch (e) { toast(friendlyError(e), true); }
  };

  const remove = async (d: Doc) => {
    try {
      await deleteFile('documents', d.storage_path).catch(() => { /* already gone */ });
      await must(db.from('documents').delete().eq('id', d.id));
      toast('Document deleted');
      docs.reload();
    } catch (e) { toast(friendlyError(e), true); }
    setDel(null);
  };

  return (
    <div className="stack">
      <div className="page-head">
        {shared
          ? <div><h1>Study material</h1><p>PDFs shared by everyone on this site. When you make a paper, AI can write new questions from any of them. Anything you upload here is shared with all users straight away.</p></div>
          : <div><h1>Study material</h1><p>PDFs you are authorised to use. Their text is indexed so the generator can pull relevant excerpts — never whole books. Students' uploads appear here too; deactivate or delete anything that should not be shared.</p></div>}
        <div className="btn-row">
          {!shared && <label className="check small"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show deactivated</label>}
          <button className="btn primary" onClick={() => setUploading({})}>Upload PDF</button>
        </div>
      </div>
      <div className="notice small">Text is extracted in your browser, so large books cost nothing to process — keep this tab open until indexing finishes. Scanned PDFs (images of pages) are detected and marked; they need OCR, which is not enabled.</div>
      <ErrorNote error={docs.error} onRetry={docs.reload} />
      {docs.loading && !docs.data ? <Loading /> : !docs.data?.length ? (
        <div className="panel"><Empty title={showInactive ? 'No deactivated documents' : 'No study material yet'}>Upload textbooks or notes to ground AI-generated questions in your own material.</Empty></div>
      ) : (
        <div className="panel flush table-wrap">
          <table className="data">
            <thead><tr><th>Document</th><th>Subject</th><th>Pages</th><th>Status</th><th>{shared ? 'Shared by' : 'Uploaded'}</th><th /></tr></thead>
            <tbody>{docs.data.map((d) => {
              const [label, cls] = STATUS_TEXT[d.status] ?? [d.status, ''];
              return (
                <tr key={d.id}>
                  <td><b>{d.title}</b>{d.version > 1 && <span className="badge" style={{ marginLeft: 6 }}>v{d.version}</span>}
                    <div className="small muted">{[d.author, d.source, `${(d.file_size / 1048576).toFixed(1)} MB`].filter(Boolean).join(' · ')}</div>
                    {d.error && <div className="small" style={{ color: 'var(--bad)' }}>{d.error}</div>}</td>
                  <td className="small">{tax?.subjects.find((s) => s.id === d.subject_id)?.name ?? 'Any'}</td>
                  <td className="num">{d.page_count ?? '—'}</td>
                  <td>{step[d.id] ? <span className="small">{step[d.id]}</span> : <span className={`badge ${cls}`}>{label}</span>}</td>
                  <td className="small">{shared
                    ? <>{d.uploaded_by === uid ? 'You' : uploaders.data?.[d.id] ?? 'Administrator'}<div className="muted num">{fmtDate(d.created_at, false)}</div></>
                    : <span className="num">{fmtDate(d.created_at, false)}</span>}</td>
                  <td>{mine(d) && <div className="btn-row" style={{ flexWrap: 'nowrap' }}>
                    {(d.status === 'failed' || d.status === 'uploaded' || d.status === 'processing') && <button className="btn sm" disabled={!!step[d.id]} onClick={() => void reprocess(d)}>Process again</button>}
                    {d.status === 'ready' && <button className="btn sm ghost" disabled={!!step[d.id]} onClick={() => void reprocess(d)}>Re-index</button>}
                    {!shared && <button className="btn sm ghost" onClick={() => setUploading({ replace: d })}>Replace</button>}
                    {!shared && <button className="btn sm ghost" onClick={() => void toggleActive(d)}>{d.is_active ? 'Deactivate' : 'Reactivate'}</button>}
                    <button className="btn sm danger" onClick={() => setDel(d)}>Delete</button>
                  </div>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {uploading && <UploadModal shared={shared} replace={uploading.replace} onClose={() => setUploading(null)} onDone={() => { setUploading(null); docs.reload(); uploaders.reload(); }} />}
      {del && <Confirm title="Delete this document?" danger confirmLabel="Delete" onClose={() => setDel(null)} onConfirm={() => void remove(del)}
        body={<p>“{del.title}” and its index will be removed. Questions already generated from it keep their text but lose the page link.</p>} />}
    </div>
  );
}

function UploadModal({ replace, onClose, onDone, shared = false }: { replace?: Doc; onClose: () => void; onDone: () => void; shared?: boolean }) {
  const toast = useToast();
  const { session } = useAuth();
  const { tax } = useTaxonomy();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(replace?.title ?? '');
  const [author, setAuthor] = useState(replace?.author ?? '');
  const [source, setSource] = useState(replace?.source ?? '');
  const [subject, setSubject] = useState(replace?.subject_id ?? '');
  const [licenseNote, setLicenseNote] = useState(replace?.license_note ?? '');
  const [authorized, setAuthorized] = useState(false);
  const [drag, setDrag] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const pick = (f: File | undefined) => {
    setErr(null);
    if (!f) return;
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) { setErr('Only PDF files can be uploaded.'); return; }
    if (f.size > MAX_MB * 1048576) { setErr(`This file is larger than ${MAX_MB} MB.`); return; }
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.pdf$/i, ''));
  };

  const go = async () => {
    if (!file) { setErr('Choose a PDF.'); return; }
    if (!authorized) { setErr('Confirm that you are allowed to use this material.'); return; }
    setErr(null);
    try {
      setStep('Checking file…');
      const buf = await file.arrayBuffer();
      const sha = await sha256Hex(buf);
      const { data: existing } = await db.from('documents').select('id, title').eq('sha256', sha).eq('is_active', true).maybeSingle();
      if (existing) { setErr(`This exact file is already shared as “${existing.title}”, so everyone can already use it.`); setStep(null); return; }

      setStep('Uploading…');
      const name = `${sha.slice(0, 16)}-${Date.now()}.pdf`;
      const path = shared ? `${userFolder(session?.user.id ?? '')}/${name}` : name;
      await uploadFile('documents', path, new Blob([buf], { type: 'application/pdf' }), setStep);

      const doc = await must<{ id: string }>(db.from('documents').insert({
        title: title.trim() || file.name, author: author || null, source: source || null, subject_id: subject || null,
        storage_path: path, sha256: sha, file_size: file.size, status: 'uploaded', authorized_confirmed: true,
        license_note: licenseNote || null, uploaded_by: session?.user.id,
        version: replace ? replace.version + 1 : 1, previous_id: replace?.id ?? null,
      }).select('id').single());
      if (replace) await must(db.from('documents').update({ is_active: false }).eq('id', replace.id));

      const r = await processDocument(doc, buf, setStep);
      toast(r.status === 'ready' ? `Indexed ${r.chunks} sections` : 'Uploaded, but the PDF looks scanned and needs OCR');
      onDone();
    } catch (e) {
      setErr(friendlyError(e));
      setStep(null);
    }
  };

  return (
    <Modal title={replace ? `Replace “${replace.title}”` : 'Upload study material'} onClose={() => { if (!step) onClose(); }}>
      <div className="stack">
        <div className={`dropzone ${drag ? 'drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}>
          <p style={{ margin: 0 }}>{file ? <b>{file.name}</b> : 'Drop a PDF here, or'} {!file && <button className="btn sm" onClick={() => fileRef.current?.click()}>choose a file</button>}</p>
          <p className="small muted" style={{ margin: '0.3rem 0 0' }}>PDF only, up to {MAX_MB} MB.</p>
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => pick(e.target.files?.[0])} />
        </div>
        <div className="grid-2">
          <label className="field">Title<input type="text" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="field">Subject<select value={subject} onChange={(e) => setSubject(e.target.value)}><option value="">Several / any</option>
            {tax?.subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="field">Author <small>optional</small><input type="text" value={author} onChange={(e) => setAuthor(e.target.value)} /></label>
          <label className="field">Source or edition <small>optional</small><input type="text" value={source} onChange={(e) => setSource(e.target.value)} /></label>
        </div>
        <label className="field">Permission note <small>optional — e.g. "own notes", "licensed copy for coaching use"</small><input type="text" value={licenseNote} onChange={(e) => setLicenseNote(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />
          {shared ? 'I have the right to share this material with everyone on this site for making practice questions (for example my own notes, or material whose licence allows it).'
            : 'I am authorised to use this material for creating practice questions.'}</label>
        <ErrorNote error={err} />
        {step && <Loading label={step} />}
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={!!step}>Cancel</button>
          <button className="btn primary" onClick={go} disabled={!!step || !file}>{replace ? 'Upload new version' : 'Upload and index'}</button>
        </div>
      </div>
    </Modal>
  );
}
