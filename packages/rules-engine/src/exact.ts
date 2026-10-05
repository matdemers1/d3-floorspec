/**
 * Exact numbers for the measures (Rules 4.3): rationals over BigInt, and numbers `a + b·√m` with
 * rational `a`, `b` and one integer radicand `m` — the field ℚ(√m). Local coordinates in a frame
 * (Core 13.1) are of that form: a frame's facing vector `f` is a vector of integers, its origin's
 * coordinates are in ℚ(√|f|²), and a plan point's local coordinates are `(P − O)·f / |f|` and
 * `(P − O)·(−fy, fx) / |f|`. Clipping a polygon in local coordinates adds, multiplies and divides
 * such numbers and stays in the field. Signs, comparisons, floors and rounding are exact; no float
 * decides anything.
 */
import { floorDiv, gcd, isqrt, Surd } from '@floorspec/engine';

/** A rational number n / d, d > 0, in lowest terms. */
export class Q {
  readonly n: bigint;
  readonly d: bigint;

  private constructor(n: bigint, d: bigint) {
    this.n = n;
    this.d = d;
  }

  static of(n: bigint, d = 1n): Q {
    if (d === 0n) throw new RangeError('Q: zero denominator');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    return g > 1n ? new Q(n / g, d / g) : new Q(n, d);
  }

  static readonly ZERO = Q.of(0n);

  add(o: Q): Q {
    return Q.of(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Q): Q {
    return Q.of(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Q): Q {
    return Q.of(this.n * o.n, this.d * o.d);
  }
  div(o: Q): Q {
    return Q.of(this.n * o.d, this.d * o.n);
  }
  neg(): Q {
    return Q.of(-this.n, this.d);
  }
  sign(): -1 | 0 | 1 {
    return this.n > 0n ? 1 : this.n < 0n ? -1 : 0;
  }
  isZero(): boolean {
    return this.n === 0n;
  }
}

/** round(n / d), ties to even (Core 0.3). */
export function roundQ(q: Q): bigint {
  const f = floorDiv(q.n, q.d);
  const twice = 2n * (q.n - f * q.d);
  if (twice < q.d) return f;
  if (twice > q.d) return f + 1n;
  return f % 2n === 0n ? f : f + 1n;
}

/** A number a + b·√m: m = 0 for a rational, otherwise m > 1 and not a perfect square. */
export class QR {
  readonly a: Q;
  readonly b: Q;
  readonly m: bigint;

  private constructor(a: Q, b: Q, m: bigint) {
    this.a = a;
    this.b = b;
    this.m = m;
  }

  static make(a: Q, b: Q = Q.ZERO, m = 0n): QR {
    if (b.isZero() || m === 0n) return new QR(a, Q.ZERO, 0n);
    const r = isqrt(m);
    if (r * r === m) return new QR(a.add(b.mul(Q.of(r))), Q.ZERO, 0n);
    return new QR(a, b, m);
  }

  static int(n: bigint): QR {
    return new QR(Q.of(n), Q.ZERO, 0n);
  }

  /** A Surd of the engine with at most one generator, as a QR. */
  static fromSurd(s: Surd): QR {
    if (s.rads.length === 0) return QR.make(Q.of(s.coef[0]!, s.den));
    if (s.rads.length > 1) throw new Error('QR.fromSurd: more than one radicand');
    return QR.make(Q.of(s.coef[0]!, s.den), Q.of(s.coef[1]!, s.den), s.rads[0]);
  }

  /** √n, with the radicand reduced exactly as the engine's Surd.sqrt reduces it, so the two mix. */
  static sqrt(n: bigint): QR {
    return QR.fromSurd(Surd.sqrt(n));
  }

  private radicand(o: QR): bigint {
    if (this.m !== 0n && o.m !== 0n && this.m !== o.m) throw new Error('QR: two radicands');
    return this.m === 0n ? o.m : this.m;
  }

  add(o: QR): QR {
    return QR.make(this.a.add(o.a), this.b.add(o.b), this.radicand(o));
  }
  sub(o: QR): QR {
    return QR.make(this.a.sub(o.a), this.b.sub(o.b), this.radicand(o));
  }
  neg(): QR {
    return QR.make(this.a.neg(), this.b.neg(), this.m);
  }
  mul(o: QR): QR {
    const m = this.radicand(o);
    return QR.make(this.a.mul(o.a).add(this.b.mul(o.b).mul(Q.of(m))), this.a.mul(o.b).add(this.b.mul(o.a)), m);
  }
  mulInt(k: bigint): QR {
    const q = Q.of(k);
    return QR.make(this.a.mul(q), this.b.mul(q), this.m);
  }
  div(o: QR): QR {
    const m = this.radicand(o);
    const den = o.a.mul(o.a).sub(o.b.mul(o.b).mul(Q.of(m)));
    if (den.isZero()) throw new RangeError('QR: division by zero');
    const num = this.mul(QR.make(o.a, o.b.neg(), m));
    return QR.make(num.a.div(den), num.b.div(den), m);
  }

  sign(): -1 | 0 | 1 {
    const sa = this.a.sign();
    const sb = this.b.sign();
    if (sb === 0) return sa;
    if (sa === 0 || sa === sb) return sb;
    // a and b√m disagree in sign: compare a² with b²m.
    const t = this.a.mul(this.a).sub(this.b.mul(this.b).mul(Q.of(this.m))).sign();
    return (sa * t) as -1 | 0 | 1;
  }

  cmp(o: QR): -1 | 0 | 1 {
    return this.sub(o).sign();
  }

  /** ⌊this⌋, exactly: with x = (N + B√m) / D, ⌊x⌋ = ⌊(N + ⌊B√m⌋) / D⌋, as √m is irrational. */
  floor(): bigint {
    if (this.m === 0n) return floorDiv(this.a.n, this.a.d);
    const D = this.a.d * this.b.d;
    const N = this.a.n * this.b.d;
    const B = this.b.n * this.a.d;
    const r = isqrt(B * B * this.m);
    const fl = B >= 0n ? r : -r - 1n; // B√m is never an integer here
    return floorDiv(N + fl, D);
  }

  /** round(this): nearest integer, ties to even. */
  round(): bigint {
    const k = this.floor();
    const s = this.sub(QR.make(Q.of(2n * k + 1n, 2n))).sign();
    if (s < 0) return k;
    if (s > 0) return k + 1n;
    return k % 2n === 0n ? k : k + 1n;
  }
}

/** round(k / √n) for integers k and n > 0, exactly (ties to even). */
export function roundDivSqrt(k: bigint, n: bigint): bigint {
  if (k < 0n) return -roundDivSqrt(-k, n);
  let f = isqrt((k * k) / n);
  while ((f + 1n) * (f + 1n) * n <= k * k) f += 1n;
  while (f * f * n > k * k) f -= 1n;
  const lhs = 4n * k * k;
  const rhs = (2n * f + 1n) * (2n * f + 1n) * n;
  if (lhs < rhs) return f;
  if (lhs > rhs) return f + 1n;
  return f % 2n === 0n ? f : f + 1n;
}

/** round(√n) for an integer n ≥ 0 (never a tie: (2k + 1)² / 4 is not an integer). */
export function roundSqrt(n: bigint): bigint {
  const k = isqrt(n);
  return 4n * n > (2n * k + 1n) * (2n * k + 1n) ? k + 1n : k;
}

/** round(p / q) for integers, ties to even. */
export const roundDiv = (p: bigint, q: bigint): bigint => roundQ(Q.of(p, q));
