/**
 * FS_landscape in plan (FS_landscape chapter 4, FLR-T-13.5): what a landscape architect's planting
 * plan shows, in the plan's own quiet palette.
 *
 * - a **lawn** is its outline in pale sage, under the paving;
 * - a **bed** is its outline in a warm mulch tone, its edging a band inside its edge as wide as the
 *   edging is (a raised planter's walls read as walls), and **hardscape** its line swept to its width
 *   — a path in stone, stepping stones laid one by one, a wall darker;
 * - a **plant** is its canopy from above, on top of everything it grows over: a tree a scalloped
 *   crown with its trunk and three branches, a conifer a crown of points, a shrub a smaller scalloped
 *   mass, a grass a burst of blades, a groundcover a dotted drift.
 *
 * Geometry comes from the element itself — its outline or line in its frame (FS_landscape 3.4) — taken
 * to the plan by its placement, as the box's corners are (scene.ts, `boxFrame`). Round things use a
 * written-out table of 24 cosines, so the SVG is the same text in every JavaScript engine.
 */
import { facingVector } from '@floorspec/engine';
import { num } from './format.js';
import type { Pt } from './scene.js';
import { el, linePath, polylinePath, ringsPath, type XY } from './svg.js';
import type { Palette } from './theme.js';

/** What a landscape element is in plan, in base units. */
export type SceneLandscape =
  | { readonly kind: 'plant'; readonly form: string; readonly habit: string; readonly evergreen: boolean; readonly position: Pt; readonly centre: Pt; readonly radius: number }
  | { readonly kind: 'bed'; readonly outline: readonly Pt[]; readonly cover: string; readonly edging: string; readonly edge: number }
  | { readonly kind: 'lawn'; readonly outline: readonly Pt[]; readonly meadow: boolean }
  | { readonly kind: 'hardscape'; readonly form: string; readonly line: readonly Pt[]; readonly width: number; readonly material: string | undefined };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

const MM = 1280;
/** Each edging's width, as the 3D model draws it (@floorspec/mesh models/landscape.ts). */
const EDGE: Readonly<Record<string, number>> = { steel: 8 * MM, stone: 150 * MM, brick: 110 * MM, timber: 100 * MM, concrete: 120 * MM };

/** cos(15° · k), k = 0 … 23, written out (as @floorspec/mesh's circle table). */
const Q = [1, 0.9659258262890683, 0.8660254037844387, 0.7071067811865476, 0.5, 0.25881904510252074, 0] as const;
const COS: readonly number[] = Array.from({ length: 24 }, (_, k) => (k <= 6 ? Q[k]! : k <= 12 ? -Q[12 - k]! : k <= 18 ? -Q[k - 12]! : Q[24 - k]!));
const SIN: readonly number[] = Array.from({ length: 24 }, (_, k) => COS[(k + 18) % 24]!);

const points = (v: unknown): [number, number][] =>
  Array.isArray(v) ? v.filter((p): p is [number, number] => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number').map((p) => [p[0], p[1]]) : [];

/**
 * An FS_landscape element in plan: its geometry taken from its frame — its placement's point and
 * facing, or the level's own frame when it has no host. Undefined for an element of another
 * extension, or one whose geometry is missing.
 */
export function landscapeOf(collection: string, element: Json, placement: { readonly point: readonly number[]; readonly facing: number } | undefined): SceneLandscape | undefined {
  const [fx, fy] = facingVector(placement?.facing ?? 0);
  const k = Math.sqrt(Number(fx) * Number(fx) + Number(fy) * Number(fy));
  const u: XY = [Number(fx) / k, Number(fy) / k];
  const o: XY = placement === undefined ? [0, 0] : [placement.point[0] ?? 0, placement.point[1] ?? 0];
  const plan = (x: number, y: number): Pt => [o[0] + x * u[0] - y * u[1], o[1] + x * u[1] + y * u[0]];
  if (collection === 'plants') {
    const box = isObject(element['fallback']) ? element['fallback']['box'] : undefined;
    if (!isObject(box) || !Array.isArray(box['min']) || !Array.isArray(box['max'])) return undefined;
    const [x0 = 0, y0 = 0] = box['min'] as number[];
    const [x1 = 0, y1 = 0] = box['max'] as number[];
    return {
      kind: 'plant',
      form: str(element['form'], 'shrub'),
      habit: str(element['habit'], 'rounded'),
      evergreen: element['foliage'] === 'evergreen',
      position: plan(0, 0),
      centre: plan((x0 + x1) / 2, (y0 + y1) / 2),
      radius: Math.max(x1 - x0, y1 - y0) / 2,
    };
  }
  if (collection === 'beds' || collection === 'lawns') {
    const outline = points(element['boundary']).map(([x, y]) => plan(x, y));
    if (outline.length < 3) return undefined;
    if (collection === 'lawns') return { kind: 'lawn', outline, meadow: element['cover'] === 'meadow' };
    const edging = str(element['edging'], 'none');
    return { kind: 'bed', outline, cover: str(element['cover'], 'mulch'), edging, edge: EDGE[edging] ?? 0 };
  }
  if (collection === 'hardscape') {
    const line = points(element['points']).map(([x, y]) => plan(x, y));
    if (line.length < 2 || typeof element['width'] !== 'number') return undefined;
    return { kind: 'hardscape', form: str(element['form'], 'path'), line, width: element['width'], material: typeof element['material'] === 'string' ? element['material'] : undefined };
  }
  return undefined;
}

interface Draw {
  readonly s: number;
  readonly P: (p: Pt) => XY;
}

/** A conifer's crown about a centre: 24 points alternating radii r and r × inner, a crown of needles. */
function star(f: Draw, c: Pt, r: number, inner: number): string {
  const pts: XY[] = [];
  for (let k = 0; k < 24; k++) {
    const rr = k % 2 === 0 ? r : r * inner;
    pts.push(f.P([c[0] + rr * COS[k]!, c[1] + rr * SIN[k]!]));
  }
  return ringsPath([pts]);
}

/** A broadleaf crown: twelve scallops round a centre, each an arc bulging out between points just inside r. */
function scallops(f: Draw, c: Pt, r: number): string {
  const pts: XY[] = [];
  for (let k = 0; k < 24; k += 2) pts.push(f.P([c[0] + r * 0.92 * COS[k]!, c[1] + r * 0.92 * SIN[k]!]));
  // the chord between neighbours is 2 · 0.92 r · sin 15°; an arc of 0.9 chords' radius bulges by 0.15 of a chord, to about r
  const a = r * 0.92 * 2 * SIN[1]! * 0.9 * f.s;
  let d = `M${num(pts[0]![0])} ${num(pts[0]![1])}`;
  for (let i = 1; i <= pts.length; i++) {
    const p = pts[i % pts.length]!;
    d += `A${num(a)} ${num(a)} 0 0 0 ${num(p[0])} ${num(p[1])}`;
  }
  return `${d}Z`;
}

/** A plant's symbol: on top of what it grows over, its canopy a little see-through. */
function plantSymbol(id: string, x: Extract<SceneLandscape, { kind: 'plant' }>, f: Draw, pal: Palette, accent: boolean): string {
  const ink = accent ? pal.accent : x.evergreen || x.habit === 'conical' ? pal.canopyDark : pal.canopy;
  const r = x.radius;
  const attrs = { 'data-id': id, 'data-kind': 'FS_landscape:plants', 'data-form': x.form };
  if (x.form === 'grass') {
    // a burst of blades from its crown
    let d = '';
    for (let k = 0; k < 24; k += 2) d += linePath(f.P(x.position), f.P([x.centre[0] + r * COS[k]!, x.centre[1] + r * SIN[k]!]));
    return el('g', attrs, el('path', { d, stroke: accent ? pal.accent : pal.grassInk, 'stroke-width': 1, 'stroke-linecap': 'round', fill: 'none' }));
  }
  if (x.form === 'groundcover') {
    const c = f.P(x.centre);
    return el('g', attrs, el('circle', { cx: c[0], cy: c[1], r: r * f.s, fill: ink, 'fill-opacity': 0.28, stroke: ink, 'stroke-width': 1, 'stroke-dasharray': '1.5 2' }));
  }
  const outline = x.habit === 'conical' ? star(f, x.centre, r, 0.8) : scallops(f, x.centre, r);
  let g = el('path', { d: outline, fill: ink, 'fill-opacity': x.form === 'tree' ? 0.32 : 0.5, stroke: ink, 'stroke-width': 1, 'stroke-linejoin': 'round' });
  if (x.form === 'tree') {
    // its trunk, and three branches out from it
    const at = f.P(x.position);
    let d = '';
    for (const k of [2, 10, 18]) d += linePath(at, f.P([x.position[0] + r * 0.55 * COS[k]!, x.position[1] + r * 0.55 * SIN[k]!]));
    g += el('path', { d, stroke: ink, 'stroke-width': 0.75, 'stroke-opacity': 0.8, fill: 'none' });
    g += el('circle', { cx: at[0], cy: at[1], r: Math.max(1.5, Math.min(4, r * f.s * 0.06)), fill: ink });
  }
  return el('g', attrs, g);
}

/** A hardscape line's symbol: its line swept to its width; stepping stones one by one. */
function hardscapeSymbol(id: string, x: Extract<SceneLandscape, { kind: 'hardscape' }>, f: Draw, pal: Palette, accent: boolean): string {
  const attrs = { 'data-id': id, 'data-kind': 'FS_landscape:hardscape', 'data-form': x.form };
  const fill = accent ? pal.accent : x.form === 'wall' ? pal.gardenWall : pal.paving;
  const w = x.width * f.s;
  if (x.form === 'steppingStones') {
    let d = '';
    const along = x.width * 0.6;
    const gap = x.width * 0.38;
    let next = along / 2;
    let walked = 0;
    for (let i = 0; i + 1 < x.line.length; i++) {
      const a = x.line[i]!;
      const b = x.line[i + 1]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) continue;
      const u: XY = [dx / len, dy / len];
      const n: XY = [-u[1], u[0]];
      for (; next <= walked + len; next += along + gap) {
        const t = next - walked;
        const m: Pt = [a[0] + u[0] * t, a[1] + u[1] * t];
        const h = x.width / 2;
        const l = along / 2;
        d += ringsPath([[f.P([m[0] - u[0] * l - n[0] * h, m[1] - u[1] * l - n[1] * h]), f.P([m[0] + u[0] * l - n[0] * h, m[1] + u[1] * l - n[1] * h]), f.P([m[0] + u[0] * l + n[0] * h, m[1] + u[1] * l + n[1] * h]), f.P([m[0] - u[0] * l + n[0] * h, m[1] - u[1] * l + n[1] * h])]]);
      }
      walked += len;
    }
    return el('g', attrs, el('path', { d, fill, stroke: pal.faint, 'stroke-width': 0.75 }));
  }
  const d = polylinePath(x.line.map(f.P));
  // an edge line under the fill, so the strip reads as a built thing
  return el('g', attrs, el('path', { d, fill: 'none', stroke: pal.faint, 'stroke-width': w + 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'butt' }) + el('path', { d, fill: 'none', stroke: fill, 'stroke-width': w, 'stroke-linejoin': 'round', 'stroke-linecap': 'butt' }));
}

/** The SVG of FS_landscape's elements on a level, in three layers: lawns, beds and hardscape, plants. */
export function landscapeLayers(items: readonly (readonly [string, SceneLandscape])[], f: Draw, pal: Palette, accent: (id: string) => boolean): { lawns: string; ground: string; plants: string } {
  let lawns = '';
  let beds = '';
  let lines = '';
  let plants = '';
  for (const [id, x] of items) {
    const a = accent(id);
    if (x.kind === 'lawn') {
      lawns += el('path', { 'data-id': id, 'data-kind': 'FS_landscape:lawns', d: ringsPath([x.outline.map(f.P)]), fill: a ? pal.accent : x.meadow ? pal.meadow : pal.lawn, 'fill-opacity': a ? 0.4 : 1, stroke: pal.lawnEdge, 'stroke-width': 0.75 });
    } else if (x.kind === 'bed') {
      const d = ringsPath([x.outline.map(f.P)]);
      let g = el('path', { d, fill: a ? pal.accent : pal.bed, 'fill-opacity': a ? 0.4 : 1, stroke: pal.faint, 'stroke-width': 0.75 });
      // the edging: a band inside the edge, as wide as the edging (a stroke twice as wide, clipped to the bed)
      if (x.edge > 0) {
        const cid = `fs-bed-${id}`;
        g += el('clipPath', { id: cid }, el('path', { d }));
        const ink = x.edging === 'concrete' || x.edging === 'stone' ? pal.gardenWall : pal.edging;
        g += el('path', { d, fill: 'none', stroke: ink, 'stroke-width': Math.max(1.2, 2 * x.edge * f.s), 'clip-path': `url(#${cid})` });
      }
      beds += el('g', { 'data-id': id, 'data-kind': 'FS_landscape:beds', 'data-edging': x.edging }, g);
    } else if (x.kind === 'hardscape') lines += hardscapeSymbol(id, x, f, pal, a);
    else plants += plantSymbol(id, x, f, pal, a);
  }
  return { lawns, ground: beds + lines, plants };
}
