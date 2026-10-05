import { contentHash, deriveFrom, evaluate, type Diagnostic } from '@floorspec/engine';
import { describeJson, type DocumentSummary, type EdgeSummary } from '@floorspec/mcp';
import { parseLength } from '@floorspec/ops';
import type { Doc } from './seeds.js';
import type { Interval, Length } from './types.js';

/**
 * A model measured once for scoring: every number the assertions read, taken from the reference
 * engine (its validator, its deriver and the room-centric summary built on its faces), never from
 * anything the agent said.
 */

export type Pt = readonly [number, number];

export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface MeasuredRoom {
  readonly id: string;
  readonly name: string;
  readonly function: string;
  readonly level: string;
  /** Absent when the room is not placed (its anchor is in no bounded face). */
  readonly box?: Box;
  /** Net area in square base units. */
  readonly area?: number;
}

export interface MeasuredOpening {
  readonly id: string;
  readonly wall: string;
  /** The level of its wall. */
  readonly level: string;
  readonly kind: 'door' | 'window' | 'opening';
  readonly fill?: string;
  readonly width: number;
  readonly start: Pt;
  readonly end: Pt;
  readonly mid: Pt;
}

export interface MeasuredWall {
  readonly id: string;
  readonly level: string;
  readonly start: Pt;
  readonly end: Pt;
  /** Rooms with a face on either side. */
  readonly rooms: ReadonlySet<string>;
  /** Whether one side is the exterior. */
  readonly exterior: boolean;
  /** The side of each room the wall is on, per Ops §3.4 (the summary's sides). */
  readonly sideOf: ReadonlyMap<string, 'north' | 'east' | 'south' | 'west'>;
  /** The midpoints of the finished faces (derived), for "centred on the face". */
  readonly faceMids: readonly Pt[];
}

export interface Measured {
  readonly document: Doc;
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly hash: string | null;
  readonly levels: ReadonlyMap<string, { readonly name?: string; readonly elevation: number; readonly height: number }>;
  readonly rooms: ReadonlyMap<string, MeasuredRoom>;
  readonly walls: ReadonlyMap<string, MeasuredWall>;
  readonly openings: ReadonlyMap<string, MeasuredOpening>;
  readonly summary: DocumentSummary;
}

/** 1/1280 mm per inch and per foot. */
export const INCH = 32512;
export const FOOT = 390144;
export const SIXTEENTH = 2032;

export function len(value: Length): number {
  if (typeof value === 'number') return value;
  const parsed = parseLength(value);
  if (!parsed.ok) throw new Error(`not a length: ${value} (${parsed.reason})`);
  return Number(parsed.value);
}

export function interval(value: Interval): readonly [number, number] {
  const a = len(value[0]);
  const b = len(value[1]);
  return a <= b ? [a, b] : [b, a];
}

/** A length for a person: feet-inches to the sixteenth. */
export function ftIn(units: number): string {
  const neg = units < 0;
  let s = Math.round(Math.abs(units) / SIXTEENTH);
  const feet = Math.floor(s / 192);
  s -= feet * 192;
  const inches = Math.floor(s / 16);
  const sixteenths = s - inches * 16;
  let frac = '';
  if (sixteenths > 0) {
    let n = sixteenths;
    let d = 16;
    while (n % 2 === 0) {
      n /= 2;
      d /= 2;
    }
    frac = ` ${String(n)}/${String(d)}`;
  }
  return `${neg ? '-' : ''}${String(feet)}' ${String(inches)}${frac}"`;
}

export const sqft = (area: number): number => area / (FOOT * FOOT);

function box(points: readonly (readonly [number, number])[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

function collection(doc: Doc, name: string): [string, Record<string, unknown>][] {
  const value = doc[name];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, Record<string, unknown>>);
}

export function measure(document: Doc): Measured {
  const ev = evaluate(document);
  const derived = ev.valid && ev.document !== undefined && ev.analysis !== undefined ? deriveFrom(ev.document, ev.analysis) : null;
  const summary = describeJson(document);
  const doc = document;

  const levels = new Map<string, { name?: string; elevation: number; height: number }>();
  for (const [id, l] of collection(doc, 'levels')) {
    levels.set(id, { ...(typeof l['name'] === 'string' ? { name: l['name'] } : {}), elevation: Number(l['elevation'] ?? 0), height: Number(l['height'] ?? 0) });
  }

  const rooms = new Map<string, MeasuredRoom>();
  for (const [id, r] of collection(doc, 'rooms')) {
    const poly = derived?.rooms[id];
    rooms.set(id, {
      id,
      name: typeof r['name'] === 'string' ? r['name'] : '',
      function: typeof r['function'] === 'string' ? r['function'] : '',
      level: String(r['level']),
      ...(poly === undefined ? {} : { box: box(poly.outer), area: Number(poly.area) }),
    });
  }

  // Which rooms each edge bounds, and on which side, from the summary (Ops §3.4 sides).
  const roomsOf = new Map<string, Set<string>>();
  const sideOf = new Map<string, Map<string, 'north' | 'east' | 'south' | 'west'>>();
  const exterior = new Set<string>();
  const note = (room: string, side: 'north' | 'east' | 'south' | 'west', e: EdgeSummary) => {
    const set = roomsOf.get(e.id) ?? new Set<string>();
    set.add(room);
    if (e.otherSide.kind === 'room') set.add(e.otherSide.id);
    roomsOf.set(e.id, set);
    if (e.otherSide.kind === 'exterior') exterior.add(e.id);
    const sides = sideOf.get(e.id) ?? new Map<string, 'north' | 'east' | 'south' | 'west'>();
    sides.set(room, side);
    sideOf.set(e.id, sides);
  };
  for (const level of summary.levels) {
    for (const room of level.rooms) {
      for (const side of ['north', 'east', 'south', 'west'] as const) for (const e of room.sides[side]) note(room.id, side, e);
    }
    for (const face of level.unanchored) for (const e of face.boundary) if (e.otherSide.kind === 'exterior') exterior.add(e.id);
  }

  const junctions = new Map<string, Pt>();
  for (const [id, j] of collection(doc, 'junctions')) {
    const p: unknown = j['position'];
    if (Array.isArray(p)) junctions.set(id, [Number(p[0]), Number(p[1])]);
  }

  const walls = new Map<string, MeasuredWall>();
  for (const [id, w] of collection(doc, 'walls')) {
    const start = junctions.get(String(w['start']));
    const end = junctions.get(String(w['end']));
    if (start === undefined || end === undefined) continue;
    const faces = derived?.walls[id];
    walls.set(id, {
      id,
      level: String(w['level']),
      start,
      end,
      rooms: roomsOf.get(id) ?? new Set(),
      exterior: exterior.has(id),
      sideOf: sideOf.get(id) ?? new Map(),
      faceMids: faces === undefined ? [] : [mid(faces.startLeft, faces.endLeft), mid(faces.startRight, faces.endRight)],
    });
  }

  const types = Object.fromEntries(collection(doc, 'types'));
  const openings = new Map<string, MeasuredOpening>();
  for (const [id, o] of collection(doc, 'openings')) {
    const fill = typeof o['fill'] === 'string' ? o['fill'] : undefined;
    const type = fill === undefined ? undefined : types[fill];
    const kind = type?.['kind'] === 'doorType' ? 'door' : type?.['kind'] === 'windowType' ? 'window' : 'opening';
    const width = Number(o['width'] ?? type?.['width'] ?? 0);
    const d = derived?.openings[id];
    let start: Pt;
    let end: Pt;
    if (d !== undefined) {
      start = d.start;
      end = d.end;
    } else {
      // Not derivable (an invalid model): place it from its wall's junctions, as a best effort.
      const w = walls.get(String(o['wall']));
      const off = Number(o['offset'] ?? 0);
      if (w === undefined) continue;
      const L = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]) || 1;
      const ux = (w.end[0] - w.start[0]) / L;
      const uy = (w.end[1] - w.start[1]) / L;
      start = [w.start[0] + ux * off, w.start[1] + uy * off];
      end = [w.start[0] + ux * (off + width), w.start[1] + uy * (off + width)];
    }
    const wallLevel = (doc['walls'] as Record<string, Record<string, unknown> | undefined> | undefined)?.[String(o['wall'])]?.['level'];
    const level = typeof wallLevel === 'string' ? wallLevel : '';
    openings.set(id, { id, wall: String(o['wall']), level, kind, ...(fill === undefined ? {} : { fill }), width, start, end, mid: mid(start, end) });
  }

  return {
    document,
    valid: ev.valid,
    diagnostics: ev.diagnostics,
    hash: ev.valid ? contentHashSafe(document) : null,
    levels,
    rooms,
    walls,
    openings,
    summary,
  };
}

function contentHashSafe(doc: Doc): string | null {
  try {
    return contentHash(doc);
  } catch {
    return null;
  }
}

/** Does segment [a, b] lie on segment [c, d] (collinear, within tol, inside its extent)? */
export function onSegment(a: Pt, b: Pt, c: Pt, d: Pt, tol: number): boolean {
  return distToSegment(a, c, d) <= tol && distToSegment(b, c, d) <= tol;
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const m = dx * dx + dy * dy;
  const t = m === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / m));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const midpoint = mid;
