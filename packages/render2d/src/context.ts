/**
 * FS_context in plan (FS_context chapter 6, FLR-T-15.3): the street, the neighbours and the trees beyond
 * the lot in one neutral context style — thin grey lines, a grey tint, dashes, no materials and no
 * colour-plan fills — and a tag on each kind, so that context never reads as the design (6.1.1). One
 * drawing for the editor's canvas, `renderPlan` and the PDF; the Context layer shows, ghosts or hides it.
 *
 * - **streets** the carriageway tinted between its curb faces, the curbs and the sidewalks' backs in thin
 *   grey, the strips' edges dotted, the centreline dashed, and the street's name along it;
 * - **neighbours** the footprint tinted and hatched, its outline dashed, its ridge dash-dotted;
 * - **trees** the crown a dashed circle, the trunk a dot;
 * - **tags** "Context · street, curb, sidewalk", "Context · neighbour massing", "Context · trees beyond the
 *   lot" — a dashed pill by the first of each.
 */
import type { ContextDrawing } from '@floorspec/engine';
import { num } from './format.js';
import { el, esc, polylinePath, ringsPath, type XY } from './svg.js';
import type { Palette } from './theme.js';

interface Draw {
  readonly s: number;
  readonly P: (p: readonly [number, number]) => XY;
}

/** What the Context layer draws, each a string of SVG (empty when there is nothing to draw). */
export interface ContextLayers {
  /** Streets: under everything. */
  readonly ground: string;
  /** Neighbours' massing. */
  readonly massing: string;
  /** Trees beyond the lot. */
  readonly trees: string;
  /** The tags and the street names, over everything. */
  readonly tags: string;
  /** The hatch the massing uses: put once in a `<defs>`. */
  readonly defs: string;
}

export interface ContextDrawOptions {
  /** Draw the tags and names; default true. */
  readonly labels?: boolean;
  /** A prefix for the pattern IDs. */
  readonly idPrefix?: string;
  /** Records drawn as selected. */
  readonly highlight?: (id: string) => boolean;
}

/** The tag's words for each kind (the P15/Context tag component). */
export const CONTEXT_TAGS = {
  streets: 'Context · street, curb, sidewalk',
  neighbours: 'Context · neighbour massing',
  trees: 'Context · trees beyond the lot',
} as const;

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** A tag: the words in a dashed pill, centred at `at`. */
export function contextTag(at: XY, text: string, pal: Palette, kind: string): string {
  const w = text.length * 5.6 + 16;
  const h = 18;
  return el(
    'g',
    { 'data-context-tag': kind },
    el('rect', { x: num(at[0] - w / 2), y: num(at[1] - h / 2), width: num(w), height: h, rx: 9, fill: pal.paper, 'fill-opacity': 0.92, stroke: pal.context, 'stroke-width': 1, 'stroke-dasharray': '3 2' }) +
      el('text', { x: num(at[0]), y: num(at[1] + 3.5), 'font-size': 10, 'font-family': FONT, fill: pal.contextInk, 'text-anchor': 'middle' }, esc(text)),
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

/** The context's layers in plan. */
export function contextLayers(ctx: ContextDrawing, f: Draw, pal: Palette, options: ContextDrawOptions = {}): ContextLayers {
  const labels = options.labels ?? true;
  const hatchId = `${options.idPrefix ?? 'fs'}-context-hatch`;
  const hi = options.highlight ?? (() => false);
  const defs = el(
    'pattern',
    { id: hatchId, patternUnits: 'userSpaceOnUse', width: 8, height: 8, patternTransform: 'rotate(45)' },
    el('rect', { width: 8, height: 8, fill: pal.contextFill }) + el('path', { d: 'M0 0V8', stroke: pal.context, 'stroke-width': 0.6, 'stroke-opacity': 0.55 }),
  );
  const line = { fill: 'none', stroke: pal.context, 'stroke-width': 0.8 } as const;

  // ── streets: the carriageway tinted, curbs and sidewalks in thin grey ──
  let ground = '';
  let tags = '';
  for (const s of ctx.streets) {
    const ring = (r: readonly (readonly [number, number])[]): XY[] => r.map(f.P);
    let g = el('path', { 'data-carriageway': '', d: ringsPath([ring(s.carriageway)]), fill: pal.contextPave, stroke: 'none' });
    for (const c of s.curbs) g += el('path', { 'data-curb': '', d: ringsPath([ring(c)]), fill: pal.contextFill, stroke: 'none' });
    for (const w of s.sidewalks) g += el('path', { 'data-sidewalk': '', d: ringsPath([ring(w)]), fill: pal.contextFill, 'fill-opacity': 0.6, stroke: 'none' });
    for (const l of s.curbLines) g += el('path', { d: polylinePath(l.map(f.P)), ...line, 'stroke-width': 1 });
    for (const st of s.strips) g += el('path', { 'data-strip': '', d: ringsPath([ring(st)]), fill: pal.contextFill, 'fill-opacity': 0.3, stroke: pal.context, 'stroke-width': 0.8, 'stroke-dasharray': '1 3', 'stroke-linecap': 'round' });
    for (const l of s.backLines) g += el('path', { d: polylinePath(l.map(f.P)), ...line });
    g += el('path', { 'data-centreline': '', d: polylinePath(s.centreline.map(f.P)), ...line, 'stroke-width': 0.9, 'stroke-dasharray': '14 8' });
    ground += el('g', { 'data-context': 'street', 'data-id': s.id, ...(hi(s.id) ? { 'data-selected': '' } : {}) }, g);
    if (labels && s.name !== undefined) {
      // the name along the longest segment, on the far side of the centreline, upright
      let best = 0;
      let at: XY = f.P(s.centreline[0]!);
      let angle = 0;
      for (let i = 0; i + 1 < s.centreline.length; i++) {
        const a = f.P(s.centreline[i]!);
        const b = f.P(s.centreline[i + 1]!);
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (l > best) {
          best = l;
          at = [a[0] + (b[0] - a[0]) * 0.18, a[1] + (b[1] - a[1]) * 0.18];
          angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
        }
      }
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      tags += el('text', { 'data-street-name': s.id, x: num(at[0]), y: num(at[1] - 6), 'font-size': 10, 'font-family': FONT, fill: pal.contextInk, transform: `rotate(${num(angle)} ${num(at[0])} ${num(at[1])})` }, esc(s.name));
    }
    if (labels && s === ctx.streets[0]) {
      const c = s.centreline.map(f.P);
      const m = c.length === 2 ? [(c[0]![0] + c[1]![0]) / 2, (c[0]![1] + c[1]![1]) / 2] : c[Math.floor(c.length / 2)]!;
      tags += contextTag([m[0]!, m[1]! + 12], CONTEXT_TAGS.streets, pal, 'streets');
    }
  }

  // ── neighbours: a tinted, hatched footprint, dashed, and its ridge ──
  let massing = '';
  for (const n of ctx.neighbours) {
    const ring = n.footprint.map(f.P);
    let g = el('path', { d: ringsPath([ring]), fill: `url(#${hatchId})`, stroke: pal.context, 'stroke-width': hi(n.id) ? 2 : 1, 'stroke-dasharray': '6 3' });
    if (n.ridgeLine && n.ridgeLine.length === 2) {
      g += el('path', { 'data-ridge': '', d: polylinePath(n.ridgeLine.map(f.P)), ...line, 'stroke-dasharray': '10 3 2 3' });
      // hips: the ridge's ends to the corners
      if (n.roof === 'hip') {
        const [r0, r1] = n.ridgeLine.map(f.P) as [XY, XY];
        const d = ring.map((p) => {
          const d0 = Math.hypot(p[0] - r0[0], p[1] - r0[1]);
          const d1 = Math.hypot(p[0] - r1[0], p[1] - r1[1]);
          const r = d0 < d1 ? r0 : r1;
          return `M${num(p[0])} ${num(p[1])}L${num(r[0])} ${num(r[1])}`;
        });
        g += el('path', { d: d.join(''), ...line, 'stroke-width': 0.6 });
      }
    } else if (n.ridgeLine && n.ridgeLine.length === 1) {
      const r = f.P(n.ridgeLine[0]!);
      g += el('path', { d: ring.map((p) => `M${num(p[0])} ${num(p[1])}L${num(r[0])} ${num(r[1])}`).join(''), ...line, 'stroke-width': 0.6 });
    }
    massing += el('g', { 'data-context': 'neighbour', 'data-id': n.id, ...(hi(n.id) ? { 'data-selected': '' } : {}) }, g);
  }
  if (labels) {
    // a tag on the two neighbours furthest apart: the design's "neighbour massing" either side
    const shown = ctx.neighbours.slice(0, 2);
    for (const n of shown) {
      const ring = n.footprint.map(f.P);
      const c = centroid(ring);
      const top = Math.min(...ring.map((p) => p[1]));
      tags += contextTag([c[0], top - 14], CONTEXT_TAGS.neighbours, pal, 'neighbours');
    }
  }

  // ── trees: a dashed crown and a trunk ──
  let trees = '';
  for (const t of ctx.trees) {
    const [x, y] = f.P(t.at);
    const r = (t.spread / 2) * f.s;
    trees += el(
      'g',
      { 'data-context': 'tree', 'data-id': t.id, ...(hi(t.id) ? { 'data-selected': '' } : {}) },
      el('circle', { cx: num(x), cy: num(y), r: num(r), fill: pal.contextFill, 'fill-opacity': 0.35, stroke: pal.context, 'stroke-width': hi(t.id) ? 2 : 0.9, 'stroke-dasharray': t.form === 'evergreen' ? '2 2' : '5 3' }) +
        el('circle', { cx: num(x), cy: num(y), r: 1.6, fill: pal.context }),
    );
  }
  if (labels && ctx.trees.length > 0) {
    // the tag by the tree furthest from the street's first point, where the design puts it: beyond the lot's rear
    const ref = ctx.streets[0]?.centreline[0];
    const far = ref === undefined ? ctx.trees[0]! : [...ctx.trees].sort((a, b) => Math.hypot(b.at[0] - ref[0], b.at[1] - ref[1]) - Math.hypot(a.at[0] - ref[0], a.at[1] - ref[1]))[0]!;
    const [x, y] = f.P(far.at);
    tags += contextTag([x, y - (far.spread / 2) * f.s - 12], CONTEXT_TAGS.trees, pal, 'trees');
  }
  return { ground, massing, trees, tags, defs };
}

/** The extent context adds to a drawing, in base units: every street's bands, every footprint, every crown. */
export function contextExtent(ctx: ContextDrawing): [number, number][] {
  const out: [number, number][] = [];
  for (const s of ctx.streets) for (const l of s.backLines) out.push(...l);
  for (const n of ctx.neighbours) out.push(...n.footprint);
  for (const t of ctx.trees) out.push([t.at[0] - t.spread / 2, t.at[1] - t.spread / 2], [t.at[0] + t.spread / 2, t.at[1] + t.spread / 2]);
  return out;
}
