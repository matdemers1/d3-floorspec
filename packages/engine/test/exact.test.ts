import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { floorDiv, isqrt, roundHalfEvenRational } from '../src/exact/bigint.js';
import { Surd } from '../src/exact/surd.js';

/** An independent reference: ⌊(a + b√m + c√n)/d · 2^K⌋ by integer square roots at high precision. */
function reference(a: bigint, b: bigint, m: bigint, c: bigint, n: bigint): { lo: bigint; hi: bigint } {
  const K = 200n;
  const S = 1n << K;
  // ⌊b√m·S⌋ ≤ b√m·S < … ; bound each term within ±1 (sign aware)
  const term = (k: bigint, r: bigint): [bigint, bigint] => {
    const root = isqrt(r * S * S); // ⌊√r·S⌋
    const exact = root * root === r * S * S;
    const lo = k >= 0n ? k * root : k * (root + (exact ? 0n : 1n));
    const hi = k >= 0n ? k * (root + (exact ? 0n : 1n)) : k * root;
    return [lo, hi];
  };
  const [bl, bh] = term(b, m);
  const [cl, ch] = term(c, n);
  return { lo: a * S + bl + cl, hi: a * S + bh + ch }; // numerator bounds, before dividing by d·S
}

describe('integer helpers', () => {
  it('isqrt', () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 40n, 10n ** 40n - 1n]) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
    }
  });
  it('floorDiv', () => {
    expect(floorDiv(7n, 2n)).toBe(3n);
    expect(floorDiv(-7n, 2n)).toBe(-4n);
    expect(floorDiv(7n, -2n)).toBe(-4n);
    expect(floorDiv(-6n, 2n)).toBe(-3n);
  });
  it('round half to even on rationals', () => {
    expect(roundHalfEvenRational(1n, 2n)).toBe(0n);
    expect(roundHalfEvenRational(3n, 2n)).toBe(2n);
    expect(roundHalfEvenRational(5n, 2n)).toBe(2n);
    expect(roundHalfEvenRational(-1n, 2n)).toBe(0n);
    expect(roundHalfEvenRational(-3n, 2n)).toBe(-2n);
    expect(roundHalfEvenRational(7n, 3n)).toBe(2n);
    expect(roundHalfEvenRational(-7n, 3n)).toBe(-2n);
  });
});

describe('Surd', () => {
  it('decides signs of sums of square roots exactly', () => {
    const s2 = Surd.sqrt(2n);
    const s3 = Surd.sqrt(3n);
    const s6 = Surd.sqrt(6n);
    // (√2 + √3)² = 5 + 2√6
    expect(s2.add(s3).mul(s2.add(s3)).sub(Surd.of(5n)).sub(s6.mulInt(2n)).sign()).toBe(0);
    // √2 + √3 > √10 (3.146 > 3.162? no: 3.146 < 3.162)
    expect(s2.add(s3).cmp(Surd.sqrt(10n))).toBe(-1);
    // √8 = 2√2
    expect(Surd.sqrt(8n).sub(s2.mulInt(2n)).sign()).toBe(0);
    // A near miss: √(10^20 + 1) − 10^10 is tiny but positive
    expect(Surd.sqrt(10n ** 20n + 1n).sub(Surd.of(10n ** 10n)).sign()).toBe(1);
  });

  it('floors and rounds exactly', () => {
    expect(Surd.sqrt(2n).floor()).toBe(1n);
    expect(Surd.sqrt(2n).neg().floor()).toBe(-2n);
    expect(Surd.of(7n, 2n).round()).toBe(4n);
    expect(Surd.of(5n, 2n).round()).toBe(2n);
    expect(Surd.of(-5n, 2n).round()).toBe(-2n);
    // 6400/√2 = 4525.48…
    expect(Surd.sqrt(2n).mulInt(6400n).divInt(2n).round()).toBe(4525n);
    // A value within 10^-20 of a half: (1 + 2·10^10 − √(10^20·4·… )) — 0.5 + ε rounds up, 0.5 − ε down
    const big = 10n ** 20n;
    const justAbove = Surd.sqrt(big * big + 1n).sub(Surd.of(big)).add(Surd.of(1n, 2n)); // 0.5 + 5e-21
    expect(justAbove.round()).toBe(1n);
    const justBelow = Surd.of(1n, 2n).sub(Surd.sqrt(big * big + 1n).sub(Surd.of(big))); // 0.5 − 5e-21
    expect(justBelow.round()).toBe(0n);
  });

  it('floor agrees with a high-precision integer reference (property)', () => {
    const small = fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n });
    const rad = fc.bigInt({ min: 2n, max: 10n ** 32n });
    fc.assert(
      fc.property(small, small, rad, small, rad, fc.bigInt({ min: 1n, max: 10n ** 25n }), (a, b, m, c, n, d) => {
        const x = Surd.of(a).add(Surd.sqrt(m).mulInt(b)).add(Surd.sqrt(n).mulInt(c)).divInt(d);
        const f = x.floor();
        const { lo, hi } = reference(a, b, m, c, n);
        const S = 1n << 200n;
        // f must be ⌊v⌋ for some v in [lo, hi] / (d·S); the interval is far narrower than one unit
        // unless v sits on an integer, so require f to be the floor of one of its ends.
        const fl = floorDiv(lo, d * S);
        const fh = floorDiv(hi, d * S);
        expect(f === fl || f === fh).toBe(true);
      }),
      { numRuns: 500, seed: 20261004 },
    );
  });

  it('round is ties-to-even on exact halves and nearest otherwise (property)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }), fc.bigInt({ min: 1n, max: 10n ** 9n }), (p, q) => {
        expect(Surd.of(p, q).round()).toBe(roundHalfEvenRational(p, q));
      }),
      { numRuns: 1000, seed: 7 },
    );
  });
});
