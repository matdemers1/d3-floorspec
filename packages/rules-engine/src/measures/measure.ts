/**
 * What every measure shares (Rules 4): its targets, arguments, type, what it reads (4.6), whether
 * its result names what it found (4.7), and its exact value.
 *
 * Values are kept exact and typed by the measure's type: a length, count or integer is a BigInt; an
 * area is a BigInt holding **twice** the area, so a half is exact (4.2); a boolean, a term and a
 * sorted list of terms are themselves; `null` is no value (only `elementMember` has none).
 */
import type { Model } from '../model.js';
import type { MeasureType, Target, TargetKind } from '../types.js';

export type Value = bigint | boolean | string | string[] | null;

export interface Computed {
  readonly value: Value;
  /** For a measure whose result has `involved`: the IDs it found (sorted when reported). */
  readonly involved?: readonly string[];
}

export type Args = Readonly<Record<string, unknown>>;
export type ArgCheck = (v: unknown) => boolean;

export interface Measure {
  readonly name: string;
  readonly kinds: readonly TargetKind[];
  /** The type; null when the arguments fix it (`elementMember`, 7.1). */
  readonly type: MeasureType | null;
  readonly args: Readonly<Record<string, ArgCheck>>;
  readonly required: readonly string[];
  /** A check across arguments, after each passed its own. */
  readonly check?: (args: Args) => boolean;
  /** 4.6: the extensions a use with these arguments reads. */
  readonly reads: (args: Args) => readonly string[];
  /** Whether its result lists `involved` (4.7). */
  readonly involved: boolean;
  readonly compute: (model: Model, target: Target, args: Args) => Computed;
}

/** A measure, with the defaults most share: no arguments, reads nothing, names nothing. */
export function measure(m: Partial<Measure> & Pick<Measure, 'name' | 'kinds' | 'type' | 'compute'>): Measure {
  return { args: {}, required: [], reads: () => [], involved: false, ...m };
}

export function typeOf(m: Measure, args: Args): MeasureType {
  return m.type ?? (args.type as MeasureType);
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 3.9: are `args` exactly arguments the measure takes, each of its type, with every required one? */
export function argsOk(m: Measure, args: unknown): boolean {
  if (!isPlain(args)) return false;
  for (const k of m.required) if (!Object.hasOwn(args, k)) return false;
  for (const [k, v] of Object.entries(args)) {
    const ok = Object.hasOwn(m.args, k) ? m.args[k] : undefined;
    if (ok === undefined || !ok(v)) return false;
  }
  return m.check === undefined || m.check(args);
}

// ── argument types ─────────────────────────────────────────────────────────────

export const MAX = Number.MAX_SAFE_INTEGER;
export const EXTENSION_NAME = /^(FS|EXT|[A-Z0-9]{2,8})_[A-Za-z0-9]+$/;
export const MEMBER_NAME = /^[a-z][A-Za-z0-9]*$/;
const EXTENSION_TERM = /^(FS|EXT|[A-Z0-9]{2,8})_[A-Za-z0-9]+:[a-z][A-Za-z0-9]*$/;

/** Core 4.1: the room functions. */
export const CORE_FUNCTIONS = [
  'unspecified',
  'sleeping',
  'bath',
  'kitchen',
  'living',
  'dining',
  'office',
  'laundry',
  'utility',
  'storage',
  'circulation',
  'mechanical',
  'garage',
  'exterior',
] as const;

/** Core 13.5: the purposes of a clearance envelope. */
export const PURPOSES = ['workingSpace', 'fixtureClearance', 'swing', 'access'] as const;

export const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** A room function: a term of Core 4.1, or an extension term (Core 4.2). */
export const aFunction: ArgCheck = (v) => isStr(v) && ((CORE_FUNCTIONS as readonly string[]).includes(v) || EXTENSION_TERM.test(v));
export const aExtension: ArgCheck = (v) => isStr(v) && EXTENSION_NAME.test(v);
export const aCollection: ArgCheck = (v) => isStr(v) && MEMBER_NAME.test(v);
export const aLength: ArgCheck = (v) => isInt(v);
export const aPositive: ArgCheck = (v) => isInt(v) && v > 0;
export const anEnum =
  (...values: string[]): ArgCheck =>
  (v) =>
    isStr(v) && values.includes(v);
/** 4.5: a match — member names to strings, integers or booleans, at least one. */
export const aMatch: ArgCheck = (v) =>
  isPlain(v) && Object.keys(v).length >= 1 && Object.entries(v).every(([k, x]) => MEMBER_NAME.test(k) && (isStr(x) || typeof x === 'boolean' || isInt(x)));
