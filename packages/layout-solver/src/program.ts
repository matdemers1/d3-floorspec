/**
 * Reading a program (Core 0.2, chapter 11) into the rooms the solver will place.
 *
 * Each program item becomes `count` room requests, less the rooms that already fulfil it (a room
 * whose `brief` names it, 11.3). Each request carries the area the solver aims for, the zone of the
 * house it belongs in, and — for a bath or a closet the brief asks to be next to exactly one
 * bedroom — that bedroom as its host: an en-suite room, entered through its bedroom.
 */
import { SQ_BU_PER_SQ_FT, SQ_G_PER_SQ_FT, ftG } from './units.js';

export interface ProgramItem {
  function: string;
  name?: string;
  count?: number;
  targetArea?: number;
  minArea?: number;
  level?: string;
  extensions?: Record<string, unknown>;
  extras?: Record<string, unknown>;
}

export interface Adjacency {
  a: string;
  b: string;
  kind: 'required' | 'preferred' | 'forbidden';
  weight?: number;
}

export interface Program {
  items?: Record<string, ProgramItem>;
  adjacency?: Adjacency[];
}

/** Where in the house a request belongs. `flex` rooms (laundry, utility) may go either side. */
export type Zone = 'public' | 'private' | 'flex' | 'garage';

/** One room the solver means to place. */
export interface Req {
  /** Stable key: the item ID, and for an item of several rooms `-<n>`. */
  readonly key: string;
  readonly item: string;
  readonly name: string;
  readonly fn: string;
  /** The net area aimed for, in square feet. */
  readonly target: number;
  /** The least net area, in square feet, when the item has one. */
  readonly min?: number;
  readonly zone: Zone;
  /** The key of the bedroom this room is en suite to. */
  host?: string;
}

export interface Unplaced {
  readonly item: string;
  readonly count: number;
  readonly reason: string;
}

export interface Brief {
  readonly reqs: Req[];
  readonly unplaced: Unplaced[];
  readonly adjacency: readonly Adjacency[];
  readonly items: Readonly<Record<string, ProgramItem>>;
}

/** Areas, in square feet, for an item that states neither a target nor a minimum. */
const DEFAULT_AREA: Readonly<Record<string, number>> = {
  sleeping: 140,
  bath: 50,
  kitchen: 170,
  living: 300,
  dining: 150,
  office: 120,
  laundry: 50,
  utility: 60,
  storage: 35,
  circulation: 70,
  mechanical: 30,
  garage: 440,
  unspecified: 120,
};

/** The least plan dimension of a room of each function, in grid units: no slivers. */
const MIN_DIM: Readonly<Record<string, number>> = {
  sleeping: ftG(10),
  office: ftG(8),
  living: ftG(11),
  dining: ftG(9),
  kitchen: ftG(8),
  bath: ftG(5),
  laundry: ftG(5),
  utility: ftG(5),
  storage: ftG(4),
  mechanical: ftG(4),
  circulation: ftG(5),
  garage: ftG(12),
  unspecified: ftG(8),
};

export const minDim = (fn: string): number => MIN_DIM[fn] ?? ftG(8);

/** Functions whose rooms are part of the open, shared heart of the house. */
export const OPEN_FUNCTIONS: ReadonlySet<string> = new Set(['living', 'dining', 'kitchen']);

const LABEL: Readonly<Record<string, string>> = {
  sleeping: 'Bedroom',
  bath: 'Bath',
  kitchen: 'Kitchen',
  living: 'Living',
  dining: 'Dining',
  office: 'Office',
  laundry: 'Laundry',
  utility: 'Utility',
  storage: 'Storage',
  circulation: 'Entry',
  mechanical: 'Mechanical',
  garage: 'Garage',
  unspecified: 'Room',
};

export const labelOf = (fn: string): string => LABEL[fn] ?? 'Room';

function zoneOf(item: ProgramItem): Zone | 'exterior' {
  switch (item.function) {
    case 'sleeping':
    case 'office':
    case 'storage':
    case 'mechanical':
      return 'private';
    case 'bath':
      // A powder room belongs by the living spaces; every other bath by the bedrooms.
      return /powder|half/i.test(item.name ?? '') ? 'public' : 'private';
    case 'laundry':
    case 'utility':
      return 'flex';
    case 'garage':
      return 'garage';
    case 'exterior':
      return 'exterior';
    default:
      return 'public';
  }
}

/** The target net area of each room of an item, in square feet. */
function targetOf(item: ProgramItem): { target: number; min?: number } {
  const min = item.minArea === undefined ? undefined : item.minArea / SQ_BU_PER_SQ_FT;
  if (item.targetArea !== undefined) return { target: item.targetArea / SQ_BU_PER_SQ_FT, ...(min === undefined ? {} : { min }) };
  if (min !== undefined) return { target: min * 1.15, min };
  return { target: DEFAULT_AREA[item.function] ?? 120 };
}

/** Square grid units a request's rectangle should have: its net area plus what its walls take. */
export const grossG = (r: Req): number => r.target * SQ_G_PER_SQ_FT * 1.08;

export interface ReadOptions {
  /** The level being laid out: items preferring another level are not placed on it. */
  readonly level: string | undefined;
  readonly ignoreItemLevels: boolean;
  /** How many rooms already fulfil each item (11.3). */
  readonly fulfilled: ReadonlyMap<string, number>;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The room requests of a program, in item-ID order. */
export function readBrief(program: Program, options: ReadOptions): Brief {
  const items = program.items ?? {};
  const adjacency = program.adjacency ?? [];
  const reqs: Req[] = [];
  const unplaced: Unplaced[] = [];
  for (const id of Object.keys(items).sort(cmp)) {
    const item = items[id]!;
    const count = item.count ?? 1;
    const remaining = count - (options.fulfilled.get(id) ?? 0);
    if (remaining <= 0) continue;
    const zone = zoneOf(item);
    if (zone === 'exterior') {
      unplaced.push({ item: id, count: remaining, reason: 'exterior spaces (porches, decks) are outside the footprint this solver lays out' });
      continue;
    }
    if (!options.ignoreItemLevels && item.level !== undefined && item.level !== options.level) {
      unplaced.push({ item: id, count: remaining, reason: `preferred on level ${item.level}; this layout is for ${options.level ?? 'a new level'}` });
      continue;
    }
    const { target, min } = targetOf(item);
    const base = item.name ?? labelOf(item.function);
    for (let n = 1; n <= remaining; n++) {
      const index = count - remaining + n;
      reqs.push({
        key: count > 1 ? `${id}-${String(index)}` : id,
        item: id,
        name: count > 1 ? `${base} ${String(index)}` : base,
        fn: item.function,
        target,
        ...(min === undefined ? {} : { min }),
        zone,
      });
    }
  }
  assignHosts(reqs, items, adjacency);
  return { reqs, unplaced, adjacency, items };
}

/**
 * En suite: a bath or a storage room whose item is wanted next to exactly one bedroom item (a
 * required or preferred adjacency, both of count 1) is entered through that bedroom.
 */
function assignHosts(reqs: Req[], items: Record<string, ProgramItem>, adjacency: readonly Adjacency[]): void {
  const single = new Map<string, Req>();
  for (const r of reqs) if ((items[r.item]!.count ?? 1) === 1) single.set(r.item, r);
  for (const r of reqs) {
    if (r.fn !== 'bath' && r.fn !== 'storage') continue;
    if (!single.has(r.item)) continue;
    let best: { host: Req; w: number } | undefined;
    for (const adj of adjacency) {
      if (adj.kind === 'forbidden') continue;
      const other = adj.a === r.item ? adj.b : adj.b === r.item ? adj.a : undefined;
      if (other === undefined) continue;
      const host = single.get(other);
      if (host?.fn !== 'sleeping') continue;
      const w = (adj.weight ?? 5) + (adj.kind === 'required' ? 10 : 0);
      if (best === undefined || w > best.w || (w === best.w && host.key < best.host.key)) best = { host, w };
    }
    if (best !== undefined) r.host = best.host.key;
  }
}

/** The kind and weight of the adjacency between two items, if the brief has one. */
export function adjacencyBetween(adjacency: readonly Adjacency[], a: string, b: string): Adjacency[] {
  return adjacency.filter((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
}

/** How much the brief wants two items side by side: positive for required/preferred, negative for forbidden. */
export function affinity(adjacency: readonly Adjacency[], a: string, b: string): number {
  let s = 0;
  for (const x of adjacencyBetween(adjacency, a, b)) {
    const w = x.weight ?? 5;
    s += x.kind === 'required' ? 2 * w : x.kind === 'preferred' ? w : -2 * w;
  }
  return s;
}
