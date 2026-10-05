/**
 * The geometry of the measures: least width (5.3), triangulation of plan polygons, local
 * coordinates in a frame (Core 13.1) and clipping in them (7.6, 7.7). Exact throughout.
 */
import { Q, QR } from '../exact.js';
import type { IPoint, PlanFrame } from '../model.js';

export const cross = (o: IPoint, a: IPoint, b: IPoint): bigint => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

const cmpPoint = (a: IPoint, b: IPoint): number => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : 0);

/** The convex hull of integer points, counter-clockwise, with no collinear vertex (Andrew's monotone chain). */
export function hull(points: readonly IPoint[]): IPoint[] {
  const pts = [...points].sort(cmpPoint).filter((p, i, a) => i === 0 || cmpPoint(p, a[i - 1]!) !== 0);
  if (pts.length <= 2) return pts;
  const lower: IPoint[] = [];
  const upper: IPoint[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0n) lower.pop();
    lower.push(p);
  }
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0n) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

const abs = (a: bigint): bigint => (a < 0n ? -a : a);

/**
 * 5.3: the least width of a ring is C / √L: over the edges (a, b) of its convex hull, the greatest
 * |(b − a) × (v − a)| over its vertices, divided by |b − a|; the least of these, compared exactly.
 */
export function leastWidth(ring: readonly IPoint[]): { c: bigint; l: bigint } {
  const h = hull(ring);
  let best: { c: bigint; l: bigint } | undefined;
  for (let i = 0; i < h.length; i++) {
    const a = h[i]!;
    const b = h[(i + 1) % h.length]!;
    let c = 0n;
    for (const v of h) {
      const x = abs(cross(a, b, v));
      if (x > c) c = x;
    }
    const l = (b[0] - a[0]) ** 2n + (b[1] - a[1]) ** 2n;
    if (best === undefined || c * c * best.l < best.c * best.c * l) best = { c, l };
  }
  return best!;
}

const inClosedTriangle = (p: IPoint, a: IPoint, b: IPoint, c: IPoint): boolean => cross(a, b, p) >= 0n && cross(b, c, p) >= 0n && cross(c, a, p) >= 0n;
const same = (p: IPoint, q: IPoint): boolean => p[0] === q[0] && p[1] === q[1];

/**
 * Ear clipping of a simple counter-clockwise polygon with integer vertices: triangles whose
 * interiors, with the open diagonals between them, make the polygon's interior. Vertices on a
 * straight line between their neighbours are dropped first; the polygon is the same.
 */
export function triangulate(ring: readonly IPoint[]): [IPoint, IPoint, IPoint][] {
  const pts = [...ring];
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      if (cross(pts[(i - 1 + pts.length) % pts.length]!, pts[i]!, pts[(i + 1) % pts.length]!) === 0n) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  const tris: [IPoint, IPoint, IPoint][] = [];
  while (pts.length > 3) {
    const n = pts.length;
    let clipped = false;
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % n]!;
      if (cross(a, b, c) <= 0n) continue;
      if (pts.some((p) => !same(p, a) && !same(p, b) && !same(p, c) && inClosedTriangle(p, a, b, c))) continue;
      tris.push([a, b, c]);
      pts.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error('triangulate: no ear');
  }
  if (pts.length === 3) tris.push([pts[0]!, pts[1]!, pts[2]!]);
  return tris;
}

export type LocalPoint = readonly [QR, QR];

/** Local coordinates in a frame (Core 13.1): p = (P − O)·f / |f|, q = (P − O)·(−fy, fx) / |f|. */
export class Local {
  private readonly ox: QR;
  private readonly oy: QR;
  private readonly fx: bigint;
  private readonly fy: bigint;
  private readonly root: QR;

  constructor(frame: PlanFrame) {
    this.ox = QR.fromSurd(frame.ox);
    this.oy = QR.fromSurd(frame.oy);
    [this.fx, this.fy] = frame.f;
    this.root = QR.sqrt(this.fx * this.fx + this.fy * this.fy);
  }

  of(P: IPoint): LocalPoint {
    const dx = QR.int(P[0]).sub(this.ox);
    const dy = QR.int(P[1]).sub(this.oy);
    return [dx.mulInt(this.fx).add(dy.mulInt(this.fy)).div(this.root), dy.mulInt(this.fx).sub(dx.mulInt(this.fy)).div(this.root)];
  }
}

/** A half-plane of local coordinates: axis 0 (p) or 1 (q) at least (+1) or at most (−1) a bound. */
export type HalfPlane = readonly [axis: 0 | 1, bound: bigint, side: 1 | -1];

/** Sutherland–Hodgman: a polygon of local points clipped to the half-planes. */
export function clip(poly: readonly LocalPoint[], keep: readonly HalfPlane[]): LocalPoint[] {
  let cur = [...poly];
  for (const [axis, bound, side] of keep) {
    const b = QR.make(Q.of(bound));
    const out: LocalPoint[] = [];
    const n = cur.length;
    if (n === 0) return [];
    for (let i = 0; i < n; i++) {
      const p = cur[i]!;
      const q = cur[(i + 1) % n]!;
      const pin = side * p[axis].sub(b).sign() >= 0;
      const qin = side * q[axis].sub(b).sign() >= 0;
      if (pin) out.push(p);
      if (pin !== qin) {
        const t = b.sub(p[axis]).div(q[axis].sub(p[axis]));
        out.push([p[0].add(q[0].sub(p[0]).mul(t)), p[1].add(q[1].sub(p[1]).mul(t))]);
      }
    }
    cur = out;
  }
  return cur;
}

/** The sign of a polygon's area: positive when it has an interior, counter-clockwise. */
export function areaSign(poly: readonly LocalPoint[]): -1 | 0 | 1 {
  const n = poly.length;
  if (n < 3) return 0;
  let s = QR.int(0n);
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    s = s.add(a[0].mul(b[1]).sub(b[0].mul(a[1])));
  }
  return s.sign();
}

/** A ring of numbers as BigInt points. */
export const bigRing = (ring: readonly (readonly [number, number])[]): IPoint[] => ring.map((p) => [BigInt(p[0]), BigInt(p[1])] as const);
