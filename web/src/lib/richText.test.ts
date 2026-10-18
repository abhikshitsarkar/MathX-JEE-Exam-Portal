import { describe, expect, it } from 'vitest';
import { chunkPages, isHeading, needsOcr } from './chunk';
import { renderRich, splitMath } from './richText';

describe('splitMath / renderRich', () => {
  it('separates inline and display maths', () => {
    expect(splitMath('Find $x^2$ if $$y=1$$ and \\(z\\).').map((s) => s.kind)).toEqual(['text', 'inline', 'text', 'display', 'text', 'inline', 'text']);
  });
  it('does not treat currency-like dollars or escaped dollars as maths', () => {
    expect(splitMath('costs \\$5 and \\$7').every((s) => s.kind === 'text')).toBe(true);
  });
  it('escapes HTML in plain text (no script injection)', () => {
    const html = renderRich('<img src=x onerror=alert(1)> and $\\frac12$');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('katex');
  });
  it('keeps KaTeX safe from \\href and \\url', () => {
    expect(renderRich('$\\href{javascript:alert(1)}{x}$')).not.toMatch(/href=/);
  });
  it('renders bold and line breaks', () => {
    expect(renderRich('**Given**\nnext')).toBe('<strong>Given</strong><br>next');
  });
});

describe('chunkPages', () => {
  const para = (n: number) => `Sentence ${n} about kinematics and motion in one dimension. `.repeat(6);
  const pages = Array.from({ length: 6 }, (_, i) => ({ page: i + 1, text: `${i === 0 ? 'Chapter 3 Motion in a Straight Line\n\n' : ''}${para(i)}\n\n${para(i + 10)}` }));
  it('creates overlapping chunks with page ranges and headings', () => {
    const chunks = chunkPages(pages, 900, 150);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0].page_start).toBe(1);
    expect(chunks[0].heading).toBe('Chapter 3 Motion in a Straight Line');
    expect(chunks.every((c) => c.content.length <= 7900)).toBe(true);
    expect(chunks.at(-1)!.page_end).toBe(6);
    // overlap: the start of chunk 2 repeats text from the end of chunk 1
    const tail = chunks[0].content.slice(-60);
    expect(chunks[1].content.includes(tail.slice(-30))).toBe(true);
  });
  it('detects headings and scanned PDFs', () => {
    expect(isHeading('Chapter 7 Gravitation')).toBe(true);
    expect(isHeading('4.2 Projectile Motion')).toBe(true);
    expect(isHeading('This is an ordinary sentence that goes on.')).toBe(false);
    expect(needsOcr([{ page: 1, text: '  ' }, { page: 2, text: '12' }])).toBe(true);
    expect(needsOcr(pages)).toBe(false);
  });
});
