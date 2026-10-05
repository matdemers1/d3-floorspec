/**
 * Small hand-made Core 0.2 documents for the measure tests: one building, one level, walls of one
 * 100 mm core layer, centre-justified, so a rectangle of junctions 0..W × 0..H holds a room whose
 * polygon is 64,000..W − 64,000 × 64,000..H − 64,000 — every value checkable by hand.
 */
import { OFFICIAL_EXTENSIONS, check } from '@floorspec/engine';
import { callMeasures, type MeasureCall, type MeasureResult, type Target, type Units } from '../src/index.js';

export const MM = 1280;
export const IN = 32512;
export const FT = 12 * IN; // 390,144
export const T = 128000; // 100 mm walls
export const HALF = T / 2;

export type P = [number, number];
type J = Record<string, unknown>;

export interface Spec {
  junctions: Record<string, P>;
  walls: Record<string, [string, string] | J>;
  separators?: Record<string, [string, string]>;
  rooms?: Record<string, P | J>;
  openings?: Record<string, J>;
  types?: Record<string, J>;
  levels?: Record<string, J>;
  extensions?: Record<string, J>;
  extensionsUsed?: Record<string, string>;
}

export function doc(s: Spec): Record<string, unknown> {
  const junctions: J = {};
  for (const [id, p] of Object.entries(s.junctions)) junctions[id] = { level: 'L1', position: p };
  const walls: J = {};
  for (const [id, w] of Object.entries(s.walls)) walls[id] = Array.isArray(w) ? { level: 'L1', start: w[0], end: w[1], type: 'WT' } : { level: 'L1', type: 'WT', ...w };
  const rooms: J = {};
  for (const [id, r] of Object.entries(s.rooms ?? {})) rooms[id] = Array.isArray(r) ? { level: 'L1', anchor: r } : { level: 'L1', ...r };
  const separators: J = {};
  for (const [id, [a, b]] of Object.entries(s.separators ?? {})) separators[id] = { level: 'L1', start: a, end: b };
  return {
    floorspec: '0.2',
    project: { name: 'Rules engine test' },
    buildings: { B1: {} },
    levels: s.levels ?? { L1: { building: 'B1', elevation: 0, height: 3456000 } },
    types: {
      WT: { kind: 'wallType', layers: [{ thickness: T, function: 'core' }] },
      WIN: { kind: 'windowType', width: 3 * FT, height: 4 * FT, sill: 2 * FT },
      DOOR: { kind: 'doorType', width: 3 * FT, height: 7 * FT },
      ...s.types,
    },
    junctions,
    walls,
    ...(s.separators && { separators }),
    ...(s.rooms && { rooms }),
    ...(s.openings && { openings: s.openings }),
    ...(s.extensionsUsed && { extensionsUsed: s.extensionsUsed }),
    ...(s.extensions && { extensions: s.extensions }),
  };
}

/** A rectangle of four walls, J1 (0,0) → J2 (0,H) → J3 (W,H) → J4 (W,0), and one room R1 in it. */
export function box(W: number, H: number, extra: Partial<Spec> = {}): Spec {
  return {
    junctions: { J1: [0, 0], J2: [0, H], J3: [W, H], J4: [W, 0] },
    walls: { W1: ['J1', 'J2'], W2: ['J2', 'J3'], W3: ['J3', 'J4'], W4: ['J4', 'J1'] },
    rooms: { R1: [W / 2, H / 2] },
    ...extra,
  };
}

/** Two rooms in a row: R1 west of a shared wall W5 (J6 → J3), R2 east of it. */
export function row(W: number, H: number, extra: Partial<Spec> = {}): Spec {
  return {
    junctions: { J1: [0, 0], J2: [0, H], J3: [W, H], J4: [2 * W, H], J5: [2 * W, 0], J6: [W, 0] },
    walls: { W1: ['J1', 'J2'], W2: ['J2', 'J3'], W3: ['J3', 'J4'], W4: ['J4', 'J5'], W5: ['J5', 'J6'], W6: ['J6', 'J1'], W7: ['J6', 'J3'] },
    rooms: { R1: [W / 2, H / 2], R2: [W + W / 2, H / 2] },
    ...extra,
  };
}

/** An element of a test extension no validator knows: only its core members are read. */
export function thing(fallback: { level?: string; min: number[]; max: number[] }, host?: J, clearances?: J): J {
  return {
    fallback: { level: fallback.level ?? 'L1', box: { min: fallback.min, max: fallback.max } },
    ...(host && { host }),
    ...(clearances && { clearances }),
  };
}

export const free = (x: number, y: number, rotation?: number, level = 'L1'): J => ({ mode: 'free', level, position: [x, y], ...(rotation !== undefined && { rotation }) });

/** Assert the document is valid, then compute measure calls on it. */
export function measures(d: Record<string, unknown>, calls: MeasureCall[], options: { units?: Units; known?: boolean } = {}): MeasureResult[] {
  const known = options.known ?? true;
  const r = check(d, { extensions: ['FS_electrical', 'FS_plumbing', 'FS_mechanical', 'FS_lowvoltage'], ...(known && { knownExtensions: OFFICIAL_EXTENSIONS }) });
  if (!r.valid) throw new Error(`test document is not valid: ${r.diagnostics.filter((x) => x.severity === 'error').map((x) => `${x.code} ${x.message}`).join('; ')}`);
  return callMeasures(d, { ...(options.units && { units: options.units }), calls }, known ? { knownExtensions: OFFICIAL_EXTENSIONS } : {}).results;
}

/** One measure on one target. */
export function one(d: Record<string, unknown>, target: Target, measure: string, args?: Record<string, unknown>, options?: { units?: Units; known?: boolean }): MeasureResult {
  return measures(d, [{ target, measure, ...(args && { args }) }], options)[0]!;
}

export const room = (id: string): Target => ({ kind: 'room', id });
export const opening = (id: string): Target => ({ kind: 'opening', id });
export const element = (id: string): Target => ({ kind: 'element', id });
export const level = (id: string): Target => ({ kind: 'level', id });
export const envelope = (id: string, name: string): Target => ({ kind: 'envelope', id, envelope: name });
