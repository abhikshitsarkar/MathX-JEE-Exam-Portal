// PDF text extraction in the browser (pdf.js). Nothing is sent anywhere
// except the resulting text chunks, which go to the admin's own database.
import type { PageText } from './chunk';

export interface PdfInfo { pages: PageText[]; pageCount: number; title?: string; author?: string }

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function extractPdf(data: ArrayBuffer, onProgress?: (done: number, total: number) => void): Promise<PdfInfo> {
  // The legacy build bundles polyfills, so extraction also works in browsers
  // that are a few versions old.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
  const doc = await task.promise;
  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as { Title?: string; Author?: string };
  const pages: PageText[] = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let text = '';
    let lastY: number | null = null;
    let lastHeight = 0;
    for (const item of content.items as { str: string; transform: number[]; hasEOL?: boolean; height?: number }[]) {
      if (typeof item.str !== 'string') continue;
      const y = item.transform?.[5] ?? 0;
      if (lastY !== null && Math.abs(y - lastY) > 1) {
        // a large vertical jump means a new paragraph
        text += Math.abs(y - lastY) > Math.max(lastHeight, 8) * 1.8 ? '\n\n' : '\n';
      } else if (text && !text.endsWith(' ') && item.str && !item.str.startsWith(' ')) {
        text += ' ';
      }
      text += item.str;
      if (item.hasEOL) text += '\n';
      lastY = y;
      lastHeight = item.height ?? lastHeight;
    }
    pages.push({ page: n, text: text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim() });
    page.cleanup();
    onProgress?.(n, doc.numPages);
  }
  await task.destroy();
  return { pages, pageCount: pages.length, title: info.Title || undefined, author: info.Author || undefined };
}
