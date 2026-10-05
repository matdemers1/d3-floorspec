/**
 * What the user tells the estimate, kept in the document's `extras` (Core 1.7) at
 * `/extras/d3floorspec/energy` — beside the display units at `/extras/d3floorspec/units` — and
 * changed like everything else, with `setProperty $document` (Ops 2.3): undoable, in the op log and
 * the history, carried by a .floorspec package, and read by the editor, the server and MCP from the
 * same version. Core says nothing derived may depend on `extras` (1.7.1), and nothing does: the
 * estimate is not a value Core derives.
 *
 * Every number is SI: °C, °C·days, W/(m²·K), W/(m·K) for a slab edge. The screen converts.
 */
import { CLIMATE_PRESETS } from './climate.js';

/** Where the inputs live in a document. */
export const ENERGY_PATH = '/extras/d3floorspec/energy';

/** An assembly the user set a value for: U (or a slab edge's F), and a window's SHGC. */
export interface AssemblyInput {
  readonly u?: number;
  readonly shgc?: number;
}

export interface EnergyInputs {
  /** A climate-zone preset (climate.ts). */
  readonly zone?: string;
  /** °C, overriding the preset's. */
  readonly heatingDesign?: number;
  readonly coolingDesign?: number;
  /** °C·days, 18.3 °C base. */
  readonly hdd?: number;
  readonly cdd?: number;
  readonly indoorWinter?: number;
  readonly indoorSummer?: number;
  /** Air changes an hour, natural. */
  readonly ach?: number;
  /** By assembly key: `wall:<type ID>` (`wall:` for walls with no type), `ceiling`, `slab`, `window`, `door`. */
  readonly assemblies?: Readonly<Record<string, AssemblyInput>>;
}

/** The limits each number must be within: wide, but enough to refuse a typo of the wrong unit. */
export const LIMITS = {
  heatingDesign: [-60, 30],
  coolingDesign: [0, 55],
  hdd: [0, 12_000],
  cdd: [0, 4_000],
  indoorWinter: [10, 30],
  indoorSummer: [15, 35],
  ach: [0.05, 5],
  u: [0.05, 10],
  shgc: [0.05, 0.95],
} as const satisfies Record<string, readonly [number, number]>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

/** A problem with stored inputs: the member, in words. */
export interface InputProblem {
  readonly path: string;
  readonly message: string;
}

/**
 * Read inputs from any JSON value — a request body, or what a document's `extras` hold, which any
 * writer could have put there — keeping what is valid and saying what is not.
 */
export function parseInputs(raw: unknown): { inputs: EnergyInputs; problems: InputProblem[] } {
  const problems: InputProblem[] = [];
  if (raw === undefined || raw === null) return { inputs: {}, problems };
  if (!isObject(raw)) return { inputs: {}, problems: [{ path: '', message: 'the energy inputs are an object' }] };
  const out: Record<string, unknown> = {};
  const zone = own(raw, 'zone');
  if (zone !== undefined) {
    if (typeof zone === 'string' && CLIMATE_PRESETS.some((p) => p.zone === zone)) out['zone'] = zone;
    else problems.push({ path: '/zone', message: `zone is one of ${CLIMATE_PRESETS.map((p) => p.zone).join(', ')}` });
  }
  const num = (key: keyof typeof LIMITS, from: Record<string, unknown>, path: string, into: Record<string, unknown>): void => {
    const v = own(from, key);
    if (v === undefined) return;
    const [lo, hi] = LIMITS[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) into[key] = v;
    else problems.push({ path: `${path}/${key}`, message: `${key} is a number from ${String(lo)} to ${String(hi)}` });
  };
  for (const k of ['heatingDesign', 'coolingDesign', 'hdd', 'cdd', 'indoorWinter', 'indoorSummer', 'ach'] as const) num(k, raw, '', out);
  const asm = own(raw, 'assemblies');
  if (asm !== undefined) {
    if (!isObject(asm)) problems.push({ path: '/assemblies', message: 'assemblies is an object of assembly → { u, shgc }' });
    else {
      const a: Record<string, AssemblyInput> = {};
      for (const key of Object.keys(asm).sort()) {
        const v = asm[key];
        if (!/^(wall:[^/]{0,200}|ceiling|slab|window|door)$/.test(key) || !isObject(v)) {
          problems.push({ path: `/assemblies/${key}`, message: 'an assembly is wall:<type>, ceiling, slab, window or door, with { u, shgc }' });
          continue;
        }
        const one: Record<string, unknown> = {};
        num('u', v, `/assemblies/${key}`, one);
        if (key === 'window') num('shgc', v, `/assemblies/${key}`, one);
        if (Object.keys(one).length) Object.defineProperty(a, key, { value: one, enumerable: true, writable: true, configurable: true });
      }
      if (Object.keys(a).length) out['assemblies'] = a;
    }
  }
  return { inputs: out, problems };
}

/** The inputs a document holds (`/extras/d3floorspec/energy`), and what was wrong with them. */
export function inputsOf(document: unknown): { inputs: EnergyInputs; problems: InputProblem[] } {
  const extras = isObject(document) ? own(document, 'extras') : undefined;
  const ours = isObject(extras) ? own(extras, 'd3floorspec') : undefined;
  return parseInputs(isObject(ours) ? own(ours, 'energy') : undefined);
}
