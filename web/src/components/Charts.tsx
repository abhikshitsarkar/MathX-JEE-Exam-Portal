// Small dependency-free charts drawn on graph paper.
import { pct } from '../lib/format';

export function TrendChart({ points }: { points: { label: string; value: number }[] }) {
  if (points.length === 0) return null;
  const w = 560, h = 180, pad = 28;
  const xs = (i: number) => pad + (points.length === 1 ? (w - 2 * pad) / 2 : (i * (w - 2 * pad)) / (points.length - 1));
  const ys = (v: number) => h - pad - (Math.max(0, Math.min(100, v)) / 100) * (h - 2 * pad);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)} ${ys(p.value).toFixed(1)}`).join(' ');
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="Score percentage across attempts" className="graph-paper">
        {[0, 50, 100].map((g) => (
          <g key={g}>
            <line x1={pad} x2={w - pad} y1={ys(g)} y2={ys(g)} stroke="var(--line-strong)" strokeDasharray={g === 50 ? '4 4' : undefined} />
            <text x={4} y={ys(g) + 4} fontSize="11" fill="var(--ink-3)">{g}%</text>
          </g>
        ))}
        <path d={path} fill="none" stroke="var(--brand)" strokeWidth="2.5" strokeLinejoin="round" />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={xs(i)} cy={ys(p.value)} r="4.5" fill="var(--surface)" stroke="var(--brand)" strokeWidth="2" />
            <title>{`${p.label}: ${pct(p.value)}`}</title>
          </g>
        ))}
      </svg>
    </figure>
  );
}

export function ScoreRows({ rows }: { rows: { label: string; score: number; max: number; accuracy?: number | null; total?: number }[] }) {
  return (
    <div className="stack" style={{ gap: '0.7rem' }}>
      {rows.map((r) => {
        const p = r.max > 0 ? Math.max(0, (r.score / r.max) * 100) : 0;
        return (
          <div key={r.label}>
            <div className="spread small"><span style={{ fontWeight: 600 }}>{r.label}</span>
              <span className="num muted">{r.score} / {r.max}{r.accuracy != null ? ` · ${pct(r.accuracy)} accuracy` : ''}</span></div>
            <div className={`bar ${p >= 60 ? 'ok' : p < 30 ? 'bad' : ''}`}><i style={{ width: `${p}%` }} /></div>
          </div>
        );
      })}
    </div>
  );
}
