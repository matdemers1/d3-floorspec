/** Decimal display of exact rationals. */
import { q, qround, qString, type Rational } from '../lib/rational.js';

/**
 * A rational as a decimal: exactly when `decimals` is undefined (it must terminate), otherwise
 * rounded to that many places, ties to even, with trailing zeros kept.
 */
export function formatScaled(r: Rational, decimals?: number): string {
  if (decimals === undefined) return qString(r);
  if (!Number.isSafeInteger(decimals) || decimals < 0) throw new RangeError('decimals must be a non-negative integer');
  const scale = 10n ** BigInt(decimals);
  const n = qround(q(r.n * scale, r.d));
  if (decimals === 0) return n.toString();
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(decimals + 1, '0');
  const cut = digits.length - decimals;
  return `${neg ? '-' : ''}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}
