// PDFKit ships no types; its declaration sits beside this file, and is referenced so that a package
// type-checking this source (the api) sees it too.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./pdfkit.d.ts" />
/**
 * The PDF writer (FLR-T-9.3): draws composed sheets with PDFKit, vector throughout, with the plan
 * fonts (Inter and JetBrains Mono, from @fontsource at pinned versions) embedded as subsets.
 *
 * Deterministic: the document's dates are the version's time, not the clock, so its file ID —
 * PDFKit hashes the info dictionary — is too; font subset tags derive from the font's place in the
 * document; streams are compressed by fflate, which has no randomness. The same sheets give the
 * same bytes.
 */
import { readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { planFontFiles } from '../../render/fonts.js';
import type { FontName, Measure, Prim, Sheet } from './sheet.js';

/** Font file index in `planFontFiles()` for each face the sheets use. */
const FACES: Readonly<Record<FontName, number>> = {
  sans: 0,
  'sans-medium': 1,
  'sans-bold': 2,
  mono: 3,
  'mono-medium': 4,
};

export interface PdfInfo {
  readonly title: string;
  readonly subject: string;
  /** The version's time: the PDF's creation and modification dates. */
  readonly date: Date;
  readonly keywords?: string;
}

export interface PdfCanvas {
  readonly measure: Measure;
  /** Draw the sheets, one page each, and finish the file. */
  write(sheets: readonly Sheet[]): Promise<Uint8Array>;
}

/**
 * Open a PDF: its fonts are registered first, so sheets can be composed with the same metrics the
 * file will be drawn with.
 */
export function openPdf(info: PdfInfo, fontDir?: string): PdfCanvas {
  const files = planFontFiles(fontDir);
  const fonts = Object.fromEntries(Object.entries(FACES).map(([name, i]) => [name, readFileSync(files[i]!)])) as Record<FontName, Buffer>;
  const doc = new PDFDocument({
    autoFirstPage: false,
    compress: true,
    pdfVersion: '1.7',
    font: fonts.sans,
    displayTitle: true,
    lang: 'en-US',
    info: {
      Title: info.title,
      Subject: info.subject,
      Creator: 'D3 Floorspec',
      Producer: 'D3 Floorspec (PDFKit)',
      CreationDate: info.date,
      ModDate: info.date,
      ...(info.keywords === undefined ? {} : { Keywords: info.keywords }),
    },
  });
  for (const [name, buf] of Object.entries(fonts)) doc.registerFont(name, buf);
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise<Uint8Array>((resolve, reject) => {
    doc.on('end', () => {
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    doc.on('error', reject);
  });

  const measure: Measure = (text, font, size) => doc.font(font).fontSize(size).widthOfString(text);

  const draw = (prims: readonly Prim[]): void => {
    for (const p of prims) {
      if (p.t === 'clip') {
        doc.save();
        doc.path(p.d).clip();
        draw(p.children);
        doc.restore();
        continue;
      }
      if (p.t === 'text') {
        const w = measure(p.text, p.font, p.size);
        const dx = p.anchor === 'middle' ? -w / 2 : p.anchor === 'end' ? -w : 0;
        doc.save();
        if (p.rotate !== undefined && p.rotate !== 0) doc.rotate(p.rotate, { origin: [p.x, p.y] });
        doc.font(p.font).fontSize(p.size).fillColor(p.color);
        doc.text(p.text, p.x + dx, p.y, { lineBreak: false, baseline: 'alphabetic' });
        doc.restore();
        continue;
      }
      doc.save();
      doc.path(p.d);
      if (p.width !== undefined) doc.lineWidth(p.width);
      if (p.cap !== undefined) doc.lineCap(p.cap);
      if (p.join !== undefined) doc.lineJoin(p.join);
      if (p.dash !== undefined && p.dash.length >= 2) doc.dash(p.dash[0]!, { space: p.dash[1]! });
      const rule = p.evenOdd === true ? 'even-odd' : 'nonzero';
      if (p.fill !== undefined && p.stroke !== undefined) doc.fillAndStroke(p.fill, p.stroke, rule);
      else if (p.fill !== undefined) doc.fill(p.fill, rule);
      else if (p.stroke !== undefined) doc.stroke(p.stroke);
      doc.restore();
    }
  };

  return {
    measure,
    write(sheets) {
      for (const s of sheets) {
        doc.addPage({ size: [s.width, s.height], margin: 0 });
        draw(s.prims);
      }
      doc.end();
      return done;
    },
  };
}
