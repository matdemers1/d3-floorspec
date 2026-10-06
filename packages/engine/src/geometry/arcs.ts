/**
 * Arc edges (Core 0.4, chapter 21): the polyline of an arc edge, made by iterated snap rounding, and its
 * length, stations and points.
 *
 * An arc edge is a wall or a separator with `"arc": { "sagitta": h }`: a circular arc from its start
 * junction S to its end junction E whose midpoint is |h| from the chord's midpoint — to the chord's left,
 * seen from S towards E, when h > 0. Nothing computes with the circle: every derived value comes from
 * the arc's polyline (21.2) — S, the arc's midpoint P rounded once per coordinate, then the polylines of
 * the arcs S→P and P→E, each with the sagitta, rounded, of its chord on the circle of the arc it halves,
 * until an arc's sagitta is at most TAU, when its polyline is its chord.
 *
 * Every value is a bigint, a rational (Q) or a Surd, and every rounding is round-half-to-even decided
 * exactly: no floating point and no transcendental function, so Node and every browser derive the
 * same polyline, vertex for vertex.
 */
import { Q } from '../exact/rational.js';
import { Surd } from '../exact/surd.js';
import { abs, gcd, isqrt } from '../exact/bigint.js';
import { collinearOverlap, eq, inSegmentInterior, onSegment, properCross, segmentsIntersect, type IPoint } from './predicates.js';

/** 21.2: the tolerance, 1 mm. An arc whose sagitta is at most TAU is its chord. */
export const TAU = 1280n;

/** round(√m) for an integer m ≥ 0. A tie would need (r + ½)² = m, which no integer is. */
export function roundSqrt(m: bigint): bigint {
  const r = isqrt(m);
  return m > r * r + r ? r + 1n : r;
}

const d2 = (a: IPoint, b: IPoint): bigint => (b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]);

/** 21.1.2: at most a semicircle — 4h² ≤ |E − S|². */
export function arcFits(S: IPoint, E: IPoint, h: bigint): boolean {
  return 4n * h * h <= d2(S, E);
}

/** The arc's radius, (|d|² + 4h²) / (8|h|). */
export function arcRadius(S: IPoint, E: IPoint, h: bigint): Q {
  return Q.of(d2(S, E) + 4n * h * h, 8n * abs(h));
}

/** 21.2 step 2: the arc's exact midpoint M + h·n/|d|, rounded once per coordinate. */
export function arcMidpoint(S: IPoint, E: IPoint, h: bigint): IPoint {
  const dx = E[0] - S[0];
  const dy = E[1] - S[1];
  const D = dx * dx + dy * dy;
  // h·n/|d| = h·n·√D / D
  const k = Surd.sqrt(D);
  const x = Surd.of(S[0] + E[0], 2n).add(k.mulInt(-h * dy).divInt(D));
  const y = Surd.of(S[1] + E[1], 2n).add(k.mulInt(h * dx).divInt(D));
  return [x.round(), y.round()];
}

/** √q for a rational q ≥ 0, exactly: √(n/d) = √(n·d) / d. */
function sqrtQ(q: Q): Surd {
  if (q.sign() < 0) throw new RangeError('sqrtQ: negative');
  return Surd.sqrt(q.n * q.d).divInt(q.d);
}

/** 21.2 step 3: the sagitta, rounded, of the chord AB on a circle of radius R — R − √(R² − |AB|²/4) — signed. */
export function sagittaOn(R: Q, A: IPoint, B: IPoint, sign: 1n | -1n): bigint {
  const v = R.toSurd().sub(sqrtQ(R.mul(R).sub(Q.of(d2(A, B), 4n))));
  return sign * v.round();
}

const cache = new Map<string, readonly IPoint[]>();

/** 21.2: the polyline of the arc S → E with sagitta h — integer points from S to E. The arc must fit (21.1.2). */
export function arcPolyline(S: IPoint, E: IPoint, h: bigint): readonly IPoint[] {
  const key = `${S[0]},${S[1]},${E[0]},${E[1]},${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let out: readonly IPoint[];
  if (abs(h) <= TAU) out = [S, E];
  else {
    const P = arcMidpoint(S, E, h);
    const R = arcRadius(S, E, h);
    const sign = h > 0n ? 1n : -1n;
    const left = arcPolyline(S, P, sagittaOn(R, S, P, sign));
    const right = arcPolyline(P, E, sagittaOn(R, P, E, sign));
    out = [...left, ...right.slice(1)];
  }
  if (cache.size > 4096) cache.clear();
  cache.set(key, out);
  return out;
}

/** 21.6: each segment's rounded length. */
export function segmentLengths(poly: readonly IPoint[]): bigint[] {
  const out: bigint[] = [];
  for (let i = 1; i < poly.length; i++) out.push(roundSqrt(d2(poly[i - 1]!, poly[i]!)));
  return out;
}

/** 21.6: an arc edge's length, the sum of its segments' rounded lengths. */
export function polylineLength(poly: readonly IPoint[]): bigint {
  return segmentLengths(poly).reduce((s, l) => s + l, 0n);
}

/**
 * 21.6: the segment (0-based) the distance t falls on — half-open [s_k, s_k+1), the last including its
 * end — and the station at its start; undefined when t is negative or past the end.
 */
export function segmentAt(poly: readonly IPoint[], t: Q): { k: number; s: bigint; l: bigint } | undefined {
  const ls = segmentLengths(poly);
  const total = ls.reduce((s, l) => s + l, 0n);
  if (t.sign() < 0 || t.cmp(total) > 0) return undefined;
  let s = 0n;
  for (let k = 0; k < ls.length; k++) {
    if (t.cmp(s + ls[k]!) < 0 || k === ls.length - 1) return { k, s, l: ls[k]! };
    s += ls[k]!;
  }
  return undefined;
}

/** 21.6: the exact point at distance t along an arc edge's polyline. */
export function pointAt(poly: readonly IPoint[], t: Q): [Q, Q] {
  const at = segmentAt(poly, t)!;
  const a = poly[at.k]!;
  const b = poly[at.k + 1]!;
  const f = t.sub(at.s).div(at.l);
  return [f.mul(b[0] - a[0]).add(a[0]), f.mul(b[1] - a[1]).add(a[1])];
}

/** The shortest vector of integers in the direction of a rational vector. */
export function primitive(v: readonly [Q, Q]): IPoint {
  const den = (v[0].d / gcd(v[0].d, v[1].d)) * v[1].d;
  const x = v[0].mul(den);
  const y = v[1].mul(den);
  const g = gcd(x.n, y.n) || 1n;
  return [x.n / g, y.n / g];
}

/** An edge's sagitta when its `arc` is a well-formed arc (21.1.1), else undefined. */
export function sagittaOf(e: { arc?: { sagitta?: unknown } } | undefined): bigint | undefined {
  const h = e?.arc?.sagitta;
  return typeof h === 'number' && Number.isSafeInteger(h) && h !== 0 ? BigInt(h) : undefined;
}

/** 5.3.2, 21.3.1: p lies on a location line — a segment, or an arc's polyline — and is not one of its ends. */
export function inInterior(p: IPoint, line: readonly IPoint[]): boolean {
  if (line.length === 2) return inSegmentInterior(p, line[0]!, line[1]!);
  if (eq(p, line[0]!) || eq(p, line[line.length - 1]!)) return false;
  for (let i = 1; i < line.length; i++) if (onSegment(p, line[i - 1]!, line[i]!)) return true;
  return false;
}

/**
 * 5.3.1, 5.3.3, 21.3.1: FS-INV-106 when two location lines overlap along a segment, FS-INV-104 when they
 * meet at a point interior to both, else undefined. Two straight lines are 5.3's tests exactly; a junction
 * inside the other line is FS-INV-105's.
 */
export function locationLinesMeet(A: readonly IPoint[], B: readonly IPoint[]): 'FS-INV-104' | 'FS-INV-106' | undefined {
  if (A.length === 2 && B.length === 2) {
    if (properCross(A[0]!, A[1]!, B[0]!, B[1]!)) return 'FS-INV-104';
    if (collinearOverlap(A[0]!, A[1]!, B[0]!, B[1]!)) return 'FS-INV-106';
    return undefined;
  }
  for (let i = 1; i < A.length; i++)
    for (let k = 1; k < B.length; k++) if (collinearOverlap(A[i - 1]!, A[i]!, B[k - 1]!, B[k]!)) return 'FS-INV-106';
  const ends = [A[0]!, A[A.length - 1]!, B[0]!, B[B.length - 1]!];
  const isEnd = (p: IPoint): boolean => ends.some((q) => eq(p, q));
  for (let i = 1; i < A.length; i++)
    for (let k = 1; k < B.length; k++) {
      const a1 = A[i - 1]!;
      const a2 = A[i]!;
      const b1 = B[k - 1]!;
      const b2 = B[k]!;
      if (!segmentsIntersect(a1, a2, b1, b2)) continue;
      if (properCross(a1, a2, b1, b2)) return 'FS-INV-104';
      for (const p of [a1, a2, b1, b2]) if (!isEnd(p) && onSegment(p, a1, a2) && onSegment(p, b1, b2)) return 'FS-INV-104';
    }
  return undefined;
}
