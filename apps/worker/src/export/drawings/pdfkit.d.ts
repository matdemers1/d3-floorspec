/**
 * The part of PDFKit (0.20, MIT) the drawing export uses. PDFKit ships no types and the
 * DefinitelyTyped package trails its releases, so the surface is declared here, narrowly.
 */
declare module 'pdfkit' {
  interface PDFDocumentOptions {
    size?: [number, number];
    margin?: number;
    autoFirstPage?: boolean;
    compress?: boolean;
    pdfVersion?: '1.3' | '1.4' | '1.5' | '1.6' | '1.7' | '1.7ext3';
    font?: string | Buffer;
    info?: Record<string, string | Date>;
    displayTitle?: boolean;
    lang?: string;
  }

  interface TextOptions {
    lineBreak?: boolean;
    baseline?: 'alphabetic' | 'top' | 'middle' | 'bottom' | number;
  }

  class PDFDocument {
    constructor(options?: PDFDocumentOptions);
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    addPage(options?: { size?: [number, number]; margin?: number }): this;
    registerFont(name: string, src: string | Buffer): this;
    font(name: string): this;
    fontSize(size: number): this;
    widthOfString(text: string): number;
    text(text: string, x: number, y: number, options?: TextOptions): this;
    save(): this;
    restore(): this;
    rotate(angle: number, options?: { origin?: [number, number] }): this;
    path(d: string): this;
    clip(rule?: 'even-odd' | 'nonzero'): this;
    lineWidth(w: number): this;
    lineCap(c: 'butt' | 'round' | 'square'): this;
    lineJoin(j: 'miter' | 'round' | 'bevel'): this;
    dash(length: number, options?: { space?: number }): this;
    undash(): this;
    fillColor(color: string): this;
    strokeColor(color: string): this;
    fill(color?: string, rule?: 'even-odd' | 'nonzero'): this;
    stroke(color?: string): this;
    fillAndStroke(fill?: string, stroke?: string, rule?: 'even-odd' | 'nonzero'): this;
    end(): void;
  }

  export default PDFDocument;
}
