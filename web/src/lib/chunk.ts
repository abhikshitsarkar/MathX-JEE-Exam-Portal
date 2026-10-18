// Splits extracted PDF text into overlapping chunks for retrieval. Runs in
// the admin's browser so large textbooks cost nothing server-side.
export interface PageText { page: number; text: string }
export interface Chunk { index: number; page_start: number; page_end: number; heading: string | null; content: string; token_estimate: number }

const HEADING = /^(chapter|unit|section|part|module|exercise)\s+[\dIVXivx]+[.:]?\s*.{0,80}$|^\d{1,2}(\.\d{1,2}){0,2}\s+[A-Z][^.!?]{2,80}$/i;

export function isHeading(line: string): boolean {
  const t = line.trim();
  return t.length >= 4 && t.length <= 90 && HEADING.test(t);
}

/** Average characters of text per page; very low values mean a scanned PDF that needs OCR. */
export function textDensity(pages: PageText[]): number {
  if (!pages.length) return 0;
  return pages.reduce((a, p) => a + p.text.replace(/\s+/g, '').length, 0) / pages.length;
}

export function needsOcr(pages: PageText[]): boolean {
  return pages.length > 0 && textDensity(pages) < 80;
}

function tailForOverlap(text: string, overlap: number): string {
  if (overlap <= 0 || text.length <= overlap) return overlap > 0 ? text : '';
  const tail = text.slice(-overlap);
  // start the overlap at a sentence or paragraph boundary when possible
  const cut = tail.search(/[.!?]\s+[A-Z(]|\n/);
  return cut >= 0 && cut < tail.length - 40 ? tail.slice(cut + 1).trimStart() : tail;
}

export function chunkPages(pages: PageText[], chunkChars = 2400, overlap = 300): Chunk[] {
  const chunks: Chunk[] = [];
  let buf = '';
  let start = pages[0]?.page ?? 1;
  let end = start;
  let heading: string | null = null;
  let chunkHeading: string | null = null;

  const flush = () => {
    const content = buf.trim();
    if (content.length >= 40) {
      chunks.push({
        index: chunks.length, page_start: start, page_end: end, heading: chunkHeading,
        content: content.slice(0, 7900), token_estimate: Math.ceil(content.length / 4),
      });
    }
  };

  for (const page of pages) {
    // paragraphs = blank-line separated; fall back to lines for very dense pages
    const paras = page.text.replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    for (const para of paras) {
      const firstLine = para.split('\n')[0];
      if (isHeading(firstLine)) heading = firstLine.trim().replace(/\s+/g, ' ');
      // never split inside an equation or a paragraph; split huge paragraphs at sentence ends
      const pieces = para.length > chunkChars
        ? para.match(new RegExp(`[\\s\\S]{1,${chunkChars}}(?=[.!?]\\s|$)|[\\s\\S]{1,${chunkChars}}`, 'g')) ?? [para]
        : [para];
      for (const piece of pieces) {
        if (buf && buf.length + piece.length + 2 > chunkChars) {
          flush();
          const carry = tailForOverlap(buf, overlap);
          buf = carry ? `${carry}\n\n` : '';
          start = carry ? end : page.page;
          chunkHeading = heading;
        }
        if (!buf) { start = page.page; chunkHeading = heading; }
        buf += `${piece}\n\n`;
        end = page.page;
      }
    }
  }
  flush();
  return chunks;
}
