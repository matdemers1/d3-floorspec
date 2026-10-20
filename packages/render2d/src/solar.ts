/**
 * FS_energy in plan (FLR-T-16.1): the solar arrays on a level's roofs — each module a blue cell, the
 * array's footprint around them — the setbacks each face keeps from its eaves, ridges and rakes as tinted
 * strips, the way each face slopes and what it faces, and a tag on each array: "PV1 · 28 × 410 W · faces S".
 * One drawing for the editor's canvas, `renderPlan` and the PDF; the Solar layer shows, ghosts or hides it.
 * An array a corner of which is inside a setback (FS_energy 4.3) is outlined in the warning colour, dashed.
 */
import { compassOf, setbackBands, type SolarDrawing } from '@floorspec/engine';
import { num } from './format.js';
import { el, esc, linePath, ringsPath, type XY } from './svg.js';
import type { Palette } from './theme.js';

interface Draw {
  readonly s: number;
  readonly P: (p: readonly [number, number]) => XY;
}

/** What the Solar layer draws on a level, each a string of SVG (empty when there is nothing to draw). */
export interface SolarLayers {
  /** The setbacks' strips and each face's slope arrow: under the arrays. */
  readonly setbacks: string;
  /** The arrays: their modules and footprints. */
  readonly arrays: string;
  /** The arrays' tags and the faces' labels, over everything. */
  readonly tags: string;
}

export interface SolarDrawOptions {
  /** Draw the tags and the faces' labels; default true. */
  readonly labels?: boolean;
  /** Draw the setbacks' strips; default true. */
  readonly setbacks?: boolean;
  /** Arrays drawn as selected. */
  readonly highlight?: (id: string) => boolean;
}

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** "faces S · 2:12", "flat roof". */
export const faceWords = (bearing: number | null, pitch: { rise: number; run: number } | null): string =>
  bearing === null || pitch === null ? 'flat roof' : `faces ${compassOf(bearing)} · ${String(pitch.rise)}:${String(pitch.run)}`;

/** An array's tag: "PV1 · 28 × 410 W · faces S". */
export function arrayTagText(a: SolarDrawing['arrays'][number]): string {
  const facing = a.bearing === null ? 'flat' : `faces ${compassOf(a.bearing)}`;
  return `${a.id} · ${String(a.modules.length)} × ${String(a.moduleWatts)} W · ${facing}`;
}

function pill(at: XY, text: string, pal: Palette, attrs: Record<string, string>): string {
  const w = text.length * 5.7 + 18;
  const h = 18;
  return el(
    'g',
    attrs,
    el('rect', { x: num(at[0] - w / 2), y: num(at[1] - h / 2), width: num(w), height: h, rx: 5, fill: pal.paper, 'fill-opacity': 0.94, stroke: pal.hairline, 'stroke-width': 1 }) +
      el('text', { x: num(at[0]), y: num(at[1] + 3.5), 'font-size': 10, 'font-family': FONT, fill: pal.text, 'text-anchor': 'middle' }, esc(text)),
  );
}

const centroid = (pts: readonly XY[]): XY => {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
};

/** The arrays, setbacks and faces of the roofs on one level. */
export function solarLayers(drawing: SolarDrawing, level: string, f: Draw, pal: Palette, options: SolarDrawOptions = {}): SolarLayers {
  const labels = options.labels ?? true;
  const hi = options.highlight ?? (() => false);
  const faces = drawing.faces.filter((x) => x.level === level);
  const arrays = drawing.arrays.filter((a) => a.level === level);

  let setbacks = '';
  let tags = '';
  for (const face of faces) {
    let g = '';
    if (options.setbacks ?? true)
      for (const b of setbackBands(face)) g += el('path', { 'data-setback': b.kind, d: ringsPath([b.ring.map(f.P)]), fill: pal.setback, 'fill-opacity': 0.14, stroke: 'none' });
    // the slope: an arrow down it from the face's middle, as the board's "4:12 ↓"
    const poly = face.polygons[0]!;
    const c = centroid(poly.map((p) => f.P([p[0], p[1]])));
    if (face.downslope !== null) {
      const len = 22;
      const d: XY = [face.downslope[0], -face.downslope[1]];
      const tip: XY = [c[0] + d[0] * len, c[1] + d[1] * len];
      const tail: XY = [c[0] - d[0] * len, c[1] - d[1] * len];
      const n: XY = [-d[1], d[0]];
      g += el('path', { 'data-slope': face.key, d: linePath(tail, tip) + `M${num(tip[0] - d[0] * 6 + n[0] * 4)} ${num(tip[1] - d[1] * 6 + n[1] * 4)}L${num(tip[0])} ${num(tip[1])}L${num(tip[0] - d[0] * 6 - n[0] * 4)} ${num(tip[1] - d[1] * 6 - n[1] * 4)}`, stroke: pal.muted, 'stroke-width': 1.1, fill: 'none' });
    }
    setbacks += el('g', { 'data-face': face.key }, g);
    if (labels && !arrays.some((a) => (a.face === undefined ? a.roof : `${a.roof}:${String(a.face)}`) === face.key))
      tags += pill([c[0], c[1] + 30], `${face.roofName ?? face.roof} · ${faceWords(face.bearing, face.pitch)}`, pal, { 'data-face-tag': face.key });
  }

  let drawn = '';
  for (const a of arrays) {
    let g = '';
    for (const m of a.modules) g += el('path', { 'data-module': `${String(m.row)}:${String(m.column)}`, d: ringsPath([m.corners.map((p) => f.P([p[0], p[1]]))]), fill: pal.pv, stroke: pal.pvEdge, 'stroke-width': 0.8 });
    const ring = a.footprint.map(f.P);
    const warn = a.clear === false;
    g += el('path', {
      'data-footprint': a.id,
      d: ringsPath([ring]),
      fill: 'none',
      stroke: hi(a.id) ? pal.accent : warn ? pal.opening : pal.pv,
      'stroke-width': hi(a.id) ? 2.2 : 1.2,
      ...(warn ? { 'stroke-dasharray': '5 3' } : {}),
    });
    drawn += el('g', { 'data-array': a.id, 'data-id': a.id, ...(hi(a.id) ? { 'data-selected': '' } : {}), ...(warn ? { 'data-in-setback': '' } : {}) }, g);
    if (labels) {
      const top = Math.min(...ring.map((p) => p[1]));
      const c = centroid(ring);
      tags += pill([c[0], top - 13], arrayTagText(a), pal, { 'data-array-tag': a.id });
    }
  }
  return { setbacks, arrays: drawn, tags };
}

/** The extent the arrays add to a level's drawing, in base units. */
export function solarExtent(drawing: SolarDrawing, level: string): [number, number][] {
  return drawing.arrays.filter((a) => a.level === level).flatMap((a) => a.footprint);
}
