/**
 * 9.6: values as a person reads them, in the request's units, each rounded once from the exact
 * value with round() (ties to even).
 */
import { roundDiv } from './exact.js';
import type { Value } from './measures/measure.js';
import type { MeasureType, Op, Units } from './types.js';

/** Square base units in a square foot ((1280 · 304.8)²) and in a square metre (1,280,000²). */
const SQFT = 152212340736n;
const SQM = 1638400000000n;

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/** A length of v base units: sixteenths of an inch as `F' I a/b"`, or whole millimetres. */
export function displayLength(v: bigint, units: Units): string {
  if (units === 'metric') return `${roundDiv(v, 1280n)} mm`;
  const n = roundDiv(v, 2032n);
  const sign = n < 0n ? '-' : '';
  const m = n < 0n ? -n : n;
  const feet = m / 192n;
  const inches = (m % 192n) / 16n;
  const six = m % 16n;
  if (six === 0n) return `${sign}${feet}' ${inches}"`;
  const g = gcd(six, 16n);
  return `${sign}${feet}' ${inches} ${six / g}/${16n / g}"`;
}

/** An area given doubled (area2 = 2A): hundredths of a square foot, or of a square metre. */
export function displayArea(area2: bigint, units: Units): string {
  const n = roundDiv(100n * area2, 2n * (units === 'metric' ? SQM : SQFT));
  const sign = n < 0n ? '-' : '';
  const m = n < 0n ? -n : n;
  return `${sign}${m / 100n}.${(m % 100n).toString().padStart(2, '0')} ${units === 'metric' ? 'm²' : 'sq ft'}`;
}

export function displayValue(type: MeasureType, v: Value, units: Units, unit?: string): string {
  if (v === null) return 'not stated';
  switch (type) {
    case 'length':
      return displayLength(v as bigint, units);
    case 'area':
      return displayArea(v as bigint, units);
    case 'count':
    case 'integer':
      return unit === undefined ? `${v as bigint}` : `${v as bigint} ${unit}`;
    case 'boolean':
      return v ? 'yes' : 'no';
    case 'term':
      return v as string;
    case 'terms': {
      const ts = v as string[];
      return ts.length ? [...ts].sort().join(', ') : 'none';
    }
  }
}

/** A threshold as a value of the measure's type: each of `in`'s values; `has`'s term itself. */
export function displayThreshold(type: MeasureType, op: Op, t: unknown, units: Units, unit?: string): string {
  // A numeric threshold is an integer; an area threshold is square base units, so doubled here.
  const asValue = (x: unknown): Value => (typeof x === 'number' ? (type === 'area' ? 2n * BigInt(x) : BigInt(x)) : (x as Value));
  if (op === 'in') return (t as unknown[]).map((x) => displayValue(type, asValue(x), units, unit)).join(', ');
  if (op === 'has') return t as string;
  return displayValue(type, asValue(t), units, unit);
}
