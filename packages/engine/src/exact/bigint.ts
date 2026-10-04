/**
 * Integer helpers on BigInt. Everything normative in the engine is computed with these: no float
 * ever decides a comparison or a rounding (FLR-ADR-004, 2.2).
 */

export function sign(a: bigint): -1 | 0 | 1 {
  return a > 0n ? 1 : a < 0n ? -1 : 0;
}

export function abs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

/** ⌊a / b⌋ for any non-zero b (BigInt `/` truncates towards zero). */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError('floorDiv: division by zero');
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

export function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** ⌊√n⌋ for n ≥ 0, by Newton's method on integers. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt: negative argument');
  if (n < 2n) return n;
  // An initial guess at or above the root: 2^⌈bits/2⌉.
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** Is n a perfect square? Returns its root when it is. */
export function exactSqrt(n: bigint): bigint | undefined {
  if (n < 0n) return undefined;
  const r = isqrt(n);
  return r * r === n ? r : undefined;
}

/** Round a rational p/q (q ≠ 0) to the nearest integer, ties to even (0.3, 2.2). */
export function roundHalfEvenRational(p: bigint, q: bigint): bigint {
  if (q < 0n) {
    p = -p;
    q = -q;
  }
  const f = floorDiv(p, q);
  const twiceRemainder = 2n * (p - f * q); // in [0, 2q)
  if (twiceRemainder < q) return f;
  if (twiceRemainder > q) return f + 1n;
  return f % 2n === 0n ? f : f + 1n;
}

/** A BigInt as a JS number, refusing anything that would not be exact. */
export function toSafeNumber(a: bigint): number {
  if (a > BigInt(Number.MAX_SAFE_INTEGER) || a < -BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError(`value ${a} is outside the exactly representable range`);
  return Number(a);
}

/** A JS number known to be a safe integer, as a BigInt. */
export function big(n: number): bigint {
  if (!Number.isSafeInteger(n)) throw new RangeError(`expected a safe integer, got ${n}`);
  return BigInt(n);
}
