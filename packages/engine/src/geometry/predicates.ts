/**
 * Exact predicates on integer points (5.3: "All three tests are exact: they use integer arithmetic
 * on junction positions, with no tolerance"). Points are BigInt pairs, so products of coordinates
 * up to 2^53 never overflow.
 */

export type IPoint = readonly [bigint, bigint];

export const sub = (a: IPoint, b: IPoint): IPoint => [a[0] - b[0], a[1] - b[1]];
export const cross = (a: IPoint, b: IPoint): bigint => a[0] * b[1] - a[1] * b[0];
export const dot = (a: IPoint, b: IPoint): bigint => a[0] * b[0] + a[1] * b[1];
export const eq = (a: IPoint, b: IPoint): boolean => a[0] === b[0] && a[1] === b[1];

/** Orientation of c relative to the directed line a→b: 1 left (counter-clockwise), −1 right, 0 on it. */
export function orient(a: IPoint, b: IPoint, c: IPoint): -1 | 0 | 1 {
  const v = cross(sub(b, a), sub(c, a));
  return v > 0n ? 1 : v < 0n ? -1 : 0;
}

/** Is p on the closed segment ab? */
export function onSegment(p: IPoint, a: IPoint, b: IPoint): boolean {
  if (orient(a, b, p) !== 0) return false;
  return dot(sub(p, a), sub(b, a)) >= 0n && dot(sub(p, b), sub(a, b)) >= 0n;
}

/** Is p in the interior of segment ab (on it, and not an endpoint)? A zero-length segment has none. */
export function inSegmentInterior(p: IPoint, a: IPoint, b: IPoint): boolean {
  if (eq(a, b) || eq(p, a) || eq(p, b)) return false;
  return onSegment(p, a, b);
}

/** 5.3.1: do segments ab and cd meet in a single point interior to both (a proper crossing)? */
export function properCross(a: IPoint, b: IPoint, c: IPoint, d: IPoint): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** 5.3.3: do segments ab and cd overlap in a segment of positive length? */
export function collinearOverlap(a: IPoint, b: IPoint, c: IPoint, d: IPoint): boolean {
  if (eq(a, b) || eq(c, d)) return false;
  if (orient(a, b, c) !== 0 || orient(a, b, d) !== 0) return false;
  // Project onto ab's direction; overlap has positive length iff the projected intervals do.
  const u = sub(b, a);
  const t0 = 0n;
  const t1 = dot(u, u);
  let s0 = dot(sub(c, a), u);
  let s1 = dot(sub(d, a), u);
  if (s0 > s1) [s0, s1] = [s1, s0];
  const lo = s0 > t0 ? s0 : t0;
  const hi = s1 < t1 ? s1 : t1;
  return lo < hi;
}

/** Do the closed segments ab and cd share at least one point? */
export function segmentsIntersect(a: IPoint, b: IPoint, c: IPoint, d: IPoint): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d);
}

/** Which half-plane a direction is in: 0 for angles in [0°, 180°), 1 for [180°, 360°). */
function half(d: IPoint): 0 | 1 {
  return d[1] > 0n || (d[1] === 0n && d[0] > 0n) ? 0 : 1;
}

/**
 * Compare two non-zero directions by their angle counter-clockwise from +X in [0°, 360°) (5.6),
 * exactly: by half-plane, then by the sign of the cross product.
 */
export function compareAngle(a: IPoint, b: IPoint): number {
  const ha = half(a);
  const hb = half(b);
  if (ha !== hb) return ha - hb;
  const c = cross(a, b);
  return c > 0n ? -1 : c < 0n ? 1 : 0;
}

/** Twice the signed area of a polygon (shoelace); positive when counter-clockwise. */
export function area2(poly: readonly IPoint[]): bigint {
  let s = 0n;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s;
}

/**
 * Winding number of a closed polyline around p, which must not lie on it. Works for polylines that
 * revisit vertices and run back along themselves (a face boundary around a dangling wall).
 */
export function winding(p: IPoint, poly: readonly IPoint[]): number {
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (a[1] <= p[1]) {
      if (b[1] > p[1] && orient(a, b, p) > 0) w++;
    } else if (b[1] <= p[1] && orient(a, b, p) < 0) w--;
  }
  return w;
}

/** Where p is relative to a closed polygon: 'on' its boundary, 'inside' (non-zero winding) or 'outside'. */
export function locate(p: IPoint, poly: readonly IPoint[]): 'on' | 'inside' | 'outside' {
  for (let i = 0; i < poly.length; i++) if (onSegment(p, poly[i]!, poly[(i + 1) % poly.length]!)) return 'on';
  return winding(p, poly) !== 0 ? 'inside' : 'outside';
}

/**
 * Is a polygon simple in the sense of 2.6: no two vertices coincide, and its edges meet only at
 * the vertex consecutive edges share?
 */
export function isSimple(poly: readonly IPoint[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  const seen = new Set<string>();
  for (const p of poly) {
    const k = `${p[0]},${p[1]}`;
    if (seen.has(k)) return false;
    seen.add(k);
  }
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      const c = poly[j]!;
      const d = poly[(j + 1) % n]!;
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) {
        // Consecutive edges share one vertex; they must not fold back over each other.
        const shared = j === i + 1 ? b : a;
        const other1 = j === i + 1 ? a : b;
        const other2 = j === i + 1 ? d : c;
        if (n === 3) {
          if (orient(other1, shared, other2) === 0) return false;
          continue;
        }
        if (collinearOverlap(other1, shared, shared, other2)) return false;
        if (onSegment(other2, other1, shared) || onSegment(other1, shared, other2)) return false;
      } else if (segmentsIntersect(a, b, c, d)) return false;
    }
  }
  return true;
}
