/**
 * Lengths and areas for people and agents: feet and inches to 1/16 inch, with the exact base units
 * beside them. A tiny formatter on purpose — `@floorspec/ops` will own the canonical one.
 */

export const BU_PER_FOOT = 390144n;
/** Square base units per square foot (Core 6.4). */
export const SQ_BU_PER_SQ_FT = 152212340736n;

/** Round p/q to the nearest integer, ties to even (q > 0). */
export function roundHalfEven(p: bigint, q: bigint): bigint {
  let f = p / q;
  let r = p % q;
  if (r < 0n) {
    f -= 1n;
    r += q;
  }
  const twice = 2n * r;
  if (twice > q || (twice === q && f % 2n !== 0n)) f += 1n;
  return f;
}

/** The integer square root: the largest r with r² ≤ n. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of a negative number');
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

function inchText(sixteenths: bigint): string {
  const whole = sixteenths / 16n;
  const frac = sixteenths % 16n;
  if (frac === 0n) return `${whole}"`;
  const g = gcd(frac, 16n);
  const f = `${frac / g}/${16n / g}`;
  return whole === 0n ? `${f}"` : `${whole}-${f}"`;
}

/** Base units as feet and inches to the nearest 1/16 inch: `12' 6"`, `0' 7-3/16"`. */
export function feetInches(baseUnits: bigint | number): string {
  const v = BigInt(baseUnits);
  const s = roundHalfEven(v < 0n ? -v : v, 2032n);
  const text = `${s / 192n}' ${inchText(s % 192n)}`;
  return v < 0n && s !== 0n ? `-${text}` : text;
}

/** Base units as inches to the nearest 1/16 inch: `7-3/16"`. */
export function inches(baseUnits: bigint | number): string {
  const v = BigInt(baseUnits);
  return inchText(roundHalfEven(v < 0n ? -v : v, 2032n));
}

/** Twice an area in square base units, as ft² with one decimal. */
export function squareFeet(area2: bigint): string {
  const t = roundHalfEven(area2 * 10n, 2n * SQ_BU_PER_SQ_FT);
  const a = t < 0n ? -t : t;
  return `${t < 0n ? '-' : ''}${a / 10n}.${a % 10n}`;
}

/** Twice an area, as the engine writes a net area: an integer, or an integer and `.5`. */
export function halfString(twice: bigint): string {
  const a = twice < 0n ? -twice : twice;
  return `${twice < 0n ? '-' : ''}${a / 2n}${a % 2n === 1n ? '.5' : ''}`;
}

/** A length as the summary reports it. */
export interface Length {
  /** Base units (1/1280 mm), rounded to the nearest unit when `exact` is false. */
  readonly baseUnits: number;
  /** Feet and inches to the nearest 1/16 inch. */
  readonly ftIn: string;
  /** False when the true length is irrational (an oblique wall) and `baseUnits` is rounded. */
  readonly exact: boolean;
}

export function length(baseUnits: bigint): Length {
  return { baseUnits: Number(baseUnits), ftIn: feetInches(baseUnits), exact: true };
}

/** The length of a segment with integer squared length m: exact when m is a perfect square. */
export function segmentLength(m: bigint): Length {
  const r = isqrt(m);
  if (r * r === m) return length(r);
  // No integer is equidistant from √m: (r + ½)² = r² + r + ¼ is never an integer.
  const nearest = m - r * r < (r + 1n) * (r + 1n) - m ? r : r + 1n;
  return { baseUnits: Number(nearest), ftIn: feetInches(nearest), exact: false };
}

/** `12' 6" (4876800)`, or `≈ 12' 6" (≈4876800)` when the length is irrational. */
export function lengthText(l: Length): string {
  return l.exact ? `${l.ftIn} (${l.baseUnits})` : `≈${l.ftIn} (≈${l.baseUnits})`;
}
