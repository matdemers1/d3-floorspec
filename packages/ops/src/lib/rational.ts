/** Exact rationals on BigInt: what a length string means before it is rounded once (3.1). */
import { gcd, roundHalfEvenRational } from '@floorspec/engine';

export interface Rational {
  /** Numerator. */
  readonly n: bigint;
  /** Denominator, > 0. */
  readonly d: bigint;
}

export function q(n: bigint, d = 1n): Rational {
  if (d === 0n) throw new RangeError('rational with a zero denominator');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return g > 1n ? { n: n / g, d: d / g } : { n, d };
}

export const qadd = (a: Rational, b: Rational): Rational => q(a.n * b.d + b.n * a.d, a.d * b.d);
export const qsub = (a: Rational, b: Rational): Rational => q(a.n * b.d - b.n * a.d, a.d * b.d);
export const qmul = (a: Rational, b: Rational): Rational => q(a.n * b.n, a.d * b.d);
export const qneg = (a: Rational): Rational => ({ n: -a.n, d: a.d });
export const qround = (a: Rational): bigint => roundHalfEvenRational(a.n, a.d);
export const qIsInteger = (a: Rational): boolean => a.d === 1n;

/** A decimal string `12`, `3.81` or `.5` as an exact rational. */
export function qDecimal(s: string): Rational {
  const [whole = '', frac = ''] = s.split('.');
  const digits = `${whole}${frac}` || '0';
  return q(BigInt(digits), 10n ** BigInt(frac.length));
}

/** A rational as a decimal string when it terminates, else `n/d`. For messages and echoes, never for decisions. */
export function qString(a: Rational): string {
  if (a.d === 1n) return a.n.toString();
  let d = a.d;
  let twos = 0n;
  let fives = 0n;
  while (d % 2n === 0n) {
    d /= 2n;
    twos++;
  }
  while (d % 5n === 0n) {
    d /= 5n;
    fives++;
  }
  if (d !== 1n) return `${a.n}/${a.d}`;
  const places = twos > fives ? twos : fives;
  const scaled = (a.n * 10n ** places) / a.d;
  const neg = scaled < 0n;
  const digits = (neg ? -scaled : scaled).toString().padStart(Number(places) + 1, '0');
  const cut = digits.length - Number(places);
  return `${neg ? '-' : ''}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}
