/**
 * Fixed formatting for drawing coordinates and labels. Every number that reaches the SVG goes
 * through `num`, so identical input gives identical bytes in every JavaScript engine.
 *
 * The ft-in formatter here is deliberately tiny: `@floorspec/ops` will own the canonical one.
 */

/** Base units per inch and per foot (Core 2.1). */
export const BU_PER_INCH = 32512;
export const BU_PER_FOOT = 390144;
/** Square base units per square foot (Core 6.4). */
export const SQ_BU_PER_SQ_FT = 152212340736n;

/** A drawing coordinate: two decimals, trailing zeros trimmed, never `-0`. */
export function num(n: number): string {
  const r = Math.round(n * 100) / 100;
  if (r === 0 || Object.is(r, -0)) return '0';
  let s = r.toFixed(2);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** Round p/q to the nearest integer, ties to even (q > 0). */
function roundHalfEven(p: bigint, q: bigint): bigint {
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

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Inches and sixteenths, as `7-3/16"` or `6"`; `sixteenths` is non-negative. */
function inchText(sixteenths: number): string {
  const whole = Math.floor(sixteenths / 16);
  const frac = sixteenths % 16;
  if (frac === 0) return `${whole}"`;
  const g = gcd(frac, 16);
  const f = `${frac / g}/${16 / g}`;
  return whole === 0 ? `${f}"` : `${whole}-${f}"`;
}

/** A length in base units as feet and inches to the nearest 1/16 inch: `12' 6"`, `0' 7-3/16"`. */
export function feetInches(baseUnits: number): string {
  const neg = baseUnits < 0;
  const s = Number(roundHalfEven(BigInt(Math.abs(Math.round(baseUnits))), 2032n));
  const feet = Math.floor(s / 192);
  const text = `${feet}' ${inchText(s % 192)}`;
  return neg && s !== 0 ? `-${text}` : text;
}

/** A length in base units as inches to the nearest 1/16 inch: `7-3/16"`. */
export function inches(baseUnits: number): string {
  return inchText(Number(roundHalfEven(BigInt(Math.abs(Math.round(baseUnits))), 2032n)));
}

/** A derived net area (a decimal string of square base units, `N` or `N.5`) in ft², one decimal. */
export function squareFeet(area: string): string {
  const neg = area.startsWith('-');
  const body = neg ? area.slice(1) : area;
  const half = body.endsWith('.5');
  const twice = BigInt(half ? body.slice(0, -2) : body) * 2n + (half ? 1n : 0n);
  const tenths = roundHalfEven(twice * 10n, 2n * SQ_BU_PER_SQ_FT);
  const t = neg ? -tenths : tenths;
  const a = t < 0n ? -t : t;
  return `${t < 0n ? '-' : ''}${a / 10n}.${a % 10n}`;
}
