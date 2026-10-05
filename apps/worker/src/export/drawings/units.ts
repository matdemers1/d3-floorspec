/**
 * Lengths and areas as a drawing prints them (FLR-T-9.3). Every printed value comes from integer
 * base units (1/1280 mm, FLR-ADR-004) and is rounded exactly once: imperial through the Ops
 * reference formatter (`formatLength`, to 1/16") in the architectural form `12'-6 1/2"`, metric
 * as whole millimetres, ties to even. Areas are exact BigInt arithmetic on the engine's derived
 * net area (a decimal string of square base units, `N` or `N.5`).
 */
import { formatLength } from '@floorspec/ops';

export type UnitSystem = 'imperial' | 'metric';

export const BU_PER_INCH = 32_512;
export const BU_PER_FOOT = 390_144;
export const BU_PER_MM = 1280;

/** The display system a project chose in the editor (`/extras/d3floorspec/units`); imperial by default. */
export function unitsOf(document: unknown): UnitSystem {
  const extras = (document as { extras?: { d3floorspec?: { units?: unknown } } } | null)?.extras;
  return extras?.d3floorspec?.units === 'metric' ? 'metric' : 'imperial';
}

/** p/q rounded to the nearest integer, ties to even (q > 0). */
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

/**
 * A length as a dimension string: `12'-6 1/2"`, `0'-3/4"` → `3/4"`, `8'-0"`; or `3810` (mm, the
 * metric drawing convention: millimetres without a unit). Non-negative input is the normal case;
 * a negative length keeps its sign.
 */
export function lengthText(value: number | bigint, system: UnitSystem): string {
  const v = BigInt(value);
  if (system === 'metric') return roundHalfEven(v, BigInt(BU_PER_MM)).toString();
  const text = formatLength(v, { denominator: 16 });
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const m = /^(\d+)'(?: (.+"))?$/.exec(body);
  if (m === null) return text; // under a foot: 6 1/2", 3/4"
  const inches = m[2] === undefined ? '0"' : /^\d+\/\d+"$/.test(m[2]) ? `0 ${m[2]}` : m[2];
  const out = `${m[1] ?? '0'}'-${inches}`;
  return negative ? `-${out}` : out;
}

/** Square base units per square foot and per square metre. */
const SQ_BU_PER_SQ_FT = BigInt(BU_PER_FOOT) * BigInt(BU_PER_FOOT);
const SQ_BU_PER_SQ_M = 1_280_000n * 1_280_000n;

/** Twice a derived net area (`N` or `N.5` square base units), exactly. */
export function twiceArea(area: string): bigint {
  const negative = area.startsWith('-');
  const [whole = '0', half] = (negative ? area.slice(1) : area).split('.');
  const value = BigInt(whole) * 2n + (half === '5' ? 1n : 0n);
  return negative ? -value : value;
}

/** A derived net area as `168 SF` (whole square feet) or `15.6 m²` (tenths), rounded once, ties to even. */
export function areaText(area: string, system: UnitSystem): string {
  const twice = twiceArea(area);
  if (system === 'metric') {
    const tenths = roundHalfEven(twice * 10n, 2n * SQ_BU_PER_SQ_M);
    const a = tenths < 0n ? -tenths : tenths;
    return `${tenths < 0n ? '-' : ''}${(a / 10n).toString()}.${(a % 10n).toString()} m²`;
  }
  return `${roundHalfEven(twice, 2n * SQ_BU_PER_SQ_FT).toString()} SF`;
}

/** A plotted scale: its paper-to-model ratio and how a title block names it. */
export interface DrawingScale {
  /** Model length per paper length: 48 for 1/4" = 1'-0", 50 for 1:50. */
  readonly ratio: number;
  readonly label: string;
}

/** The architectural scales a plan may be plotted at, largest first. */
export const IMPERIAL_SCALES: readonly DrawingScale[] = [
  { ratio: 48, label: '1/4" = 1\'-0"' },
  { ratio: 64, label: '3/16" = 1\'-0"' },
  { ratio: 96, label: '1/8" = 1\'-0"' },
  { ratio: 128, label: '3/32" = 1\'-0"' },
  { ratio: 192, label: '1/16" = 1\'-0"' },
  { ratio: 384, label: '1/32" = 1\'-0"' },
];

export const METRIC_SCALES: readonly DrawingScale[] = [
  { ratio: 50, label: '1:50' },
  { ratio: 75, label: '1:75' },
  { ratio: 100, label: '1:100' },
  { ratio: 200, label: '1:200' },
  { ratio: 500, label: '1:500' },
];
