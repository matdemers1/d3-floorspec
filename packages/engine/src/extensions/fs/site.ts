/**
 * FS_site 0.1.0 (registry/FS_site/spec.md, FLR-ADR-060): the ground a house stands on — setbacks drawn
 * from Core's lot line, the terrain a survey's spot elevations and contour lines make, and the grading
 * pads and ground-laid slabs that cut and fill it. It adds no kind of element and requires no other
 * extension; the IDs of FS_lighting's scenes, FS_views's views and FS_annotation's strings and notes are
 * read from their data as it is.
 *
 * Everything normative is exact. The surface (3.2) is the Delaunay triangulation of the survey's
 * positions made unique: a sorted incremental triangulation, Lawson flips on the exact in-circle
 * determinant (BigInt), then the Delaunay faces — triangles joined across every exactly cocircular
 * edge — each fanned again from its least vertex. Cut and fill (4.2) are rational: each outline is
 * clipped by every triangle and then by the plane's zero line, one half-plane at a time
 * (Sutherland–Hodgman keeps every kept point's winding, so a non-convex outline is measured right), and
 * the linear function is integrated from each piece's boundary, then rounded once.
 */
import { validate as validateSchema } from '../../generated/validate-FS_site.js';
import type * as G from '../../generated/types-FS_site.js';
import { halfString } from '../../derive/derive.js';
import { isqrt, toSafeNumber } from '../../exact/bigint.js';
import { Q } from '../../exact/rational.js';
import { area2, isSimple, locate, type IPoint } from '../../geometry/predicates.js';
import { entries, ipoint, type FloorspecDocument } from '../../model/document.js';
import { record, type ExtensionContext, type ExtensionImplementation } from '../context.js';

export type SiteData = G.FSSite010;
export type SpotElevation = G.SpotElevation;
export type ContourLine = G.ContourLine;
export type GradingPad = G.GradingPad;
export type Setbacks = G.Setbacks;

const NAME = 'FS_site';
const P = (...path: (string | number)[]): string => '/extensions/FS_site/' + path.join('/');
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 4.1: the slab purposes that lay a slab on the ground, so that it grades it. */
export const GRADING_PURPOSES: readonly string[] = ['patio', 'walkway', 'driveway', 'stoop', 'garage', 'equipmentPad'];

/** 2.2: an edge's kind. */
export type EdgeKind = 'front' | 'side' | 'rear';

/** 7.4: one graded outline's derived values. */
export interface DerivedGrading {
  kind: 'slab' | 'pad';
  elevation: number;
  low: number | null;
  high: number | null;
  cut: string | null;
  fill: string | null;
}

/** Chapter 7: what FS_site derives. */
export interface DerivedSite {
  lot: { area: string; edges: { kind: EdgeKind | null; length: number; setback: number | null }[] } | null;
  surface: { low: number; high: number; points: [number, number, number][]; triangles: [number, number, number][] } | null;
  grading: Record<string, DerivedGrading>;
  cut: string | null;
  fill: string | null;
}

// ── reading ───────────────────────────────────────────────────────────────────

/** FS-SITE-1.3: the IDs of the other extensions' records, read as data. */
function readAsData(doc: FloorspecDocument): Set<string> {
  const out = new Set<string>();
  for (const [name, member] of [['FS_lighting', 'scenes'], ['FS_views', 'views'], ['FS_annotation', 'dimensions'], ['FS_annotation', 'notes']] as const) {
    const data = (doc.extensions as Json | undefined)?.[name];
    const m = isObject(data) ? data[member] : undefined;
    if (isObject(m)) for (const k of Object.keys(m)) out.add(k);
  }
  return out;
}

/** 2.1: the lot, Core's site boundary, or undefined. */
export function lotOf(doc: FloorspecDocument): IPoint[] | undefined {
  const b = doc.site?.boundary;
  return Array.isArray(b) ? b.map(ipoint) : undefined;
}

const key = (p: IPoint): string => `${p[0]},${p[1]}`;

/** 3.1: every survey position, with the records and elevations there. */
function survey(data: Json): Map<string, { at: IPoint; elevations: Map<number, Set<string>> }> {
  const out = new Map<string, { at: IPoint; elevations: Map<number, Set<string>> }>();
  const add = (p: readonly [number, number], z: number, id: string) => {
    const at = ipoint(p);
    let s = out.get(key(at));
    if (!s) out.set(key(at), (s = { at, elevations: new Map() }));
    let ids = s.elevations.get(z);
    if (!ids) s.elevations.set(z, (ids = new Set()));
    ids.add(id);
  };
  for (const [id, s] of entries(data.spots as Record<string, SpotElevation> | undefined)) add(s.at, s.elevation, id);
  for (const [id, c] of entries(data.contours as Record<string, ContourLine> | undefined)) for (const p of c.points) add(p, c.elevation, id);
  return out;
}

/** 4.1: one graded outline — a grading slab or a pad — with its outline and the elevation it grades to. */
export interface GradedOutline {
  readonly id: string;
  readonly kind: 'slab' | 'pad';
  readonly ring: IPoint[];
  readonly elevation: number;
  readonly name?: string;
}

/** 4.1: every grading slab and every pad of a document, by ID. */
export function gradedOutlines(doc: FloorspecDocument, data: Json = siteData(doc)): GradedOutline[] {
  const out: GradedOutline[] = [];
  for (const [id, s] of entries(doc.slabs)) {
    if (s.purpose === undefined || !GRADING_PURPOSES.includes(s.purpose)) continue;
    const lv = doc.levels?.[s.level];
    if (!lv) continue;
    out.push({ id, kind: 'slab', ring: s.boundary.map(ipoint), elevation: lv.elevation + (s.offset ?? 0) - s.thickness, ...(s.name !== undefined && { name: s.name }) });
  }
  for (const [id, p] of entries(data.pads as Record<string, GradingPad> | undefined))
    out.push({ id, kind: 'pad', ring: p.boundary.map(ipoint), elevation: p.elevation, ...(p.name !== undefined && { name: p.name }) });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** FS_site's top-level data of a document, or an empty object. */
export function siteData(doc: FloorspecDocument): Json {
  const d = (doc.extensions as Json | undefined)?.[NAME];
  return isObject(d) ? d : {};
}

// ── the lot and its setbacks (2.2, 2.3) ───────────────────────────────────────

/** 2.2: each edge's kind, or null for every edge when there are no setbacks. */
export function edgeKinds(n: number, setbacks: Pick<Setbacks, 'street'> | undefined): (EdgeKind | null)[] {
  if (!setbacks) return Array<EdgeKind | null>(n).fill(null);
  const street = new Set(setbacks.street);
  return Array.from({ length: n }, (_, i) => (street.has(i) ? 'front' : street.has((i - 1 + n) % n) || street.has((i + 1) % n) ? 'side' : 'rear'));
}

/** 2.3: is p nearer than d to the closed segment ab? Exact. */
export function nearerThan(p: IPoint, a: IPoint, b: IPoint, d: bigint): boolean {
  const v = [b[0] - a[0], b[1] - a[1]] as const;
  const w = [p[0] - a[0], p[1] - a[1]] as const;
  const t = w[0] * v[0] + w[1] * v[1];
  const vv = v[0] * v[0] + v[1] * v[1];
  if (t <= 0n) return w[0] * w[0] + w[1] * w[1] < d * d;
  if (t >= vv) {
    const u = [p[0] - b[0], p[1] - b[1]] as const;
    return u[0] * u[0] + u[1] * u[1] < d * d;
  }
  const c = v[0] * w[1] - v[1] * w[0];
  return c * c < d * d * vv;
}

/** 2.3: is p clear of the setbacks — in or on the lot, and at least each edge's setback from it? */
export function clearOfSetbacks(p: IPoint, lot: readonly IPoint[], setbackOf: readonly (number | null | undefined)[]): boolean {
  if (locate(p, lot) === 'outside') return false;
  for (let i = 0; i < lot.length; i++) {
    const d = setbackOf[i];
    if (d !== null && d !== undefined && d > 0 && nearerThan(p, lot[i]!, lot[(i + 1) % lot.length]!, BigInt(d))) return false;
  }
  return true;
}

/** 2.2: each edge's setback distance, by the kind of edge. */
export function edgeSetbacks(n: number, setbacks: Setbacks | undefined): (number | null)[] {
  return edgeKinds(n, setbacks).map((k) => (k === null ? null : (setbacks?.[k] ?? null)));
}

// ── the surface (3.2) ─────────────────────────────────────────────────────────

const sgn = (v: bigint): -1 | 0 | 1 => (v > 0n ? 1 : v < 0n ? -1 : 0);

function orient(a: IPoint, b: IPoint, c: IPoint): -1 | 0 | 1 {
  return sgn((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
}

/** 3.2: > 0 when d is strictly inside the circle through a, b, c (counter-clockwise). */
export function incircle(a: IPoint, b: IPoint, c: IPoint, d: IPoint): -1 | 0 | 1 {
  const r = (p: IPoint) => {
    const x = p[0] - d[0];
    const y = p[1] - d[1];
    return [x, y, x * x + y * y] as const;
  };
  const [a1, a2, a3] = r(a);
  const [b1, b2, b3] = r(b);
  const [c1, c2, c3] = r(c);
  return sgn(a1 * (b2 * c3 - b3 * c2) - a2 * (b1 * c3 - b3 * c1) + a3 * (b1 * c2 - b2 * c1));
}

export type Triangle = [number, number, number];

const cmpPoint = (p: IPoint, q: IPoint): number => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0);

/**
 * 3.2: the surface's triangles over `pts` — distinct positions sorted by x and then y — as index
 * triples, each counter-clockwise from its least index, the list sorted; undefined when the positions
 * are all on one line (or fewer than three).
 */
export function triangulate(pts: readonly IPoint[]): Triangle[] | undefined {
  const n = pts.length;
  if (n < 3) return undefined;
  let k = 2;
  while (k < n && orient(pts[0]!, pts[1]!, pts[k]!) === 0) k++;
  if (k === n) return undefined;
  const tris: (Triangle | null)[] = [];
  const edge = new Map<string, number>(); // directed edge "a,b" -> triangle index
  const ek = (a: number, b: number) => `${a},${b}`;
  const add = (a: number, b: number, c: number): number => {
    const t: Triangle = orient(pts[a]!, pts[b]!, pts[c]!) > 0 ? [a, b, c] : [a, c, b];
    const i = tris.push(t) - 1;
    for (let j = 0; j < 3; j++) edge.set(ek(t[j]!, t[(j + 1) % 3]!), i);
    return i;
  };
  const drop = (i: number) => {
    const t = tris[i]!;
    for (let j = 0; j < 3; j++) edge.delete(ek(t[j]!, t[(j + 1) % 3]!));
    tris[i] = null;
  };
  for (let i = 0; i < k - 1; i++) add(i, i + 1, k);
  let hull = orient(pts[0]!, pts[k - 1]!, pts[k]!) > 0 ? [...Array(k).keys(), k] : [k, ...[...Array(k).keys()].reverse()];
  for (let q = k + 1; q < n; q++) {
    const m = hull.length;
    const vis = hull.map((h, i) => orient(pts[h]!, pts[hull[(i + 1) % m]!]!, pts[q]!) < 0);
    for (let i = 0; i < m; i++) if (vis[i]) add(hull[i]!, hull[(i + 1) % m]!, q);
    let start = 0;
    while (!(vis[start] && !vis[(start - 1 + m) % m])) start++;
    let end = start;
    while (vis[end % m]) end++;
    const next: number[] = [];
    for (let j = 0; j <= m - (end - start); j++) next.push(hull[(end + j) % m]!);
    next.push(q);
    hull = next;
  }
  // Lawson: flip every interior edge whose opposite vertex is strictly inside the circle across it.
  const stack: [number, number][] = [];
  for (const t of tris) if (t) for (let j = 0; j < 3; j++) stack.push([t[j]!, t[(j + 1) % 3]!]);
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const ti = edge.get(ek(a, b));
    const ui = edge.get(ek(b, a));
    if (ti === undefined || ui === undefined) continue;
    const t = tris[ti]!;
    const u = tris[ui]!;
    const c = t.find((x) => x !== a && x !== b)!;
    const d = u.find((x) => x !== a && x !== b)!;
    if (incircle(pts[a]!, pts[b]!, pts[c]!, pts[d]!) <= 0) continue;
    drop(ti);
    drop(ui);
    add(a, d, c);
    add(d, b, c);
    stack.push([a, d], [d, b], [b, c], [c, a]);
  }
  // The Delaunay faces: triangles joined across every exactly cocircular edge.
  const live = tris.flatMap((t, i) => (t ? [i] : []));
  const parent = new Map(live.map((i) => [i, i]));
  const find = (i: number): number => {
    let r = i;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    parent.set(i, r);
    return r;
  };
  for (const i of live) {
    const t = tris[i]!;
    for (let j = 0; j < 3; j++) {
      const a = t[j]!;
      const b = t[(j + 1) % 3]!;
      const ui = edge.get(ek(b, a));
      if (ui === undefined || ui < i) continue;
      const c = t[(j + 2) % 3]!;
      const d = tris[ui]!.find((x) => x !== a && x !== b)!;
      if (incircle(pts[a]!, pts[b]!, pts[c]!, pts[d]!) === 0) parent.set(find(i), find(ui));
    }
  }
  const faces = new Map<number, Set<number>>();
  for (const i of live) {
    const r = find(i);
    let f = faces.get(r);
    if (!f) faces.set(r, (f = new Set()));
    for (const v of tris[i]!) f.add(v);
  }
  const out: Triangle[] = [];
  for (const f of faces.values()) {
    const vs = [...f];
    const v0 = vs.reduce((m, v) => (cmpPoint(pts[v]!, pts[m]!) < 0 ? v : m));
    const rest = vs.filter((v) => v !== v0).sort((i, j) => -orient(pts[v0]!, pts[i]!, pts[j]!));
    for (let i = 0; i + 1 < rest.length; i++) out.push(norm([v0, rest[i]!, rest[i + 1]!]));
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

function norm(t: Triangle): Triangle {
  const k = t.indexOf(Math.min(...t));
  return [t[k]!, t[(k + 1) % 3]!, t[(k + 2) % 3]!];
}

/** 3.2: the surface — the survey's distinct positions sorted, with their elevations, and its triangles. */
export interface Surface {
  readonly points: readonly (readonly [bigint, bigint, number])[];
  readonly triangles: readonly Triangle[];
}

/** 3.2: a document's surface, or undefined when it has none. Survey points that disagree take the least elevation (an invalid document). */
export function surfaceOf(data: Json): Surface | undefined {
  const pts = [...survey(data).values()].map((s) => [s.at[0], s.at[1], Math.min(...s.elevations.keys())] as const).sort((p, q) => cmpPoint([p[0], p[1]], [q[0], q[1]]));
  const triangles = triangulate(pts.map((p) => [p[0], p[1]] as IPoint));
  return triangles && { points: pts, triangles };
}

/** The hull's boundary edges, counter-clockwise, from the triangles. */
function hullEdges(s: Surface): [IPoint, IPoint][] {
  const directed = new Set<string>();
  for (const t of s.triangles) for (let j = 0; j < 3; j++) directed.add(`${t[j]},${t[(j + 1) % 3]}`);
  const out: [IPoint, IPoint][] = [];
  for (const t of s.triangles)
    for (let j = 0; j < 3; j++) {
      const a = t[j]!;
      const b = t[(j + 1) % 3]!;
      if (!directed.has(`${b},${a}`)) out.push([[s.points[a]![0], s.points[a]![1]], [s.points[b]![0], s.points[b]![1]]]);
    }
  return out;
}

const outsideHull = (p: IPoint, hull: readonly [IPoint, IPoint][]): boolean => hull.some(([a, b]) => orient(a, b, p) < 0);

// ── cut and fill (4.2) ────────────────────────────────────────────────────────

type QPoint = readonly [Q, Q];

/** Sutherland–Hodgman: the part of `poly` where the linear function `f` ≥ 0. */
function clip(poly: readonly QPoint[], f: (p: QPoint) => Q): QPoint[] {
  const out: QPoint[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % n]!;
    const fp = f(p);
    const fq = f(q);
    if (fp.sign() >= 0) out.push(p);
    if ((fp.sign() > 0 && fq.sign() < 0) || (fp.sign() < 0 && fq.sign() > 0)) {
      const t = fp.div(fp.sub(fq));
      out.push([p[0].add(t.mul(q[0].sub(p[0]))), p[1].add(t.mul(q[1].sub(p[1])))]);
    }
  }
  return out;
}

/** The integral of α + βx + γy over a polygon, signed by its winding. */
function integral(poly: readonly QPoint[], alpha: Q, beta: Q, gamma: Q): Q {
  let A = Q.ZERO;
  let Mx = Q.ZERO;
  let My = Q.ZERO;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]!;
    const [x1, y1] = poly[(i + 1) % poly.length]!;
    const c = x0.mul(y1).sub(x1.mul(y0));
    A = A.add(c);
    Mx = Mx.add(x0.add(x1).mul(c));
    My = My.add(y0.add(y1).mul(c));
  }
  return alpha.mul(A).div(2n).add(beta.mul(Mx).div(6n)).add(gamma.mul(My).div(6n));
}

/** z = α + βx + γy through a triangle's three points. */
function planeOf(a: readonly [bigint, bigint, number], b: readonly [bigint, bigint, number], c: readonly [bigint, bigint, number]): [Q, Q, Q] {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const [x3, y3] = c;
  const z1 = BigInt(a[2]);
  const z2 = BigInt(b[2]);
  const z3 = BigInt(c[2]);
  const det = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
  const beta = Q.of((z2 - z1) * (y3 - y1) - (z3 - z1) * (y2 - y1), det);
  const gamma = Q.of((x2 - x1) * (z3 - z1) - (x3 - x1) * (z2 - z1), det);
  return [Q.of(z1).sub(beta.mul(x1)).sub(gamma.mul(y1)), beta, gamma];
}

/** 4.2: one outline's exact cut and fill over the surface, and the low and high of the ground under it. */
export function measureOutline(ring: readonly IPoint[], elevation: number, s: Surface): { cut: Q; fill: Q; low: Q | undefined; high: Q | undefined } {
  let r: QPoint[] = ring.map((p) => [Q.of(p[0]), Q.of(p[1])] as const);
  if (area2(ring) < 0n) r = r.reverse();
  const e = Q.of(elevation);
  let cut = Q.ZERO;
  let fill = Q.ZERO;
  let low: Q | undefined;
  let high: Q | undefined;
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const bmin = [xs.reduce((a, b) => (b < a ? b : a)), ys.reduce((a, b) => (b < a ? b : a))] as const;
  const bmax = [xs.reduce((a, b) => (b > a ? b : a)), ys.reduce((a, b) => (b > a ? b : a))] as const;
  for (const t of s.triangles) {
    const T = t.map((i) => s.points[i]!) as [readonly [bigint, bigint, number], readonly [bigint, bigint, number], readonly [bigint, bigint, number]];
    if (T.every((p) => p[0] < bmin[0]) || T.every((p) => p[0] > bmax[0]) || T.every((p) => p[1] < bmin[1]) || T.every((p) => p[1] > bmax[1])) continue;
    let piece: QPoint[] = r;
    for (let i = 0; i < 3 && piece.length > 0; i++) {
      const a = T[i]!;
      const b = T[(i + 1) % 3]!;
      const ax = Q.of(a[0]);
      const ay = Q.of(a[1]);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      piece = clip(piece, (p) => p[1].sub(ay).mul(dx).sub(p[0].sub(ax).mul(dy)));
    }
    if (piece.length === 0) continue;
    const [alpha, beta, gamma] = planeOf(T[0], T[1], T[2]);
    const z = (p: QPoint) => alpha.add(beta.mul(p[0])).add(gamma.mul(p[1]));
    for (const p of piece) {
      const v = z(p);
      if (!low || v.cmp(low) < 0) low = v;
      if (!high || v.cmp(high) > 0) high = v;
    }
    const h = (p: QPoint) => z(p).sub(e);
    const up = clip(piece, h);
    if (up.length > 0) cut = cut.add(integral(up, alpha.sub(e), beta, gamma));
    const down = clip(piece, (p) => h(p).neg());
    if (down.length > 0) fill = fill.sub(integral(down, alpha.sub(e), beta, gamma));
  }
  return { cut, fill, low, high };
}

// ── the extension ─────────────────────────────────────────────────────────────

function invariants(ctx: ExtensionContext): void {
  const taken = ctx.space();
  for (const id of readAsData(ctx.doc)) taken.add(id);
  const seen = new Set<string>();
  const bad = new Set<string>();
  for (const member of ['spots', 'contours', 'pads'])
    for (const [id] of ctx.records(member)) {
      if (taken.has(id) || seen.has(id)) bad.add(id);
      seen.add(id);
    }
  for (const id of [...bad].sort()) ctx.report('FS-SITE-INV-001', `The ID ${id} of FS_site's survey or grading is also the ID of an element, a record of another extension or another of FS_site's records.`, [id]);
  for (const s of survey(ctx.data).values())
    if (s.elevations.size > 1) {
      const ids = [...s.elevations.values()].flatMap((x) => [...x]);
      ctx.report('FS-SITE-INV-002', `The survey has ${s.elevations.size} elevations at (${s.at[0]}, ${s.at[1]}): ${[...new Set(ids)].sort().join(', ')} disagree.`, ids);
    }
  for (const [id, c] of ctx.records<ContourLine>('contours'))
    if (c.points.some((p, i) => i > 0 && p[0] === c.points[i - 1]![0] && p[1] === c.points[i - 1]![1])) ctx.report('FS-SITE-INV-003', `Contour line ${id} repeats a point.`, [id], P('contours', id, 'points'));
  for (const [id, p] of ctx.records<GradingPad>('pads')) {
    const ring = p.boundary.map(ipoint);
    if (!isSimple(ring) || area2(ring) === 0n) ctx.report('FS-SITE-INV-004', `Pad ${id}'s outline is not a simple polygon with an area.`, [id], P('pads', id, 'boundary'));
  }
  const sb = ctx.data.setbacks as Setbacks | undefined;
  if (sb) {
    const lot = lotOf(ctx.doc);
    if (!lot) ctx.report('FS-SITE-INV-005', 'There are setbacks, and the site has no boundary to draw them from.', [], P('setbacks'));
    else if (sb.street.some((i) => i >= lot.length)) ctx.report('FS-SITE-INV-005', `A street edge is not an edge of the lot, which has ${lot.length}.`, [], P('setbacks', 'street'));
  }
}

function lints(ctx: ExtensionContext): void {
  const lot = lotOf(ctx.doc);
  const s = surfaceOf(ctx.data);
  if (s) {
    const hull = hullEdges(s);
    if (lot && lot.some((p) => outsideHull(p, hull))) ctx.report('FS-SITE-LINT-001', 'The lot runs beyond the surveyed ground: the survey does not cover it all.', []);
    for (const g of gradedOutlines(ctx.doc, ctx.data))
      if (g.ring.some((p) => outsideHull(p, hull))) ctx.report('FS-SITE-LINT-002', `${g.kind === 'pad' ? 'Pad' : 'Slab'} ${g.id} runs beyond the surveyed ground: what it cuts and fills there is not measured.`, [g.id]);
  }
  const sb = ctx.data.setbacks as Setbacks | undefined;
  if (sb && lot) {
    const dist = edgeSetbacks(lot.length, sb);
    const things: [string, IPoint[]][] = [
      ...entries(ctx.doc.junctions).map(([id, j]) => [id, [ipoint(j.position)]] as [string, IPoint[]]),
      // 2.3: a walkway or a driveway reaches the street across the front setback by design
      ...entries(ctx.doc.slabs).filter(([, sl]) => sl.purpose !== 'walkway' && sl.purpose !== 'driveway').map(([id, sl]) => [id, sl.boundary.map(ipoint)] as [string, IPoint[]]),
      ...ctx.records<GradingPad>('pads').map(([id, p]) => [id, p.boundary.map(ipoint)] as [string, IPoint[]]),
    ];
    for (const [id, pts] of things)
      if (!pts.every((p) => clearOfSetbacks(p, lot, dist))) ctx.report('FS-SITE-LINT-003', `${id} is not clear of the setbacks: outside the lot, or nearer an edge than its setback. Advisory: setbacks are drawn, never enforced.`, [id]);
  }
}

const roundSqrt = (n: bigint): bigint => (isqrt(4n * n) + 1n) / 2n;

function derive(ctx: ExtensionContext): DerivedSite {
  const lot = lotOf(ctx.doc);
  const sb = ctx.data.setbacks as Setbacks | undefined;
  let lotOut: DerivedSite['lot'] = null;
  if (lot) {
    const kinds = edgeKinds(lot.length, sb);
    const a = area2(lot);
    lotOut = {
      area: halfString(a < 0n ? -a : a),
      edges: lot.map((p, i) => {
        const q = lot[(i + 1) % lot.length]!;
        const dx = q[0] - p[0];
        const dy = q[1] - p[1];
        const k = kinds[i] ?? null;
        return { kind: k, length: toSafeNumber(roundSqrt(dx * dx + dy * dy)), setback: k === null ? null : (sb?.[k] ?? null) };
      }),
    };
  }
  const s = surfaceOf(ctx.data);
  const zs = s?.points.map((p) => p[2]) ?? [];
  let cut = Q.ZERO;
  let fill = Q.ZERO;
  const grading = gradedOutlines(ctx.doc, ctx.data).map((g): [string, DerivedGrading] => {
    if (!s) return [g.id, { kind: g.kind, elevation: g.elevation, low: null, high: null, cut: null, fill: null }];
    const m = measureOutline(g.ring, g.elevation, s);
    cut = cut.add(m.cut);
    fill = fill.add(m.fill);
    return [g.id, { kind: g.kind, elevation: g.elevation, low: m.low ? toSafeNumber(m.low.round()) : null, high: m.high ? toSafeNumber(m.high.round()) : null, cut: `${m.cut.round()}`, fill: `${m.fill.round()}` }];
  });
  return {
    lot: lotOut,
    surface: s ? { low: Math.min(...zs), high: Math.max(...zs), points: s.points.map((p) => [toSafeNumber(p[0]), toSafeNumber(p[1]), p[2]]), triangles: s.triangles.map((t) => [...t] as Triangle) } : null,
    grading: record(grading),
    cut: s ? `${cut.round()}` : null,
    fill: s ? `${fill.round()}` : null,
  };
}

export const FS_SITE: ExtensionImplementation<DerivedSite> = {
  name: NAME,
  version: '0.1.0',
  code: 'SITE',
  catalogue: [
    { code: 'FS-SITE-SCH-001', severity: 'error', condition: 'the top-level data does not match the schema' },
    { code: 'FS-SITE-INV-001', severity: 'error', condition: "a record's ID is the ID of an element, a program item, an extension element, a scene, a view, a dimension string or a note, or of another of FS_site's records" },
    { code: 'FS-SITE-INV-002', severity: 'error', condition: 'survey points at one position with different elevations' },
    { code: 'FS-SITE-INV-003', severity: 'error', condition: 'a contour line with two equal consecutive points' },
    { code: 'FS-SITE-INV-004', severity: 'error', condition: "a pad's `boundary` that is not a simple polygon enclosing a positive area" },
    { code: 'FS-SITE-INV-005', severity: 'error', condition: '`setbacks` in a document whose site has no `boundary`, or a street edge the boundary does not have' },
    { code: 'FS-SITE-LINT-001', severity: 'info', condition: 'the document has a surface and a lot, and a vertex of the lot is outside the hull' },
    { code: 'FS-SITE-LINT-002', severity: 'warning', condition: 'the document has a surface, and a vertex of a graded outline is outside the hull' },
    { code: 'FS-SITE-LINT-003', severity: 'info', condition: 'the document has setbacks, and a junction, a slab other than a walkway or a driveway, or a pad is not clear of them' },
  ],
  validate: (data) => validateSchema(data),
  invariants,
  lints,
  derive,
};
