/**
 * Exact plan arithmetic: rationals over BigInt, polygons of rational points clipped by half-planes
 * with integer normals, their areas and extents. Used where the mesher must state an exact value
 * that is not an integer — where an opening's cut ends across a wall's outline — and by the tests
 * that check volumes against the exact analytic values.
 */

export type IPoint = readonly [bigint, bigint];

/** A rational n / d with d > 0. Not reduced until it is compared or output. */
export class Rat {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new RangeError('division by zero');
    this.n = d < 0n ? -n : n;
    this.d = d < 0n ? -d : d;
  }
  static of(n: bigint | number): Rat {
    return new Rat(BigInt(n));
  }
  add(o: Rat): Rat {
    return this.d === o.d ? new Rat(this.n + o.n, this.d) : new Rat(this.n * o.d + o.n * this.d, this.d * o.d).reduce();
  }
  sub(o: Rat): Rat {
    return this.add(o.neg());
  }
  neg(): Rat {
    return new Rat(-this.n, this.d);
  }
  mul(o: Rat): Rat {
    return new Rat(this.n * o.n, this.d * o.d).reduce();
  }
  div(o: Rat): Rat {
    return new Rat(this.n * o.d, this.d * o.n).reduce();
  }
  cmp(o: Rat): -1 | 0 | 1 {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  sign(): -1 | 0 | 1 {
    return this.n < 0n ? -1 : this.n > 0n ? 1 : 0;
  }
  reduce(): Rat {
    const g = gcd(this.n, this.d);
    return g > 1n ? new Rat(this.n / g, this.d / g) : this;
  }
  /** The nearest double: exact for an integer of at most 53 bits. */
  toNumber(): number {
    const r = this.reduce();
    if (r.d === 1n) return Number(r.n);
    const q = r.n / r.d;
    return Number(q) + Number(r.n - q * r.d) / Number(r.d);
  }
}

export function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export type RPoint = readonly [Rat, Rat];

export const rpoint = (p: IPoint): RPoint => [new Rat(p[0]), new Rat(p[1])];

/** A half-plane { P : s · (a · P) ≥ s · c } — `a · P ≥ c` (s = 1) or `a · P ≤ c` (s = −1). */
export interface HalfPlane {
  a: IPoint;
  c: bigint;
  s: 1 | -1;
}

const value = (h: HalfPlane, p: RPoint): Rat => {
  const v = p[0].mul(new Rat(h.a[0])).add(p[1].mul(new Rat(h.a[1]))).sub(new Rat(h.c));
  return h.s === 1 ? v : v.neg();
};

/** Sutherland–Hodgman: a polygon clipped to a half-plane. Its area is exact even where the result has zero-width bridges. */
export function clip(poly: readonly RPoint[], h: HalfPlane): RPoint[] {
  const out: RPoint[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % n]!;
    const fp = value(h, p);
    const fq = value(h, q);
    if (fp.sign() >= 0) out.push(p);
    if ((fp.sign() > 0 && fq.sign() < 0) || (fp.sign() < 0 && fq.sign() > 0)) {
      const t = fp.div(fp.sub(fq));
      out.push([p[0].add(q[0].sub(p[0]).mul(t)), p[1].add(q[1].sub(p[1]).mul(t))]);
    }
  }
  return out;
}

/** Twice the signed area of a polygon of rational points. */
export function area2(poly: readonly RPoint[]): Rat {
  let s = new Rat(0n);
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % n]!;
    s = s.add(p[0].mul(q[1]).sub(q[0].mul(p[1])));
  }
  return s;
}

/** Twice the signed area of an integer ring. */
export function iarea2(ring: readonly IPoint[]): bigint {
  let s = 0n;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s;
}

/** The least and greatest coordinates of a set of rational points, or undefined for none. */
export function extent(points: readonly RPoint[]): { min: [Rat, Rat]; max: [Rat, Rat] } | undefined {
  if (!points.length) return undefined;
  let [x0, y0] = points[0]!;
  let [x1, y1] = points[0]!;
  for (const [x, y] of points) {
    if (x.cmp(x0) < 0) x0 = x;
    if (x.cmp(x1) > 0) x1 = x;
    if (y.cmp(y0) < 0) y0 = y;
    if (y.cmp(y1) > 0) y1 = y;
  }
  return { min: [x0, y0], max: [x1, y1] };
}

/**
 * The regularized remainder of [lo, hi] after removing every open interval of `cuts`: the closed
 * intervals of positive length that remain, in order.
 */
export function remainder(lo: bigint, hi: bigint, cuts: readonly (readonly [bigint, bigint])[]): [bigint, bigint][] {
  const sorted = [...cuts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: [bigint, bigint][] = [];
  let at = lo;
  for (const [a, b] of sorted) {
    if (a > at) out.push([at, a < hi ? a : hi]);
    if (b > at) at = b;
    if (at >= hi) break;
  }
  if (at < hi) out.push([at, hi]);
  return out.filter(([a, b]) => b > a);
}
