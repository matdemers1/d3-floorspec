/**
 * FS_outdoor in plan (FS_outdoor chapter 4, FLR-T-15.2): the rooms a house has outdoors, as the
 * "P15 · Site and landscape" board draws them.
 *
 * - a **pool** is its coping, a frame in pale stone, round its water — blue, with a few ripples;
 * - a **fence** is its line swept to its width in timber (a garden wall in the wall's grey), its posts
 *   as dots at the spacing FS_outdoor derives (6.3), and each **gate** an opening in it with its leaf
 *   and swing, as a door is drawn — or, sliding, its leaf along the line;
 * - a **kitchen** is its counter, its appliances along its run in their order, each with its mark;
 * - a **fire** is a ring with a warm centre — a pit, a bowl — or a table's or a fireplace's hearth;
 * - a **shelter** is over everything: its posts solid (6.4), its beams and rafters — a porch's roof,
 *   a sail — dashed, since they are overhead.
 *
 * Geometry is the element's own, from its frame (its placement's point and facing; the level's own for
 * a fence with no host), through the engine's drawing helpers — so the posts drawn are the posts
 * derived. Round things use a written-out table of 24 cosines, so the SVG is the same text in every
 * JavaScript engine.
 */
import { facingVector, outdoor } from '@floorspec/engine';
import type { Pt } from './scene.js';
import { el, linePath, polylinePath, ringsPath, type XY } from './svg.js';
import type { Palette } from './theme.js';

type Json = Record<string, unknown>;
type Quad = readonly [Pt, Pt, Pt, Pt];

/** A gate in plan: its two ends along the line, the side it swings to, its leaves. */
export interface SceneGate {
  readonly a: Pt;
  readonly b: Pt;
  /** Unit vector to the side it opens to (the line's left walking from its start, for `left`). */
  readonly side: Pt;
  readonly swing: 'left' | 'right' | 'slide';
  readonly leaves: 1 | 2;
}

/** What an FS_outdoor element is in plan, in base units. */
export type SceneOutdoor =
  | { readonly kind: 'pool'; readonly form: string; readonly outer: Quad; readonly basin: Quad }
  | { readonly kind: 'fence'; readonly form: string; readonly line: readonly Pt[]; readonly width: number; readonly posts: readonly Pt[]; readonly gates: readonly SceneGate[] }
  | { readonly kind: 'shelter'; readonly top: string; readonly outline: Quad; readonly postSize: number; readonly posts: readonly Pt[]; readonly beams: readonly (readonly [Pt, Pt])[]; readonly rafters: readonly (readonly [Pt, Pt])[]; readonly attached: boolean }
  | { readonly kind: 'kitchen'; readonly outline: Quad; readonly cells: readonly { readonly appliance: string; readonly quad: Quad }[] }
  | { readonly kind: 'fire'; readonly form: string; readonly outline: Quad; readonly centre: Pt; readonly radius: number };

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const int = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** cos(15° · k), k = 0 … 23, written out (as @floorspec/mesh's circle table). */
const Q = [1, 0.9659258262890683, 0.8660254037844387, 0.7071067811865476, 0.5, 0.25881904510252074, 0] as const;
const COS: readonly number[] = Array.from({ length: 24 }, (_, k) => (k <= 6 ? Q[k]! : k <= 12 ? -Q[12 - k]! : k <= 18 ? -Q[k - 12]! : Q[24 - k]!));
const SIN: readonly number[] = Array.from({ length: 24 }, (_, k) => COS[(k + 18) % 24]!);

const points = (v: unknown): [number, number][] =>
  Array.isArray(v) ? v.filter((p): p is [number, number] => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number').map((p) => [p[0], p[1]]) : [];

function boxOf(element: Json): { min: [number, number, number]; max: [number, number, number] } | undefined {
  const box = isObject(element['fallback']) ? element['fallback']['box'] : undefined;
  if (!isObject(box) || !Array.isArray(box['min']) || !Array.isArray(box['max'])) return undefined;
  const [x0 = 0, y0 = 0, z0 = 0] = box['min'] as number[];
  const [x1 = 0, y1 = 0, z1 = 0] = box['max'] as number[];
  return { min: [x0, y0, z0], max: [x1, y1, z1] };
}

/**
 * An FS_outdoor element in plan: its geometry taken from its frame — its placement's point and facing,
 * or the level's own frame when it has no host. Undefined for an element of another extension, or one
 * whose geometry is missing.
 */
export function outdoorOf(collection: string, element: Json, placement: { readonly point: readonly number[]; readonly facing: number } | undefined): SceneOutdoor | undefined {
  const [fx, fy] = facingVector(placement?.facing ?? 0);
  const k = Math.sqrt(Number(fx) * Number(fx) + Number(fy) * Number(fy));
  const u: XY = [Number(fx) / k, Number(fy) / k];
  const o: XY = placement === undefined ? [0, 0] : [placement.point[0] ?? 0, placement.point[1] ?? 0];
  const plan = (x: number, y: number): Pt => [o[0] + x * u[0] - y * u[1], o[1] + x * u[1] + y * u[0]];
  const dirOf = (x: number, y: number): Pt => [x * u[0] - y * u[1], x * u[1] + y * u[0]];
  const quad = (x0: number, y0: number, x1: number, y1: number): Quad => [plan(x0, y0), plan(x1, y0), plan(x1, y1), plan(x0, y1)];

  if (collection === 'fences') {
    const local = points(element['points']);
    const width = element['width'];
    if (local.length < 2 || typeof width !== 'number') return undefined;
    const spacing = int(element['postSpacing'], outdoor.DEFAULTS.fencePostSpacing);
    const total = outdoor.fenceLength(local);
    const gates: SceneGate[] = [];
    for (const g of Array.isArray(element['gates']) ? (element['gates'] as unknown[]) : []) {
      if (!isObject(g) || typeof g['offset'] !== 'number' || typeof g['width'] !== 'number') continue;
      const s = outdoor.alongLine(local, Math.min(g['offset'], total));
      const e = outdoor.alongLine(local, Math.min(g['offset'] + g['width'], total));
      const swing = g['swing'] === 'right' || g['swing'] === 'slide' ? g['swing'] : 'left';
      // the line's left, walking from its start, is +90° from its direction; the right, −90°
      const n: Pt = swing === 'right' ? dirOf(s.dir[1], -s.dir[0]) : dirOf(-s.dir[1], s.dir[0]);
      gates.push({ a: plan(s.at[0], s.at[1]), b: plan(e.at[0], e.at[1]), side: n, swing, leaves: g['leaves'] === 2 ? 2 : 1 });
    }
    return {
      kind: 'fence',
      form: str(element['form'], 'fence'),
      line: local.map(([x, y]) => plan(x, y)),
      width,
      posts: outdoor.fencePosts(local, spacing).map(([x, y]) => plan(x, y)),
      gates,
    };
  }
  const box = boxOf(element);
  if (box === undefined) return undefined;
  const [x0, y0] = box.min;
  const [x1, y1] = box.max;
  const outline = quad(x0, y0, x1, y1);
  if (collection === 'pools') {
    const c = Math.max(0, Math.min(int(element['coping'], outdoor.DEFAULTS.coping), (x1 - x0) / 2, (y1 - y0) / 2));
    return { kind: 'pool', form: str(element['form'], 'pool'), outer: outline, basin: quad(x0 + c, y0 + c, x1 - c, y1 - c) };
  }
  if (collection === 'shelters') {
    const el0 = { fallback: { box }, ...(typeof element['postSize'] === 'number' ? { postSize: element['postSize'] } : {}), ...(typeof element['postSpacing'] === 'number' ? { postSpacing: element['postSpacing'] } : {}), attached: element['attached'] === true };
    const size = int(element['postSize'], outdoor.DEFAULTS.postSize);
    const X = x1 - x0;
    const Y = y1 - y0;
    if (!(size < X && size < Y) || !(int(element['postSpacing'], outdoor.DEFAULTS.postSpacing) > size)) return { kind: 'shelter', top: str(element['top'], 'slats'), outline, postSize: size, posts: [], beams: [], rafters: [], attached: el0.attached };
    const posts = outdoor.shelterPosts(el0).map(([px, py]) => plan(x0 + px, y0 + py));
    // beams along x on the posts at min.y and max.y; rafters across them along y, every rafterSpacing along x
    const yb = [y0 + size / 2, y1 - size / 2];
    const beams = yb.map((y): readonly [Pt, Pt] => [plan(x0, y), plan(x1, y)]);
    const rs = Math.max(int(element['rafterSpacing'], outdoor.DEFAULTS.rafterSpacing), 1280);
    const n = Math.max(1, Math.round(X / rs));
    const rafters: (readonly [Pt, Pt])[] = [];
    for (let i = 0; i <= n; i++) {
      const x = x0 + size / 2 + ((X - size) * i) / n;
      rafters.push([plan(x, y0), plan(x, y1)]);
    }
    return { kind: 'shelter', top: str(element['top'], 'slats'), outline, postSize: size, posts, beams, rafters, attached: el0.attached };
  }
  if (collection === 'kitchens') {
    const list = Array.isArray(element['appliances']) ? (element['appliances'] as unknown[]).filter((a): a is string => typeof a === 'string') : [];
    const Y = y1 - y0;
    const X = x1 - x0;
    // each appliance a cell of the run, from its right end (min y), on the counter's front two-thirds
    const cell = list.length === 0 ? 0 : Math.min(Y / list.length, 900 * 1280);
    const gap = list.length === 0 ? 0 : (Y - cell * list.length) / (list.length + 1);
    const inset = Math.min(X * 0.12, 60 * 1280);
    const cells = list.map((appliance, i) => {
      const ya = y0 + gap + i * (cell + gap);
      return { appliance, quad: quad(x0 + X * 0.2, ya + inset, x1 - inset, ya + cell - inset) };
    });
    return { kind: 'kitchen', outline, cells };
  }
  if (collection === 'fires') {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    return { kind: 'fire', form: str(element['form'], 'pit'), outline, centre: plan(cx, cy), radius: Math.min(x1 - x0, y1 - y0) / 2 };
  }
  return undefined;
}

interface Draw {
  readonly s: number;
  readonly P: (p: Pt) => XY;
}

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** A circle about a centre as a 24-gon. */
const circle = (f: Draw, c: Pt, r: number): string => ringsPath([Array.from({ length: 24 }, (_, k) => f.P([c[0] + r * COS[k]!, c[1] + r * SIN[k]!]))]);

/** A quarter arc from `from` (at radius r along u) to r along n, about `c`: 7 points. */
function quarter(f: Draw, c: Pt, u: Pt, n: Pt, r: number): XY[] {
  return [0, 1, 2, 3, 4, 5, 6].map((k) => f.P([c[0] + r * (COS[k]! * u[0] + SIN[k]! * n[0]), c[1] + r * (COS[k]! * u[1] + SIN[k]! * n[1])]));
}

function poolSvg(id: string, x: Extract<SceneOutdoor, { kind: 'pool' }>, f: Draw, pal: Palette, accent: boolean): string {
  const outer = ringsPath([x.outer.map(f.P)]);
  const basin = ringsPath([x.basin.map(f.P)]);
  let g = el('path', { d: outer, fill: accent ? pal.accent : pal.coping, 'fill-opacity': accent ? 0.4 : 1, stroke: pal.faint, 'stroke-width': 0.75 });
  g += el('path', { 'data-water': id, d: basin, fill: pal.water, stroke: pal.waterEdge, 'stroke-width': 1 });
  // ripples: three short waves across the basin, stacked along its long side
  const [b0, b1, , b3] = x.basin;
  const long = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]) > Math.hypot(b3[0] - b0[0], b3[1] - b0[1]);
  const L: Pt = long ? [b1[0] - b0[0], b1[1] - b0[1]] : [b3[0] - b0[0], b3[1] - b0[1]];
  const S: Pt = long ? [b3[0] - b0[0], b3[1] - b0[1]] : [b1[0] - b0[0], b1[1] - b0[1]];
  const amp = Math.min(Math.hypot(L[0], L[1]) * 0.02, Math.hypot(S[0], S[1]) * 0.05);
  const ln = Math.hypot(L[0], L[1]);
  const lu: Pt = ln === 0 ? [0, 0] : [L[0] / ln, L[1] / ln];
  let d = '';
  for (const t of [0.3, 0.5, 0.7]) {
    const w: XY[] = [0.3, 0.375, 0.45, 0.525, 0.6, 0.675, 0.7].map((s2, i) => {
      const lift = i % 2 === 1 ? amp : i % 2 === 0 && i > 0 && i < 6 ? -amp : 0;
      return f.P([b0[0] + L[0] * t + S[0] * s2 + lu[0] * lift, b0[1] + L[1] * t + S[1] * s2 + lu[1] * lift]);
    });
    d += polylinePath(w);
  }
  g += el('path', { d, fill: 'none', stroke: pal.waterEdge, 'stroke-width': 0.75, 'stroke-opacity': 0.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  return el('g', { 'data-id': id, 'data-kind': 'FS_outdoor:pools', 'data-form': x.form }, g);
}

function fenceSvg(id: string, x: Extract<SceneOutdoor, { kind: 'fence' }>, f: Draw, pal: Palette, accent: boolean): string {
  const ink = accent ? pal.accent : x.form === 'wall' ? pal.gardenWall : pal.timber;
  const w = Math.max(1.5, x.width * f.s);
  const d = polylinePath(x.line.map(f.P));
  let g = el('path', { d, fill: 'none', stroke: ink, 'stroke-width': w, 'stroke-linejoin': 'miter', 'stroke-linecap': 'butt' });
  // the gates: each an opening — paper over the line — with its leaf and its swing
  for (const gt of x.gates) {
    g += el('path', { 'data-gate': id, d: linePath(f.P(gt.a), f.P(gt.b)), stroke: pal.paper, 'stroke-width': w + 1, fill: 'none' });
    const len = Math.hypot(gt.b[0] - gt.a[0], gt.b[1] - gt.a[1]);
    if (len === 0) continue;
    const along: Pt = [(gt.b[0] - gt.a[0]) / len, (gt.b[1] - gt.a[1]) / len];
    if (gt.swing === 'slide') {
      const off: Pt = [gt.side[0] * x.width, gt.side[1] * x.width];
      g += el('path', { 'data-gate-leaf': id, d: linePath(f.P([gt.a[0] + off[0], gt.a[1] + off[1]]), f.P([gt.b[0] + off[0], gt.b[1] + off[1]])), stroke: ink, 'stroke-width': 1.5, fill: 'none' });
      continue;
    }
    const hinges: { at: Pt; dir: Pt; r: number }[] = gt.leaves === 2
      ? [{ at: gt.a, dir: along, r: len / 2 }, { at: gt.b, dir: [-along[0], -along[1]], r: len / 2 }]
      : [{ at: gt.a, dir: along, r: len }];
    for (const h of hinges) {
      const tip: Pt = [h.at[0] + gt.side[0] * h.r, h.at[1] + gt.side[1] * h.r];
      g += el('path', { 'data-gate-leaf': id, d: linePath(f.P(h.at), f.P(tip)), stroke: ink, 'stroke-width': 1.5, fill: 'none' });
      g += el('path', { 'data-gate-swing': id, d: polylinePath(quarter(f, h.at, h.dir, gt.side, h.r)), stroke: pal.faint, 'stroke-width': 0.75, 'stroke-dasharray': '2 2', fill: 'none' });
    }
  }
  // the posts: dots on the line, darker than the boards
  const r = Math.max(1.2, Math.min(3, w * 0.75));
  let posts = '';
  for (const p of x.posts) {
    const q = f.P(p);
    posts += el('circle', { cx: q[0], cy: q[1], r, fill: accent ? pal.accent : pal.muted });
  }
  g += el('g', { 'data-posts': String(x.posts.length) }, posts);
  return el('g', { 'data-id': id, 'data-kind': 'FS_outdoor:fences', 'data-form': x.form }, g);
}

const APPLIANCE_MARK: Readonly<Record<string, 'grill' | 'round' | 'box'>> = { grill: 'grill', sideBurner: 'round', sink: 'round', pizzaOven: 'round', smoker: 'grill' };

function kitchenSvg(id: string, x: Extract<SceneOutdoor, { kind: 'kitchen' }>, f: Draw, pal: Palette, accent: boolean): string {
  let g = el('path', { d: ringsPath([x.outline.map(f.P)]), fill: accent ? pal.accent : pal.coping, 'fill-opacity': accent ? 0.4 : 1, stroke: pal.muted, 'stroke-width': 1 });
  for (const c of x.cells) {
    const mark = APPLIANCE_MARK[c.appliance] ?? 'box';
    const [a, b, cc, d] = c.quad;
    let m = el('path', { d: ringsPath([c.quad.map(f.P)]), fill: pal.room, stroke: pal.faint, 'stroke-width': 0.75 });
    if (mark === 'grill') {
      let lines = '';
      for (const t of [0.25, 0.5, 0.75]) lines += linePath(f.P(lerp(a, d, t)), f.P(lerp(b, cc, t)));
      m += el('path', { d: lines, stroke: pal.faint, 'stroke-width': 0.75, fill: 'none' });
    } else if (mark === 'round') {
      const ctr = lerp(a, cc, 0.5);
      const r = Math.min(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(d[0] - a[0], d[1] - a[1])) * 0.3;
      m += el('path', { d: circle(f, ctr, r), fill: 'none', stroke: pal.faint, 'stroke-width': 0.75 });
    }
    g += el('g', { 'data-appliance': c.appliance }, m);
  }
  return el('g', { 'data-id': id, 'data-kind': 'FS_outdoor:kitchens' }, g);
}

function fireSvg(id: string, x: Extract<SceneOutdoor, { kind: 'fire' }>, f: Draw, pal: Palette, accent: boolean): string {
  let g: string;
  if (x.form === 'pit' || x.form === 'bowl') {
    g = el('path', { d: circle(f, x.centre, x.radius), fill: accent ? pal.accent : pal.gardenWall, 'fill-opacity': accent ? 0.4 : 1, stroke: pal.faint, 'stroke-width': 0.75 });
    g += el('path', { 'data-flame': id, d: circle(f, x.centre, x.radius * 0.55), fill: pal.flame, stroke: 'none' });
  } else {
    g = el('path', { d: ringsPath([x.outline.map(f.P)]), fill: accent ? pal.accent : pal.gardenWall, 'fill-opacity': accent ? 0.4 : 1, stroke: pal.faint, 'stroke-width': 0.75 });
    const [a, b, c, d] = x.outline;
    // a fireplace's hearth at its front (max x); a table's burner along its middle
    const hearth: [Pt, Pt, Pt, Pt] = x.form === 'fireplace' ? [lerp(a, b, 0.55), b, c, lerp(d, c, 0.55)] : [lerp(lerp(a, b, 0.35), lerp(d, c, 0.35), 0.15), lerp(lerp(a, b, 0.65), lerp(d, c, 0.65), 0.15), lerp(lerp(a, b, 0.65), lerp(d, c, 0.65), 0.85), lerp(lerp(a, b, 0.35), lerp(d, c, 0.35), 0.85)];
    const inner: Pt[] = x.form === 'fireplace' ? [lerp(hearth[0], hearth[3], 0.25), lerp(hearth[1], hearth[2], 0.25), lerp(hearth[1], hearth[2], 0.75), lerp(hearth[0], hearth[3], 0.75)] : hearth;
    g += el('path', { 'data-flame': id, d: ringsPath([inner.map(f.P)]), fill: pal.flame, stroke: 'none' });
  }
  return el('g', { 'data-id': id, 'data-kind': 'FS_outdoor:fires', 'data-form': x.form }, g);
}

function shelterSvg(id: string, x: Extract<SceneOutdoor, { kind: 'shelter' }>, f: Draw, pal: Palette, accent: boolean): string {
  const ink = accent ? pal.accent : pal.overhead;
  const dash = '6 4';
  let g = '';
  const outline = ringsPath([x.outline.map(f.P)]);
  if (x.top === 'solid') {
    // a porch's roof: its outline, lightly filled, dashed; a ridge-less hip mark from corner to corner
    g += el('path', { d: outline, fill: ink, 'fill-opacity': 0.08, stroke: ink, 'stroke-width': 1.25, 'stroke-dasharray': dash });
    g += el('path', { d: linePath(f.P(x.outline[0]), f.P(x.outline[2])) + linePath(f.P(x.outline[1]), f.P(x.outline[3])), stroke: ink, 'stroke-width': 0.6, 'stroke-dasharray': dash, 'stroke-opacity': 0.6, fill: 'none' });
  } else if (x.top === 'sail') {
    // a sail between the corner posts, its edges drawn in toward the middle
    const c = lerp(x.outline[0], x.outline[2], 0.5);
    const pts: Pt[] = [];
    for (let i = 0; i < 4; i++) {
      const a = x.outline[i]!;
      const b = x.outline[(i + 1) % 4]!;
      pts.push(a, lerp(lerp(a, b, 0.5), c, 0.18));
    }
    g += el('path', { d: ringsPath([pts.map(f.P)]), fill: ink, 'fill-opacity': 0.1, stroke: ink, 'stroke-width': 1.25, 'stroke-dasharray': dash });
  } else {
    let d = '';
    for (const [a, b] of x.rafters) d += linePath(f.P(a), f.P(b));
    g += el('path', { 'data-rafters': String(x.rafters.length), d, stroke: ink, 'stroke-width': 0.75, 'stroke-dasharray': dash, fill: 'none' });
    let bd = '';
    for (const [a, b] of x.beams) bd += linePath(f.P(a), f.P(b));
    g += el('path', { 'data-beams': id, d: bd, stroke: ink, 'stroke-width': 1.75, 'stroke-dasharray': dash, fill: 'none' });
  }
  // the posts, solid: they stand on the ground
  const h = x.postSize / 2;
  let posts = '';
  for (const p of x.posts) posts += ringsPath([[f.P([p[0] - h, p[1] - h]), f.P([p[0] + h, p[1] - h]), f.P([p[0] + h, p[1] + h]), f.P([p[0] - h, p[1] + h])]]);
  if (posts !== '') g += el('path', { 'data-posts': String(x.posts.length), d: posts, fill: accent ? pal.accent : pal.timber, stroke: pal.muted, 'stroke-width': 0.5 });
  return el('g', { 'data-id': id, 'data-kind': 'FS_outdoor:shelters', 'data-top': x.top }, g);
}

/**
 * The SVG of FS_outdoor's elements on a level, in two layers: `ground` — pools, fences, kitchens and
 * fires, over the paving — and `overhead`, the shelters, drawn after everything they stand over.
 */
export function outdoorLayers(items: readonly (readonly [string, SceneOutdoor])[], f: Draw, pal: Palette, accent: (id: string) => boolean): { ground: string; overhead: string } {
  let pools = '';
  let fences = '';
  let things = '';
  let overhead = '';
  for (const [id, x] of items) {
    const a = accent(id);
    if (x.kind === 'pool') pools += poolSvg(id, x, f, pal, a);
    else if (x.kind === 'fence') fences += fenceSvg(id, x, f, pal, a);
    else if (x.kind === 'kitchen') things += kitchenSvg(id, x, f, pal, a);
    else if (x.kind === 'fire') things += fireSvg(id, x, f, pal, a);
    else overhead += shelterSvg(id, x, f, pal, a);
  }
  return { ground: pools + things + fences, overhead };
}

