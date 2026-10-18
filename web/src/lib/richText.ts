import katex from 'katex';

export interface Segment { kind: 'text' | 'inline' | 'display'; value: string }

/** Splits text into plain-text and LaTeX segments ($…$, $$…$$, \(…\), \[…\]). */
export function splitMath(src: string): Segment[] {
  const out: Segment[] = [];
  const re = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$(?!\s)(?:[^$\\\n]|\\[\s\S])+?(?<!\s)\$)/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ kind: 'text', value: src.slice(last, i) });
    const tok = m[0];
    if (tok.startsWith('$$')) out.push({ kind: 'display', value: tok.slice(2, -2) });
    else if (tok.startsWith('\\[')) out.push({ kind: 'display', value: tok.slice(2, -2) });
    else if (tok.startsWith('\\(')) out.push({ kind: 'inline', value: tok.slice(2, -2) });
    else out.push({ kind: 'inline', value: tok.slice(1, -1) });
    last = i + tok.length;
  }
  if (last < src.length) out.push({ kind: 'text', value: src.slice(last) });
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function renderText(s: string): string {
  return escapeHtml(s.replace(/\\\$/g, '$'))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

/** Safe HTML for question/solution text. KaTeX runs with trust disabled; plain text is escaped. */
export function renderRich(src: string | null | undefined): string {
  if (!src) return '';
  return splitMath(src).map((seg) => {
    if (seg.kind === 'text') return renderText(seg.value);
    try {
      return katex.renderToString(seg.value, {
        displayMode: seg.kind === 'display', throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml',
      });
    } catch {
      return `<code>${escapeHtml(seg.value)}</code>`;
    }
  }).join('');
}
