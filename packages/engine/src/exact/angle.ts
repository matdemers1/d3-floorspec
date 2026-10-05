/**
 * The two transcendental values of Core 0.2 (13.1): the facing vector of an angle,
 *
 *     F(θ) = ( round(10⁹ · cos θ), round(10⁹ · sin θ) ),   θ in microdegrees,
 *
 * and the direction of a vector of integers — its angle from +X in microdegrees, rounded, in
 * (−180,000,000, 180,000,000].
 *
 * Neither can be a tie (13.1, Niven's theorem), so each is decided by evaluating the function in
 * BigInt fixed point to far more bits than needed (PREC, ~96 decimal digits, with an error bound
 * of a few hundred units of 2^−PREC) and checking that the result is not within 2^−(PREC − 100) of
 * a rounding boundary. That check is an assertion: it never fails for a value 13.1 says cannot tie,
 * and if it ever did the engine would throw rather than guess. No float takes part.
 */
import { isqrt } from './bigint.js';

const PREC = 320n;
const ONE = 1n << PREC;
const HALF = ONE >> 1n;
/** How close to a rounding boundary a value may come before rounding refuses to decide. */
const MARGIN = 1n << (PREC - 100n);

const K = 1_000_000_000n;
const DEG90 = 90_000_000n;
const DEG180 = 180_000_000n;

/** atan(1/n) in fixed point, for an integer n ≥ 2 (Gregory's series). */
function atanInv(n: bigint): bigint {
  let sum = 0n;
  let term = ONE / n;
  const n2 = n * n;
  let k = 1n;
  let positive = true;
  while (term !== 0n) {
    sum += positive ? term / k : -(term / k);
    term /= n2;
    k += 2n;
    positive = !positive;
  }
  return sum;
}

let piCache: bigint | undefined;
/** π in fixed point, by Machin's formula π = 16·atan(1/5) − 4·atan(1/239). */
function pi(): bigint {
  piCache ??= 16n * atanInv(5n) - 4n * atanInv(239n);
  return piCache;
}

/** (sin x, cos x) in fixed point for a fixed-point x with |x| ≤ π/4 (Taylor series). */
function sinCos(x: bigint): [bigint, bigint] {
  let s = 0n;
  let c = 0n;
  let term = ONE; // x^n / n!
  for (let n = 0n; n < 4n || term !== 0n; n++) {
    switch (n % 4n) {
      case 0n:
        c += term;
        break;
      case 1n:
        s += term;
        break;
      case 2n:
        c -= term;
        break;
      default:
        s -= term;
    }
    term = (term * x) / ONE / (n + 1n);
  }
  return [s, c];
}

/** The nearest integer to a fixed-point value, refusing to decide one within MARGIN of a tie. */
function roundFar(v: bigint): bigint {
  const fl = v >> PREC; // floor, also for negative v
  const frac = v - (fl << PREC);
  const off = frac - HALF;
  if ((off < 0n ? -off : off) <= MARGIN) throw new Error('angle: a rounding tie that 13.1 says cannot occur');
  return off > 0n ? fl + 1n : fl;
}

/** 13.1: F(θ) for an angle θ in microdegrees. */
export function facingVector(theta: bigint | number): [bigint, bigint] {
  const t = ((BigInt(theta) % (4n * DEG90)) + 4n * DEG90) % (4n * DEG90); // [0, 360°)
  const q = t / DEG90; // quadrant
  let r = t - q * DEG90; // [0, 90°)
  // (cos r, sin r) for r in [0, 90°), from an argument in [0, 45°].
  const swap = r > DEG90 / 2n;
  if (swap) r = DEG90 - r;
  let c: bigint;
  let s: bigint;
  if (r === 0n) {
    [c, s] = [K, 0n];
  } else {
    const x = (r * pi()) / DEG180;
    const [sf, cf] = sinCos(x);
    [c, s] = [roundFar(cf * K), roundFar(sf * K)];
  }
  if (swap) [c, s] = [s, c];
  // Rotate by q quarter turns, exactly.
  switch (q) {
    case 0n:
      return [c, s];
    case 1n:
      return [-s, c];
    case 2n:
      return [-c, -s];
    default:
      return [s, -c];
  }
}

/** atan(t) in fixed point for a fixed-point t in (0, 1], by halving the argument three times. */
function atanFixed(t: bigint): bigint {
  let k = 0n;
  // atan(t) = 2·atan(t / (1 + √(1 + t²)))
  while (k < 3n) {
    const root = isqrt((ONE + (t * t) / ONE) << PREC);
    t = (t << PREC) / (ONE + root);
    k++;
  }
  let sum = 0n;
  const t2 = (t * t) / ONE;
  let term = t;
  let n = 1n;
  let positive = true;
  while (term !== 0n) {
    sum += positive ? term / n : -(term / n);
    term = (term * t2) / ONE;
    n += 2n;
    positive = !positive;
  }
  return sum << k;
}

/** 13.1: the direction of a non-zero vector of integers, in microdegrees, in (−180°, 180°]. */
export function direction(x: bigint | number, y: bigint | number): number {
  const X = BigInt(x);
  const Y = BigInt(y);
  if (X === 0n && Y === 0n) throw new RangeError('direction: the zero vector has no direction');
  const sx = X > 0n ? 1 : X < 0n ? -1 : 0;
  const sy = Y > 0n ? 1 : Y < 0n ? -1 : 0;
  if (sy === 0) return sx > 0 ? 0 : 180_000_000;
  if (sx === 0) return sy > 0 ? 90_000_000 : -90_000_000;
  const ax = X < 0n ? -X : X;
  const ay = Y < 0n ? -Y : Y;
  if (ax === ay) return sx > 0 ? (sy > 0 ? 45_000_000 : -45_000_000) : sy > 0 ? 135_000_000 : -135_000_000;
  const P = pi();
  // The angle of (|x|, |y|), in (0, π/2) and not π/4.
  const base = ay < ax ? atanFixed((ay << PREC) / ax) : P / 2n - atanFixed((ax << PREC) / ay);
  let a: bigint;
  if (sx > 0) a = sy > 0 ? base : -base;
  else a = sy > 0 ? P - base : base - P;
  const r = roundFar(((a * DEG180) << PREC) / P);
  return Number(r === -DEG180 ? DEG180 : r);
}
