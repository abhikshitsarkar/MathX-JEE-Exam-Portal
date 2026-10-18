import { useState } from 'react';
import { fmtDate, num } from '../../lib/format';
import { db } from '../../lib/db';
import { ErrorNote, Loading, useAsync } from '../../lib/ui';
import { must } from './common';

interface Audit { id: number; actor_id: string | null; action: string; entity_type: string; entity_id: string | null; details: Record<string, unknown>; created_at: string }
interface AiCall { id: number; provider: string; model: string; purpose: string; input_tokens: number; output_tokens: number; cost_usd: number; ok: boolean; error: string | null; latency_ms: number | null; created_at: string }

export default function Logs() {
  const [tab, setTab] = useState<'audit' | 'ai'>('audit');
  const audit = useAsync(async () => {
    const rows = await must<Audit[]>(db.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(200));
    const ids = [...new Set(rows.map((r) => r.actor_id).filter(Boolean))] as string[];
    const people = ids.length ? await must<{ id: string; email: string }[]>(db.from('profiles').select('id, email').in('id', ids)) : [];
    return { rows, people: Object.fromEntries(people.map((p) => [p.id, p.email])) };
  }, []);
  const ai = useAsync(() => must<AiCall[]>(db.from('ai_calls').select('*').order('created_at', { ascending: false }).limit(200)), []);

  return (
    <div className="stack">
      <div className="page-head"><div><h1>Logs</h1><p>The latest 200 entries of each log.</p></div></div>
      <div className="btn-row" role="tablist">
        <button role="tab" aria-selected={tab === 'audit'} className={`btn sm ${tab === 'audit' ? 'primary' : ''}`} onClick={() => setTab('audit')}>Admin actions</button>
        <button role="tab" aria-selected={tab === 'ai'} className={`btn sm ${tab === 'ai' ? 'primary' : ''}`} onClick={() => setTab('ai')}>AI calls</button>
      </div>
      {tab === 'audit' ? (audit.loading ? <Loading /> : audit.error ? <ErrorNote error={audit.error} /> : (
        <div className="panel flush table-wrap"><table className="data">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Item</th><th>Details</th></tr></thead>
          <tbody>{audit.data!.rows.map((r) => (
            <tr key={r.id}><td className="small num">{fmtDate(r.created_at)}</td><td className="small">{r.actor_id ? audit.data!.people[r.actor_id] ?? r.actor_id.slice(0, 8) : 'system'}</td>
              <td><span className="code">{r.action}</span></td><td className="small">{r.entity_type} {r.entity_id ? <span className="muted">{r.entity_id.slice(0, 8)}</span> : null}</td>
              <td className="small"><span className="code">{JSON.stringify(r.details)}</span></td></tr>
          ))}</tbody>
        </table></div>
      )) : (ai.loading ? <Loading /> : ai.error ? <ErrorNote error={ai.error} /> : (
        <div className="panel flush table-wrap"><table className="data">
          <thead><tr><th>When</th><th>Model</th><th>Tokens in / out</th><th>Cost</th><th>Time</th><th>Result</th></tr></thead>
          <tbody>{ai.data!.map((r) => (
            <tr key={r.id}><td className="small num">{fmtDate(r.created_at)}</td><td className="small">{r.provider} / {r.model}</td>
              <td className="num">{num(r.input_tokens)} / {num(r.output_tokens)}</td><td className="num">${num(r.cost_usd, 4)}</td>
              <td className="num small">{r.latency_ms ? `${(r.latency_ms / 1000).toFixed(1)} s` : '—'}</td>
              <td>{r.ok ? <span className="badge ok">OK</span> : <span className="badge bad" title={r.error ?? ''}>Failed</span>}{r.error && <div className="small muted">{r.error}</div>}</td></tr>
          ))}</tbody>
        </table></div>
      ))}
    </div>
  );
}
