/**
 * A plan PDF as an image (FLR-T-18.12): one page of a listing PDF, a builder's set or an exported
 * drawing, rasterised in the browser with pdf.js and uploaded as a PNG — so the server never parses
 * a PDF, and the asset store keeps only the image formats it already checks and strips (FLR-T-8.2).
 *
 * pdf.js is loaded the first time a PDF is picked, never with the editor: it and its worker are
 * their own chunks. Fonts a PDF does not embed fall back to the system's (pdf.js's default in a
 * browser). Its WebAssembly decoders are not served, so a page drawn with a JPEG 2000 or JBIG2 image
 * — rare in a plan — leaves that image out; the panel's preview shows the page as it was drawn
 * before anything is traced.
 */

/** The longest side a page is drawn at: about 300 dpi on a letter page, and well inside the store's 16,384 px. */
export const PAGE_PIXELS = 3300;

export interface PdfFile {
  pages: number;
  /** Draw one page (1-based) as a PNG, its longest side `PAGE_PIXELS`. */
  render(page: number): Promise<{ blob: Blob; width: number; height: number }>;
  close(): Promise<void>;
}

/** Whether these bytes are a PDF: "%PDF-" within its first kilobyte, as readers accept. */
export function looksLikePdf(head: Uint8Array): boolean {
  const text = new TextDecoder('latin1').decode(head.subarray(0, 1024));
  return text.includes('%PDF-');
}

export async function openPdf(bytes: ArrayBuffer): Promise<PdfFile> {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useWasm: false, enableXfa: false });
  const doc = await task.promise;
  return {
    pages: doc.numPages,
    async render(n) {
      const page = await doc.getPage(Math.min(Math.max(1, Math.round(n)), doc.numPages));
      const unit = page.getViewport({ scale: 1 });
      const scale = PAGE_PIXELS / Math.max(unit.width, unit.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('this browser cannot draw the page');
      // Paper is white: a page with no background of its own is not transparent on the plan.
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      page.cleanup();
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => {
          if (b === null) reject(new Error('the page could not be turned into an image'));
          else resolve(b);
        }, 'image/png');
      });
      return { blob, width: canvas.width, height: canvas.height };
    },
    async close() {
      await task.destroy();
    },
  };
}
