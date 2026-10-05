import { formatLength, parseLength } from '@floorspec/ops';
import type { FloorspecDocument } from '@floorspec/engine';

/**
 * Lengths as a person reads and types them (FLR-T-3.4). Every typed value is parsed by the Ops
 * reference grammar itself (`parseLength`, Ops 3.1) — `12'6-1/2"`, `6 1/2"`, `3810mm`, `3.81 m` —
 * so a length means exactly what it would mean in a batch sent by an agent. Display goes through
 * `formatLength`, rounded ties-to-even, and every string shown here parses back.
 *
 * The display system is a per-project preference held in the document's `extras` (Core 1.7) at
 * `/extras/d3floorspec/units`: display data, edited with `setProperty $document` like any change.
 */

export type UnitSystem = 'imperial' | 'metric';

/** Where the preference lives, as a JSON Pointer relative to `$document`. */
export const UNITS_PATH = '/extras/d3floorspec/units';

/** Base units per inch, foot and millimetre (Core 2.1). */
export const BASE_PER_INCH = 32_512;
export const BASE_PER_FOOT = 390_144;
export const BASE_PER_MM = 1280;

export function unitsOf(document: FloorspecDocument | null | undefined): UnitSystem {
  const extras = document?.extras as Record<string, unknown> | undefined;
  const ours = extras?.['d3floorspec'] as Record<string, unknown> | undefined;
  return ours?.['units'] === 'metric' ? 'metric' : 'imperial';
}

/**
 * A length for display or for an input's value: `12'-6 1/2"` (architectural ft-in to 1/16") or
 * `3810 mm`. The ft-in form is formatLength's, with the conventional dash and a `0"` on whole feet;
 * both still parse with the grammar (`feet [ "-" ] inches`).
 */
export function formatLen(value: number | bigint, system: UnitSystem): string {
  if (system === 'metric') {
    const v = BigInt(value);
    // Whole millimetres unless the value is not one: then exact.
    return v % 1280n === 0n ? formatLength(v, { system: 'metric', unit: 'mm' }) : formatLength(v, { system: 'metric', unit: 'mm', decimals: 1 });
  }
  const text = formatLength(value, { denominator: 16 });
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const m = /^(\d+)'(?: (.+"))?$/.exec(body);
  if (m === null) return text; // inches only: 6 1/2"
  const inches = m[2] === undefined ? '0"' : /^\d+\/\d+"$/.test(m[2]) ? `0 ${m[2]}` : m[2];
  const out = `${m[1]}'-${inches}`;
  return negative ? `-${out}` : out;
}

const GLYPHS: Record<string, string> = {
  '1/2': '½', '1/4': '¼', '3/4': '¾', '1/8': '⅛', '3/8': '⅜', '5/8': '⅝', '7/8': '⅞',
};

/** The same, with fraction glyphs — for labels that are read, never for inputs that are edited. */
export function prettyLen(value: number | bigint, system: UnitSystem): string {
  const text = formatLen(value, system);
  return text.replace(/(\d+) (\d+\/\d+)"/, (_, whole: string, frac: string) => `${whole} ${GLYPHS[frac] ?? frac}"`).replace(/^(\d+\/\d+)"/, (_, frac: string) => `${GLYPHS[frac] ?? frac}"`);
}

export type LengthInput = { ok: true; value: number } | { ok: false; reason: string };

/**
 * Parse what a person typed. The grammar wants a unit; a bare number is read in the display
 * system's working unit — inches for ft-in, millimetres for metric — the way a drafting tool does.
 */
export function parseLen(text: string, system: UnitSystem): LengthInput {
  const withUnit = lengthText(text, system);
  if (withUnit === '') return { ok: false, reason: 'Type a length' };
  const parsed = parseLength(withUnit);
  if (!parsed.ok) return { ok: false, reason: `Not a length: ${parsed.reason}` };
  if (parsed.value > BigInt(Number.MAX_SAFE_INTEGER) || parsed.value < -BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'That length is too large' };
  return { ok: true, value: Number(parsed.value) };
}

/** What was typed, as a string of the grammar: a bare number gains the working unit. */
export function lengthText(text: string, system: UnitSystem): string {
  const trimmed = text.trim();
  return /^-?(\d+(\.\d+)?|\.\d+)$/.test(trimmed) ? `${trimmed}${system === 'metric' ? 'mm' : '"'}` : trimmed;
}

/** Area in square base units (twice, exact) as ft² or m², rounded for display. */
export function formatArea(area2: bigint, system: UnitSystem): string {
  if (system === 'metric') {
    // 1 m² = 1.28e6² base²; twice the area, so divide by 2 · 1.6384e12, to one decimal.
    const tenths = (area2 * 10n + 1_638_400_000_000n) / 3_276_800_000_000n;
    return `${(Number(tenths) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m²`;
  }
  const perSqft = BigInt(BASE_PER_FOOT) * BigInt(BASE_PER_FOOT);
  const whole = (area2 + perSqft) / (2n * perSqft);
  return `${Number(whole).toLocaleString('en-US')} ft²`;
}

/** The working grid step a drag or a click snaps to: ½" in ft-in, 10 mm in metric. */
export function gridStep(system: UnitSystem): number {
  return system === 'metric' ? 10 * BASE_PER_MM : BASE_PER_INCH / 2;
}

/** A label for the step, as the status bar shows it: `½"` or `10 mm`. */
export function gridStepLabel(system: UnitSystem): string {
  return system === 'metric' ? '10 mm' : '½"';
}

/** Twice a decimal half-string area ("123" or "123.5") as an exact BigInt (Core 6.4). */
export function twiceArea(area: string): bigint {
  const negative = area.startsWith('-');
  const [whole = '0', half] = (negative ? area.slice(1) : area).split('.');
  const value = BigInt(whole) * 2n + (half === '5' ? 1n : 0n);
  return negative ? -value : value;
}

export type PointInput = { ok: true; value: [number, number] } | { ok: false; reason: string };

/** A typed point, `x, y`, each a length in the grammar: `0, 0`, `12', 8'6"`, `3810mm, 0`. */
export function parsePoint(text: string, system: UnitSystem): PointInput {
  const parts = text.split(',');
  if (parts.length !== 2) return { ok: false, reason: 'Type a point as x, y' };
  const x = parseLen(parts[0] ?? '', system);
  if (!x.ok) return { ok: false, reason: `x: ${x.reason}` };
  const y = parseLen(parts[1] ?? '', system);
  if (!y.ok) return { ok: false, reason: `y: ${y.reason}` };
  return { ok: true, value: [x.value, y.value] };
}

export type SegmentInput =
  | { ok: true; kind: 'point'; point: [number, number] }
  | { ok: true; kind: 'length'; length: number; angle: number | null }
  | { ok: false; reason: string };

/**
 * What can be typed while drawing (FLR-T-3.7): a point `x, y` to go to, a length to go along the
 * current direction, or a length and an angle `12' < 90` (degrees counter-clockwise from east;
 * `@` works too).
 */
export function parseSegment(text: string, system: UnitSystem): SegmentInput {
  if (text.includes(',')) {
    const p = parsePoint(text, system);
    return p.ok ? { ok: true, kind: 'point', point: p.value } : p;
  }
  const m = /^(.*?)\s*[<@]\s*(-?\d+(?:\.\d+)?)\s*°?$/.exec(text.trim());
  const l = parseLen(m === null ? text : (m[1] ?? ''), system);
  if (!l.ok) return l;
  const angle = m === null ? null : ((Number(m[2]) % 360) + 360) % 360;
  return { ok: true, kind: 'length', length: l.value, angle };
}
