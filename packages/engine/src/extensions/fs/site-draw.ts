/**
 * FS_site for drawing (registry/FS_site/spec.md chapter 5, informative): what the editor, render2d, the
 * 3D mesh and the PDF draw from a document's site — its lot with each edge's bearing and setback, the
 * setback line, the surface, contours at an interval in the survey's datum, the spots and the survey's
 * own contour lines, and where each graded outline cuts and where it fills.
 *
 * Floating point is fine here: nothing drawn is normative. The surface's triangles are the exact ones
 * FS_site derives (`triangulate`), so a contour or a 3D ground drawn from them is the derived surface.
 */
import type { FloorspecDocument } from '../../model/document.js';
import { edgeKinds, gradedOutlines, siteData, surfaceOf, type ContourLine, type EdgeKind, type GradingPad, type Setbacks, type SpotElevation } from './site.js';

export type XY = [number, number];

/** A surface ready to draw: its points `[x, y, z]` in base units, its triangles, and its hull. */
export interface DrawSurface {
  readonly points: readonly (readonly [number, number, number])[];
  readonly triangles: readonly (readonly [number, number, number])[];
  readonly low: number;
  readonly high: number;
}

/** One lot edge, ready to label. */
export interface DrawEdge {
  readonly index: number;
  readonly from: XY;
  readonly to: XY;
  readonly length: number;
  readonly kind: EdgeKind | null;
  readonly setback: number | null;
  /** Its bearing from true north, as a surveyor writes it: "N 88°24′ E". */
  readonly bearing: string;
}

/** One graded outline, ready to draw. */
export interface DrawGraded {
  readonly id: string;
  readonly kind: 'slab' | 'pad';
  readonly ring: XY[];
  readonly elevation: number;
  readonly name?: string;
}

/** Everything of FS_site a drawing needs, from a document alone. */
export interface SiteDrawing {
  /** The lot (Core's site boundary), or null. */
  readonly lot: XY[] | null;
  readonly edges: readonly DrawEdge[];
  /** The setback line: the lot with each edge moved in by its setback; null without setbacks. */
  readonly setbackLine: XY[] | null;
  readonly setbacks: Setbacks | null;
  readonly benchmark: number;
  readonly surface: DrawSurface | null;
  readonly spots: readonly { id: string; at: XY; elevation: number; name?: string }[];
  readonly contours: readonly { id: string; elevation: number; points: XY[]; name?: string }[];
  readonly graded: readonly DrawGraded[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPt = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isSafeInteger(x));
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** "N 88°24′ E": a quadrant bearing, from true north (`trueNorth` in microdegrees, Core 1.8). */
export function bearingOf(from: XY, to: XY, trueNorth = 0): string {
  // the angle from project north, clockwise, then turned to true north
  let az = (Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI + trueNorth / 1e6;
  az = ((az % 360) + 360) % 360;
  const ns = az <= 90 || az >= 270 ? 'N' : 'S';
  const ew = az <= 180 ? 'E' : 'W';
  const a = ns === 'N' ? (az <= 90 ? az : 360 - az) : Math.abs(180 - az);
  let deg = Math.floor(a);
  let min = Math.round((a - deg) * 60);
  if (min === 60) {
    deg += 1;
    min = 0;
  }
  return `${ns} ${String(deg).padStart(2, '0')}°${String(min).padStart(2, '0')}′ ${ew}`;
}

/** Clip a polygon to the half-plane where `f` ≥ 0 (floats). */
function clipF(poly: readonly XY[], f: (p: XY) => number): XY[] {
  const out: XY[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const fp = f(p);
    const fq = f(q);
    if (fp >= 0) out.push(p);
    if ((fp > 0 && fq < 0) || (fp < 0 && fq > 0)) {
      const t = fp / (fp - fq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return out;
}

const signedArea = (r: readonly XY[]): number => r.reduce((s, p, i) => s + p[0] * r[(i + 1) % r.length]![1] - r[(i + 1) % r.length]![0] * p[1], 0) / 2;

/** The lot with each edge moved in by its setback (chapter 5.3): the lot clipped by each edge's inward half-plane. */
export function setbackPolygon(lot: readonly XY[], setbackOf: readonly (number | null)[]): XY[] {
  const ccw = signedArea(lot) >= 0;
  let poly: XY[] = [...lot];
  for (let i = 0; i < lot.length && poly.length > 0; i++) {
    const d = setbackOf[i] ?? 0;
    if (d <= 0) continue;
    const a = lot[i]!;
    const b = lot[(i + 1) % lot.length]!;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len === 0) continue;
    // inward normal: left of the edge for a counter-clockwise lot
    const nx = (ccw ? -ey : ey) / len;
    const ny = (ccw ? ex : -ex) / len;
    poly = clipF(poly, (p) => (p[0] - a[0]) * nx + (p[1] - a[1]) * ny - d);
  }
  return poly;
}

/** Everything of FS_site a drawing needs. Data that cannot be read is skipped; nothing here throws. */
export function siteDrawing(doc: FloorspecDocument): SiteDrawing {
  const data = siteData(doc);
  const boundary = doc.site?.boundary;
  const lot = Array.isArray(boundary) && boundary.length >= 3 && boundary.every(isPt) ? boundary.map((p) => [p[0], p[1]] as XY) : null;
  const setbacks = isObject(data.setbacks) && Array.isArray(data.setbacks.street) ? (data.setbacks as unknown as Setbacks) : null;
  const trueNorth = typeof doc.site?.trueNorth === 'number' ? doc.site.trueNorth : 0;
  const edges: DrawEdge[] = [];
  let setbackLine: XY[] | null = null;
  if (lot) {
    const kinds = edgeKinds(lot.length, setbacks ?? undefined);
    for (let i = 0; i < lot.length; i++) {
      const from = lot[i]!;
      const to = lot[(i + 1) % lot.length]!;
      const k = kinds[i] ?? null;
      edges.push({ index: i, from, to, length: Math.hypot(to[0] - from[0], to[1] - from[1]), kind: k, setback: k === null ? null : (setbacks?.[k] ?? null), bearing: bearingOf(from, to, trueNorth) });
    }
    if (setbacks) setbackLine = setbackPolygon(lot, edges.map((e) => e.setback));
  }
  let surface: DrawSurface | null = null;
  const spots: SiteDrawing['spots'][number][] = [];
  const contours: SiteDrawing['contours'][number][] = [];
  const graded: DrawGraded[] = [];
  try {
    for (const [id, s] of Object.entries(isObject(data.spots) ? data.spots : {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const sp = s as SpotElevation;
      if (isObject(s) && isPt(sp.at) && isInt(sp.elevation)) spots.push({ id, at: [sp.at[0], sp.at[1]], elevation: sp.elevation, ...(typeof sp.name === 'string' && { name: sp.name }) });
    }
    for (const [id, c] of Object.entries(isObject(data.contours) ? data.contours : {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const cl = c as ContourLine;
      if (isObject(c) && isInt(cl.elevation) && Array.isArray(cl.points) && cl.points.every(isPt)) contours.push({ id, elevation: cl.elevation, points: cl.points.map((p) => [p[0], p[1]] as XY), ...(typeof cl.name === 'string' && { name: cl.name }) });
    }
    const clean: Json = {
      spots: Object.fromEntries(spots.map((s) => [s.id, { at: s.at, elevation: s.elevation }])),
      contours: Object.fromEntries(contours.map((c) => [c.id, { elevation: c.elevation, points: c.points }])),
    };
    const s = surfaceOf(clean);
    if (s) {
      const zs = s.points.map((p) => p[2]);
      surface = { points: s.points.map((p) => [Number(p[0]), Number(p[1]), p[2]] as const), triangles: s.triangles, low: Math.min(...zs), high: Math.max(...zs) };
    }
    const isPad = (p: unknown): p is GradingPad => isObject(p) && Array.isArray(p.boundary) && p.boundary.length >= 3 && p.boundary.every(isPt) && isInt(p.elevation);
    const pads = Object.fromEntries(Object.entries(isObject(data.pads) ? data.pads : {}).filter(([, p]) => isPad(p)));
    for (const g of gradedOutlines(doc, { pads })) graded.push({ id: g.id, kind: g.kind, ring: g.ring.map((p) => [Number(p[0]), Number(p[1])] as XY), elevation: g.elevation, ...(g.name !== undefined && { name: g.name }) });
  } catch {
    // a document that cannot be read as a site draws no site
  }
  return { lot, edges, setbackLine, setbacks, benchmark: isInt(data.benchmark) ? data.benchmark : 0, surface, spots, contours, graded };
}

/** The ground's elevation at a plan point, from the triangle containing it; undefined beyond the hull. */
export function gradeAt(s: DrawSurface, x: number, y: number): number | undefined {
  for (const t of s.triangles) {
    const [a, b, c] = t.map((i) => s.points[i]!) as [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
    const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (det === 0) continue;
    const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det;
    const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det;
    const l3 = 1 - l1 - l2;
    const eps = -1e-9;
    if (l1 >= eps && l2 >= eps && l3 >= eps) return l1 * a[2] + l2 * b[2] + l3 * c[2];
  }
  return undefined;
}

/** One contour at an elevation: its polylines, chained from the triangles' crossings. */
export interface Contour {
  /** Its elevation above project zero. */
  readonly z: number;
  /** Its height in the survey's datum (`benchmark + z`). */
  readonly height: number;
  readonly major: boolean;
  readonly lines: XY[][];
}

/**
 * Contours of the surface at every multiple of `interval` in the survey's datum (5.1), every
 * `majorEvery`-th a major one. A vertex exactly at a contour's height counts as above it, so a
 * contour through a vertex is drawn once.
 */
export function contoursOf(s: DrawSurface, interval: number, benchmark = 0, majorEvery = 5): Contour[] {
  if (!(interval > 0)) return [];
  const out: Contour[] = [];
  const first = Math.ceil((s.low + benchmark) / interval);
  const last = Math.floor((s.high + benchmark) / interval);
  if (last - first > 2000) return [];
  for (let k = first; k <= last; k++) {
    const height = k * interval;
    const z = height - benchmark;
    const segs: [XY, XY][] = [];
    for (const t of s.triangles) {
      const P = t.map((i) => s.points[i]!);
      const cross: XY[] = [];
      for (let j = 0; j < 3; j++) {
        const p = P[j]!;
        const q = P[(j + 1) % 3]!;
        const ap = p[2] >= z;
        const aq = q[2] >= z;
        if (ap === aq) continue;
        const f = (z - p[2]) / (q[2] - p[2]);
        cross.push([p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])]);
      }
      if (cross.length === 2) segs.push([cross[0]!, cross[1]!]);
    }
    if (segs.length === 0) continue;
    out.push({ z, height, major: majorEvery > 0 && k % majorEvery === 0, lines: chain(segs) });
  }
  return out;
}

/** Chain segments sharing ends into polylines. */
function chain(segs: [XY, XY][]): XY[][] {
  const k = (p: XY) => `${Math.round(p[0])},${Math.round(p[1])}`;
  const at = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const p of s) {
      const key = k(p);
      const l = at.get(key);
      if (l) l.push(i);
      else at.set(key, [i]);
    }
  });
  const used = new Set<number>();
  const lines: XY[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const line: XY[] = [segs[i]![0], segs[i]![1]];
    for (const dir of [1, -1]) {
      for (;;) {
        const end = dir === 1 ? line[line.length - 1]! : line[0]!;
        const next = (at.get(k(end)) ?? []).find((j) => !used.has(j));
        if (next === undefined) break;
        used.add(next);
        const [a, b] = segs[next]!;
        const p = k(a) === k(end) ? b : a;
        if (dir === 1) line.push(p);
        else line.unshift(p);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Where a graded outline cuts the ground and where it fills it (5.2): polygons, in plan. */
export interface CutFill {
  readonly cut: XY[][];
  readonly fill: XY[][];
  /** The greatest depth cut and the greatest height filled, in base units. */
  readonly cutDepth: number;
  readonly fillHeight: number;
}

/** A graded outline's cut and fill regions over the surface (floats, for drawing). */
export function cutFillOf(s: DrawSurface, ring: readonly XY[], elevation: number): CutFill {
  let r = [...ring];
  if (signedArea(r) < 0) r = r.reverse();
  const cut: XY[][] = [];
  const fill: XY[][] = [];
  let cutDepth = 0;
  let fillHeight = 0;
  for (const t of s.triangles) {
    const T = t.map((i) => s.points[i]!) as [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
    let piece: XY[] = r;
    for (let i = 0; i < 3 && piece.length > 0; i++) {
      const a = T[i]!;
      const b = T[(i + 1) % 3]!;
      piece = clipF(piece, (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    }
    if (piece.length < 3) continue;
    const [a, b, c] = T;
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    const beta = ((b[2] - a[2]) * (c[1] - a[1]) - (c[2] - a[2]) * (b[1] - a[1])) / det;
    const gamma = ((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / det;
    const h = (p: XY) => a[2] + beta * (p[0] - a[0]) + gamma * (p[1] - a[1]) - elevation;
    for (const p of piece) {
      const v = h(p);
      if (v > cutDepth) cutDepth = v;
      if (-v > fillHeight) fillHeight = -v;
    }
    const up = clipF(piece, h);
    if (up.length >= 3 && Math.abs(signedArea(up)) > 1) cut.push(up);
    const down = clipF(piece, (p) => -h(p));
    if (down.length >= 3 && Math.abs(signedArea(down)) > 1) fill.push(down);
  }
  return { cut, fill, cutDepth, fillHeight };
}
