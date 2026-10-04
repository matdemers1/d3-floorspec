/**
 * Exact real numbers of the form
 *
 *     ( Σ_S c_S · √(∏_{i∈S} r_i) ) / δ
 *
 * — elements of a multiquadratic field ℚ(√r₁, …, √r_k), stored on the basis of square-root
 * products over subsets S of the generators r_i. Every derived coordinate in Floorspec Core is one
 * of these (5.5: face lines carry `p + q·√(dx² + dy²)`, so corner points are
 * `(α + β·√m + γ·√n) / δ`), and so is every quantity the engine compares them with.
 *
 * Signs are decided exactly by repeated squaring: writing x = u + v·√r_k with u, v in the field of
 * the first k − 1 generators, sign(x) follows from sign(u), sign(v) and sign(u² − v²·r_k), each of
 * which is a smaller instance of the same problem. Floor and round-half-to-even are found from an
 * integer estimate and then confirmed by exact sign tests, so no floating-point value ever decides
 * a result.
 */
import { abs, floorDiv, gcd, isqrt, sign as bsign } from './bigint.js';

export class Surd {
  /** Distinct generators, ascending, each > 1 and not a perfect square. */
  readonly rads: readonly bigint[];
  /** Coefficients, indexed by subset mask over `rads`; length 2^rads.length. */
  readonly coef: readonly bigint[];
  /** Positive denominator. */
  readonly den: bigint;

  private constructor(rads: readonly bigint[], coef: readonly bigint[], den: bigint) {
    this.rads = rads;
    this.coef = coef;
    this.den = den;
  }

  // ── construction ────────────────────────────────────────────────────────────

  static of(n: bigint | number, den: bigint | number = 1n): Surd {
    let d = BigInt(den);
    let c = BigInt(n);
    if (d === 0n) throw new RangeError('Surd: zero denominator');
    if (d < 0n) {
      d = -d;
      c = -c;
    }
    return Surd.make([], [c], d);
  }

  static readonly ZERO = Surd.of(0n);
  static readonly ONE = Surd.of(1n);

  /** √r for an integer r ≥ 0. */
  static sqrt(r: bigint): Surd {
    if (r < 0n) throw new RangeError('Surd.sqrt: negative radicand');
    // Pull out the largest square factor we can find cheaply, and keep the rest as a generator.
    let out = 1n;
    let rest = r;
    if (rest === 0n) return Surd.ZERO;
    const root = isqrt(rest);
    if (root * root === rest) return Surd.of(root);
    for (const p of [2n, 3n, 5n, 7n, 11n, 13n]) {
      while (rest % (p * p) === 0n) {
        rest /= p * p;
        out *= p;
      }
    }
    const r2 = isqrt(rest);
    if (r2 * r2 === rest) return Surd.of(out * r2);
    return Surd.make([rest], [0n, out], 1n);
  }

  private static make(rads: readonly bigint[], coef: readonly bigint[], den: bigint): Surd {
    // Reduce by the gcd of the coefficients and the denominator, so equal values tend to look equal
    // (not required for correctness — every comparison is exact either way).
    let g = den;
    for (const c of coef) {
      if (g === 1n) break;
      g = gcd(g, c);
    }
    if (g > 1n) return new Surd(rads, coef.map((c) => c / g), den / g);
    return new Surd(rads, coef, den);
  }

  // ── structure ───────────────────────────────────────────────────────────────

  /** Re-express this number over a superset of its generators. */
  private lift(rads: readonly bigint[]): bigint[] {
    const map = this.rads.map((r) => rads.indexOf(r));
    const out = new Array<bigint>(1 << rads.length).fill(0n);
    for (let mask = 0; mask < this.coef.length; mask++) {
      const c = this.coef[mask]!;
      if (c === 0n) continue;
      let m = 0;
      for (let i = 0; i < map.length; i++) if (mask & (1 << i)) m |= 1 << map[i]!;
      out[m] = c;
    }
    return out;
  }

  private static union(a: readonly bigint[], b: readonly bigint[]): bigint[] {
    if (a.length === b.length && a.every((x, i) => x === b[i])) return [...a];
    return [...new Set([...a, ...b])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  }

  get isRational(): boolean {
    return this.coef.every((c, i) => i === 0 || c === 0n);
  }

  // ── arithmetic ──────────────────────────────────────────────────────────────

  add(o: Surd): Surd {
    const rads = Surd.union(this.rads, o.rads);
    const a = this.lift(rads);
    const b = o.lift(rads);
    return Surd.make(
      rads,
      a.map((x, i) => x * o.den + b[i]! * this.den),
      this.den * o.den,
    ).compact();
  }

  neg(): Surd {
    return new Surd(this.rads, this.coef.map((c) => -c), this.den);
  }

  sub(o: Surd): Surd {
    return this.add(o.neg());
  }

  mulInt(k: bigint): Surd {
    return Surd.make(this.rads, this.coef.map((c) => c * k), this.den).compact();
  }

  divInt(k: bigint): Surd {
    if (k === 0n) throw new RangeError('Surd.divInt: division by zero');
    const s = k < 0n ? -1n : 1n;
    return Surd.make(this.rads, this.coef.map((c) => c * s), this.den * k * s);
  }

  addInt(k: bigint): Surd {
    const coef = [...this.coef];
    coef[0] = coef[0]! + k * this.den;
    return Surd.make(this.rads, coef, this.den);
  }

  mul(o: Surd): Surd {
    const rads = Surd.union(this.rads, o.rads);
    const a = this.lift(rads);
    const b = o.lift(rads);
    return Surd.make(rads, mulField(rads, a, b), this.den * o.den).compact();
  }

  /** Drop generators no coefficient uses any more. */
  private compact(): Surd {
    if (this.rads.length === 0) return this;
    let used = 0;
    for (let mask = 1; mask < this.coef.length; mask++) if (this.coef[mask] !== 0n) used |= mask;
    if (used === (1 << this.rads.length) - 1) return this;
    const keep = this.rads.map((_, i) => i).filter((i) => used & (1 << i));
    const rads = keep.map((i) => this.rads[i]!);
    const coef = new Array<bigint>(1 << rads.length).fill(0n);
    for (let mask = 0; mask < this.coef.length; mask++) {
      const c = this.coef[mask]!;
      if (c === 0n) continue;
      let m = 0;
      keep.forEach((i, j) => {
        if (mask & (1 << i)) m |= 1 << j;
      });
      coef[m] = c;
    }
    return new Surd(rads, coef, this.den);
  }

  // ── comparison ──────────────────────────────────────────────────────────────

  sign(): -1 | 0 | 1 {
    return signField(this.rads, this.coef);
  }

  cmp(o: Surd): -1 | 0 | 1 {
    return this.sub(o).sign();
  }

  equals(o: Surd): boolean {
    return this.cmp(o) === 0;
  }

  /** sign(this − k) for an integer k, without building a new Surd per probe. */
  private cmpInt(k: bigint): -1 | 0 | 1 {
    const coef = [...this.coef];
    coef[0] = coef[0]! - k * this.den;
    return signField(this.rads, coef);
  }

  // ── rounding ────────────────────────────────────────────────────────────────

  /** ⌊this⌋, exactly. */
  floor(): bigint {
    if (this.isRational) return floorDiv(this.coef[0]!, this.den);
    // An integer estimate: each √R scaled by 2^SHIFT and floored. Each term then errs by less than
    // |c_S| / 2^SHIFT, and SHIFT is chosen so the total error is far below one unit of the result;
    // exact sign tests then walk the estimate to the true floor in at most a step or two.
    let sumAbs = 0n;
    for (let mask = 1; mask < this.coef.length; mask++) sumAbs += abs(this.coef[mask]!);
    const bits = sumAbs.toString(2).length - this.den.toString(2).length + 16;
    const SHIFT = BigInt(Math.max(16, bits));
    let num = 0n;
    for (let mask = 0; mask < this.coef.length; mask++) {
      const c = this.coef[mask]!;
      if (c === 0n) continue;
      let r = 1n;
      for (let i = 0; i < this.rads.length; i++) if (mask & (1 << i)) r *= this.rads[i]!;
      num += c * isqrt(r << (2n * SHIFT));
    }
    let k = floorDiv(num, this.den << SHIFT);
    while (this.cmpInt(k) < 0) k -= 1n;
    while (this.cmpInt(k + 1n) >= 0) k += 1n;
    return k;
  }

  /** round(this): nearest integer, ties to even (0.3, 2.2). */
  round(): bigint {
    const f = this.floor();
    // sign(2·(this − f) − 1)
    const coef = this.coef.map((c) => 2n * c);
    coef[0] = coef[0]! - 2n * f * this.den - this.den;
    const s = signField(this.rads, coef);
    if (s < 0) return f;
    if (s > 0) return f + 1n;
    return f % 2n === 0n ? f : f + 1n;
  }

  /** A float approximation, for messages and debugging only — never for a decision or an output. */
  approx(): number {
    let v = 0;
    for (let mask = 0; mask < this.coef.length; mask++) {
      const c = this.coef[mask]!;
      if (c === 0n) continue;
      let r = 1;
      for (let i = 0; i < this.rads.length; i++) if (mask & (1 << i)) r *= Number(this.rads[i]!);
      v += Number(c) * Math.sqrt(r);
    }
    return v / Number(this.den);
  }

  toString(): string {
    const terms: string[] = [];
    for (let mask = 0; mask < this.coef.length; mask++) {
      const c = this.coef[mask]!;
      if (c === 0n) continue;
      const rs = this.rads.filter((_, i) => mask & (1 << i));
      terms.push(rs.length ? `${c}·√${rs.join('·')}` : `${c}`);
    }
    const body = terms.length ? terms.join(' + ') : '0';
    return this.den === 1n ? body : `(${body})/${this.den}`;
  }
}

/** Product in ℚ(√r₁…√r_k) on the subset basis: √R_S · √R_T = (∏_{S∩T} r) · √R_{S△T}. */
function mulField(rads: readonly bigint[], a: readonly bigint[], b: readonly bigint[]): bigint[] {
  const n = a.length;
  const out = new Array<bigint>(n).fill(0n);
  for (let i = 0; i < n; i++) {
    const ai = a[i]!;
    if (ai === 0n) continue;
    for (let j = 0; j < n; j++) {
      const bj = b[j]!;
      if (bj === 0n) continue;
      let f = ai * bj;
      const both = i & j;
      if (both) for (let t = 0; t < rads.length; t++) if (both & (1 << t)) f *= rads[t]!;
      out[i ^ j] = out[i ^ j]! + f;
    }
  }
  return out;
}

/**
 * The sign of Σ_S c_S·√R_S, exactly. Splits on the last generator r: x = u + v·√r, where u and v
 * live in the field of the others; if u and v disagree in sign, |u| against |v|·√r is decided by
 * the sign of u² − v²·r.
 */
function signField(rads: readonly bigint[], coef: readonly bigint[]): -1 | 0 | 1 {
  const k = rads.length;
  if (k === 0) return bsign(coef[0]!);
  const half = coef.length >> 1;
  const u = coef.slice(0, half);
  const v = coef.slice(half);
  const lower = rads.slice(0, k - 1);
  const sv = signField(lower, v);
  const su = signField(lower, u);
  if (sv === 0) return su;
  if (su === 0 || su === sv) return sv;
  const r = rads[k - 1]!;
  const uu = mulField(lower, u, u);
  const vv = mulField(lower, v, v);
  const t = uu.map((x, i) => x - vv[i]! * r);
  const st = signField(lower, t);
  return (su * st) as -1 | 0 | 1;
}
