/**
 * Exact rationals on BigInt, always in lowest terms with a positive denominator. Used where a
 * derivation is rational but not integral — a stair's local coordinates (halves of a width), the
 * elevation of riser k (k · rise / n), the parameter along a headroom lane (17.6).
 */
import { gcd, roundHalfEvenRational } from './bigint.js';
import { Surd } from './surd.js';

export class Q {
  readonly n: bigint;
  readonly d: bigint;

  private constructor(n: bigint, d: bigint) {
    this.n = n;
    this.d = d;
  }

  static of(n: bigint | number, d: bigint | number = 1n): Q {
    let N = BigInt(n);
    let D = BigInt(d);
    if (D === 0n) throw new RangeError('Q: zero denominator');
    if (D < 0n) {
      N = -N;
      D = -D;
    }
    const g = gcd(N, D);
    return g > 1n ? new Q(N / g, D / g) : new Q(N, D);
  }

  static readonly ZERO = Q.of(0n);
  static readonly ONE = Q.of(1n);

  add(o: Q | bigint): Q {
    const b = typeof o === 'bigint' ? Q.of(o) : o;
    return this.d === b.d ? Q.of(this.n + b.n, this.d) : Q.of(this.n * b.d + b.n * this.d, this.d * b.d);
  }
  sub(o: Q | bigint): Q {
    return this.add(typeof o === 'bigint' ? Q.of(-o) : o.neg());
  }
  neg(): Q {
    return new Q(-this.n, this.d);
  }
  mul(o: Q | bigint): Q {
    return typeof o === 'bigint' ? Q.of(this.n * o, this.d) : Q.of(this.n * o.n, this.d * o.d);
  }
  div(o: Q | bigint): Q {
    return typeof o === 'bigint' ? Q.of(this.n, this.d * o) : Q.of(this.n * o.d, this.d * o.n);
  }
  sign(): -1 | 0 | 1 {
    return this.n > 0n ? 1 : this.n < 0n ? -1 : 0;
  }
  cmp(o: Q | bigint): -1 | 0 | 1 {
    const b = typeof o === 'bigint' ? Q.of(o) : o;
    const l = this.n * b.d;
    const r = b.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  eq(o: Q | bigint): boolean {
    return this.cmp(o) === 0;
  }
  abs(): Q {
    return this.n < 0n ? this.neg() : this;
  }
  /** round(this): nearest integer, ties to even (2.2). */
  round(): bigint {
    return roundHalfEvenRational(this.n, this.d);
  }
  toSurd(): Surd {
    return Surd.of(this.n, this.d);
  }
  static min(a: Q, b: Q): Q {
    return a.cmp(b) <= 0 ? a : b;
  }
  static max(a: Q, b: Q): Q {
    return a.cmp(b) >= 0 ? a : b;
  }
  toString(): string {
    return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`;
  }
}
