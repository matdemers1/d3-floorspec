/** Builders for test documents and helpers for reading results. */
import { expect } from 'vitest';
import { apply, type ApplyResult, type CommittedResult, type Operation } from '../src/index.js';

export type P = [number, number];

export const IN = 32512;
export const FT = 390144;
export const MM = 1280;

export interface DocSpec {
  junctions: Record<string, P | { position: P; join?: unknown; level?: string }>;
  walls?: Record<string, { start: string; end: string; t?: number; [k: string]: unknown }>;
  separators?: Record<string, { start: string; end: string; level?: string }>;
  rooms?: Record<string, P | Record<string, unknown>>;
  openings?: Record<string, Record<string, unknown>>;
  types?: Record<string, Record<string, unknown>>;
  materials?: Record<string, Record<string, unknown>>;
  extra?: Record<string, unknown>;
}

export function doc(spec: DocSpec): Record<string, unknown> {
  const junctions: Record<string, unknown> = {};
  for (const [id, j] of Object.entries(spec.junctions)) {
    if (Array.isArray(j)) junctions[id] = { level: 'L1', position: j };
    else junctions[id] = { level: j.level ?? 'L1', position: j.position, ...(j.join !== undefined && { join: j.join }) };
  }
  const walls: Record<string, unknown> = {};
  for (const [id, w] of Object.entries(spec.walls ?? {})) {
    const { t, ...rest } = w;
    walls[id] = { level: 'L1', ...(rest.type === undefined && rest.layers === undefined && { layers: [{ thickness: t ?? 12800, function: 'core' }] }), ...rest };
  }
  const separators: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(spec.separators ?? {})) separators[id] = { level: 'L1', ...s };
  const rooms: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(spec.rooms ?? {})) rooms[id] = Array.isArray(r) ? { level: 'L1', anchor: r } : { level: 'L1', ...r };
  return {
    floorspec: '0.1',
    project: { name: 'Test' },
    buildings: { B1: {} },
    levels: { L1: { building: 'B1', elevation: 0, height: 3200000 } },
    junctions,
    walls,
    ...(spec.separators && { separators }),
    ...(spec.rooms && { rooms }),
    ...(spec.openings && { openings: spec.openings }),
    ...(spec.types && { types: spec.types }),
    ...(spec.materials && { materials: spec.materials }),
    ...spec.extra,
  };
}

export const W = 3900000; // a 4 m box would do; this is about 12' 9 1/2"
export const H = 2800000;

/** A box of four walls drawn clockwise (exterior out) from (0,0) to (w,h), with room R1 inside. */
export function box(w = W, h = H, extra: Partial<DocSpec> = {}): Record<string, unknown> {
  return doc({
    junctions: { J1: [0, 0], J2: [0, h], J3: [w, h], J4: [w, 0] },
    walls: {
      W1: { start: 'J1', end: 'J2' },
      W2: { start: 'J2', end: 'J3' },
      W3: { start: 'J3', end: 'J4' },
      W4: { start: 'J4', end: 'J1' },
    },
    rooms: { R1: { anchor: [Math.floor(w / 2), Math.floor(h / 2)], name: 'Kitchen' } },
    ...extra,
  });
}

/**
 * Two rooms side by side, A (west, "Kitchen") and B (east, "Dining"), sharing the wall W7 from B0
 * to T; the north and south lines continue across W7.
 *
 *    J2 ──W2── T ──W3── J3
 *    │         │        │
 *    W1   A   W7   B    W4
 *    │         │        │
 *    J1 ──W6── B0 ──W5── J4
 */
export function pair(w = W, h = H, extra: Partial<DocSpec> = {}): Record<string, unknown> {
  return doc({
    junctions: { J1: [0, 0], J2: [0, h], T: [w, h], J3: [2 * w, h], J4: [2 * w, 0], B0: [w, 0] },
    walls: {
      W1: { start: 'J1', end: 'J2' },
      W2: { start: 'J2', end: 'T' },
      W3: { start: 'T', end: 'J3' },
      W4: { start: 'J3', end: 'J4' },
      W5: { start: 'J4', end: 'B0' },
      W6: { start: 'B0', end: 'J1' },
      W7: { start: 'B0', end: 'T', t: 10000 },
    },
    rooms: {
      RA: { anchor: [Math.floor(w / 2), Math.floor(h / 2)], name: 'Kitchen' },
      RB: { anchor: [Math.floor((3 * w) / 2), Math.floor(h / 2)], name: 'Dining' },
    },
    ...extra,
  });
}

export function committed(r: ApplyResult): CommittedResult {
  if (r.status !== 'committed') expect.fail(`expected a commit, got ${JSON.stringify(r.diagnostics, null, 1)}`);
  return r;
}

export function rejectedWith(r: ApplyResult, code: string, elements?: string[]): void {
  if (r.status !== 'rejected') expect.fail(`expected ${code}, got a commit`);
  expect(r.diagnostics.map((d) => d.code)).toContain(code);
  if (elements) expect(r.diagnostics.find((d) => d.code === code)!.elements).toEqual(elements);
}

/** The committed document B, parsed. */
export const B = (r: ApplyResult): Record<string, Record<string, Record<string, unknown>>> => JSON.parse(committed(r).document) as never;

export const run = (d: object, ...batch: unknown[]): ApplyResult => apply(d, { batch: batch as Operation[] });

export const pos = (b: ReturnType<typeof B>, j: string): unknown => b.junctions![j]!.position;
