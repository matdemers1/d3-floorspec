import type { Drawing } from './SectionOverlay';

/**
 * A still of the section box or the exploded view (FLR-T-14.6): the canvas's picture as drawn now —
 * raster, as the view draws it, never the path tracer (three-gpu-pathtracer 0.0.27 has no clipping
 * planes, and the worker's tracer cuts nothing) — with the exploded view's leader labels and plumb
 * lines drawn over it. As a PNG, everything in pixels; as an SVG, the picture embedded and the labels
 * and lines as vectors, so they stay sharp and editable.
 */

export type StillFormat = 'png' | 'svg';

/** The design system's colours and type where the view sits, read when the still is made. */
export interface StillStyle {
  surface: string;
  border: string;
  fg: string;
  muted: string;
  sans: string;
  mono: string;
}

export function styleOf(el: Element): StillStyle {
  const s = getComputedStyle(el);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    surface: v('--color-surface-raised', 'white'),
    border: v('--color-border-float', 'gray'),
    fg: v('--color-fg', 'black'),
    muted: v('--color-fg-muted', 'gray'),
    sans: v('--font-sans', 'sans-serif'),
    mono: v('--font-mono', 'monospace'),
  };
}

const LEADER = 32;
const PAD_X = 10;
const PAD_Y = 6;
const TITLE = 12;
const SUB = 11;

/** A label's pill, CSS pixels: centred over its pin, its leader and dot under it. */
function pillOf(ctxWidth: (text: string, font: string) => number, l: Drawing['labels'][number], s: StillStyle, width: number) {
  const w = Math.max(ctxWidth(l.title, `500 ${String(TITLE)}px ${s.sans}`), ctxWidth(l.sub, `500 ${String(SUB)}px ${s.mono}`)) + 2 * PAD_X;
  const h = PAD_Y * 2 + TITLE * 1.5 + 1 + SUB * 1.3;
  let x = l.x - w / 2;
  x = Math.min(Math.max(8, x), width - 8 - w);
  const y = l.y - 3.5 - LEADER - h;
  return { x, y, w, h };
}

/** The picture with the drawing over it, as a PNG. */
export async function stillPng(picture: HTMLCanvasElement, drawing: Drawing | null, s: StillStyle): Promise<Blob> {
  const out = document.createElement('canvas');
  out.width = picture.width;
  out.height = picture.height;
  const ctx = out.getContext('2d');
  if (ctx === null) throw new Error('this browser gave no 2D canvas');
  ctx.drawImage(picture, 0, 0);
  if (drawing !== null && drawing.width > 0) {
    const k = picture.width / drawing.width;
    ctx.scale(k, k);
    ctx.strokeStyle = s.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (const p of drawing.plumb) {
      ctx.beginPath();
      ctx.moveTo(p.x1, p.y1);
      ctx.lineTo(p.x2, p.y2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const measure = (text: string, font: string) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    };
    for (const l of drawing.labels) {
      const b = pillOf(measure, l, s, drawing.width);
      ctx.fillStyle = s.muted;
      ctx.fillRect(l.x - 0.5, l.y - 3.5 - LEADER, 1, LEADER);
      ctx.beginPath();
      ctx.arc(l.x, l.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = s.surface;
      ctx.fill();
      ctx.strokeStyle = s.fg;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, 8);
      ctx.fillStyle = s.surface;
      ctx.fill();
      ctx.strokeStyle = s.border;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = s.fg;
      ctx.font = `500 ${String(TITLE)}px ${s.sans}`;
      ctx.textBaseline = 'top';
      ctx.fillText(l.title, b.x + PAD_X, b.y + PAD_Y + 2);
      ctx.fillStyle = s.muted;
      ctx.font = `500 ${String(SUB)}px ${s.mono}`;
      ctx.fillText(l.sub, b.x + PAD_X, b.y + PAD_Y + TITLE * 1.5 + 2);
    }
  }
  return new Promise((resolve, reject) => {
    out.toBlob((b) => { if (b === null) reject(new Error('the canvas gave no picture')); else resolve(b); }, 'image/png');
  });
}

const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The picture embedded in an SVG, its labels and plumb lines as vectors. */
export function stillSvg(picture: HTMLCanvasElement, drawing: Drawing | null, s: StillStyle): Blob {
  const width = drawing?.width ?? picture.width;
  const height = drawing?.height ?? picture.height;
  const png = picture.toDataURL('image/png');
  const measure = document.createElement('canvas').getContext('2d');
  const textWidth = (text: string, font: string) => {
    if (measure === null) return text.length * 7;
    measure.font = font;
    return measure.measureText(text).width;
  };
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}">`,
    `<image href="${png}" x="0" y="0" width="${String(width)}" height="${String(height)}"/>`,
  ];
  for (const p of drawing?.plumb ?? []) parts.push(`<line x1="${p.x1.toFixed(1)}" y1="${p.y1.toFixed(1)}" x2="${p.x2.toFixed(1)}" y2="${p.y2.toFixed(1)}" stroke="${esc(s.muted)}" stroke-dasharray="4 4"/>`);
  for (const l of drawing?.labels ?? []) {
    const b = pillOf(textWidth, l, s, width);
    parts.push(
      `<g class="leader-label">`,
      `<line x1="${l.x.toFixed(1)}" y1="${(l.y - 3.5 - LEADER).toFixed(1)}" x2="${l.x.toFixed(1)}" y2="${(l.y - 3.5).toFixed(1)}" stroke="${esc(s.muted)}"/>`,
      `<circle cx="${l.x.toFixed(1)}" cy="${l.y.toFixed(1)}" r="3" fill="${esc(s.surface)}" stroke="${esc(s.fg)}" stroke-width="1.5"/>`,
      `<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="8" fill="${esc(s.surface)}" stroke="${esc(s.border)}"/>`,
      `<text x="${(b.x + PAD_X).toFixed(1)}" y="${(b.y + PAD_Y + TITLE).toFixed(1)}" font-family="${esc(s.sans)}" font-size="${String(TITLE)}" font-weight="500" fill="${esc(s.fg)}">${esc(l.title)}</text>`,
      `<text x="${(b.x + PAD_X).toFixed(1)}" y="${(b.y + PAD_Y + TITLE * 1.5 + SUB).toFixed(1)}" font-family="${esc(s.mono)}" font-size="${String(SUB)}" font-weight="500" fill="${esc(s.muted)}">${esc(l.sub)}</text>`,
      `</g>`,
    );
  }
  parts.push('</svg>');
  return new Blob([parts.join('\n')], { type: 'image/svg+xml' });
}

/** Hand a file to the browser to save. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
}

/** A file name from the project's: "Courtyard House — section.png". */
export const stillName = (project: string, what: 'section' | 'exploded', format: StillFormat): string => `${project.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Floorspec'} — ${what === 'section' ? 'section' : 'exploded axonometric'}.${format}`;
