import type { FloorspecDocument } from '@floorspec/engine';
import landscapeLibrary from '../../../../packages/engine/standard/registry/FS_landscape/library.json';
import { LIBRARY, categoryLabel, mountHeight, type LibraryItem } from '../furniture/library';
import { DEVICE_KINDS, type DeviceKind } from '../editor/systems/catalog';
import { typeChoices, type TypeChoice } from '../editor/ops';
import { words } from '../editor/systems/catalog';

/**
 * Everything the editor can add to a plan, as one library (FLR-T-18.7, the board's "18.7 · Library
 * drawer"): FS_furniture's starter library (furniture, appliances, casework and the decor of 0.2.0),
 * the building systems' devices (FS_electrical, FS_plumbing, FS_mechanical, FS_lowvoltage), the
 * document's door and window types with the starters it does not hold yet, and FS_landscape's plants
 * by size with a few planting beds. Each entry says how it is placed — backed onto a wall, free on a
 * floor, on a wall face, on a ceiling, in a wall as an opening, or free on the level — and its
 * footprint in its own frame (Core 13.2: +x forward, +y to its left), which is all the ghost needs.
 */

export type GroupId =
  | 'seating' | 'tables' | 'beds' | 'storage' | 'kitchen' | 'bath' | 'decor' | 'doors' | 'windows' | 'lighting'
  | 'electrical' | 'plumbing' | 'mechanical' | 'lowvoltage' | 'outdoor';

/** The chips, in the board's order, then the trades'. */
export const GROUPS: readonly { id: GroupId; label: string }[] = [
  { id: 'seating', label: 'Seating' },
  { id: 'tables', label: 'Tables' },
  { id: 'beds', label: 'Beds' },
  { id: 'storage', label: 'Storage' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'bath', label: 'Bath' },
  { id: 'decor', label: 'Decor' },
  { id: 'doors', label: 'Doors' },
  { id: 'windows', label: 'Windows' },
  { id: 'lighting', label: 'Lighting' },
  { id: 'electrical', label: 'Electrical' },
  { id: 'plumbing', label: 'Plumbing' },
  { id: 'mechanical', label: 'Mechanical' },
  { id: 'lowvoltage', label: 'Low-voltage' },
  { id: 'outdoor', label: 'Outdoor' },
];

export const groupLabel = (id: GroupId): string => GROUPS.find((g) => g.id === id)?.label ?? id;

/**
 * How an entry is placed:
 * - `backed`: on a floor, its back against the nearest wall face, facing into the room (a sofa, a fridge);
 * - `floor`: on a floor where it is put, turned as it is turned (a table, a rug, a chair);
 * - `wall`: on a wall face at a height (a wall cabinet, a receptacle);
 * - `ceiling`: on a ceiling (a light);
 * - `device`: a building-system device, placed as the device tool places it (systems/placement.ts);
 * - `opening`: in a wall (a door, a window);
 * - `level`: free on the level, inside a room or out of one (FS_landscape).
 */
export type Placement = 'backed' | 'floor' | 'wall' | 'device' | 'opening' | 'level';

/** A box in the entry's frame, base units: x forward (its depth), y to its left (its width). */
export interface FrameBox {
  min: [number, number, number];
  max: [number, number, number];
}

export type EntrySource =
  | { kind: 'furniture'; item: LibraryItem }
  | { kind: 'device'; device: DeviceKind }
  | { kind: 'opening'; type: TypeChoice }
  | { kind: 'landscape'; collection: 'plants' | 'beds'; element: Record<string, unknown> };

export interface Entry {
  /** Unique across the library: `furniture:sofa-2100`, `device:toilet`, `door:D1`, `landscape:tree-small`. */
  key: string;
  name: string;
  groups: readonly GroupId[];
  placement: Placement;
  box: FrameBox;
  /** Clearance envelopes in the frame (FS_furniture 4.2), drawn with the ghost. */
  clearances: readonly { name: string; min: readonly number[]; max: readonly number[]; purpose?: string }[];
  /** A wall mount's height above the wall's base, base units. */
  height: number;
  /** The plan symbol's URL, for a library item that has one. */
  symbol: string | null;
  /** What the search reads: its name, its groups, its kind and its other words. */
  hay: string;
  source: EntrySource;
}

/** Items that stand in the middle of a room rather than against a wall (as furniture/placement.ts). */
const FREE_STANDING = new Set(['island', 'diningTable', 'coffeeTable', 'sideTable', 'chair', 'stool', 'bench', 'armchair', 'crib']);

/** The decor of FS_furniture 0.2.0 (FLR-T-13.11) is all `other`: its group by its catalogue ID. */
function decorGroups(id: string): GroupId[] {
  if (/^lamp-/.test(id)) return ['lighting', 'decor'];
  if (/^(bath-mat|towel|towels|soap)/.test(id)) return ['bath', 'decor'];
  if (/^(kettle|canisters|cutting-board|bowl-fruit)/.test(id)) return ['kitchen', 'decor'];
  if (/^media-console/.test(id)) return ['storage'];
  return ['decor'];
}

/** Rugs, runners and mats lie on the floor wherever they are put; art, mirrors and curtains go against a wall. */
function decorPlacement(id: string): Placement {
  if (/^(rug|runner|bath-mat|plant|lamp-floor|cushion|throw|books|vase|bowl|kettle|canisters|cutting-board|towels|soap|lamp-table)/.test(id)) return 'floor';
  return 'backed';
}

const FURNITURE_GROUPS: Readonly<Record<string, GroupId[]>> = {
  sofa: ['seating'], armchair: ['seating'], chair: ['seating'], bench: ['seating'], stool: ['seating'],
  diningTable: ['tables'], coffeeTable: ['tables'], sideTable: ['tables'], desk: ['tables'],
  bed: ['beds'], crib: ['beds'], nightstand: ['beds', 'storage'],
  dresser: ['storage'], wardrobe: ['storage'], bookcase: ['storage'], sideboard: ['storage'], mediaUnit: ['storage'], shelf: ['storage'], shelving: ['storage'],
  baseCabinet: ['kitchen'], wallCabinet: ['kitchen'], tallCabinet: ['kitchen', 'storage'], island: ['kitchen'], vanity: ['bath'],
};

const box3 = (b: { min: readonly number[]; max: readonly number[] }): FrameBox => ({
  min: [b.min[0] ?? 0, b.min[1] ?? 0, b.min[2] ?? 0],
  max: [b.max[0] ?? 0, b.max[1] ?? 0, b.max[2] ?? 0],
});

function furnitureEntry(item: LibraryItem): Entry {
  const other = item.category === 'other';
  const groups = other ? decorGroups(item.id) : item.kind === 'appliances' ? ['kitchen' as const] : (FURNITURE_GROUPS[item.category] ?? ['storage']);
  const placement: Placement = item.mounting !== 'floor' ? 'wall' : other ? decorPlacement(item.id) : FREE_STANDING.has(item.category) ? 'floor' : 'backed';
  return {
    key: `furniture:${item.id}`,
    name: item.name,
    groups,
    placement,
    box: box3(item.box),
    clearances: Object.entries(item.clearances).map(([name, e]) => ({ name, min: e.min, max: e.max, purpose: e.purpose })),
    height: item.mounting === 'floor' ? 0 : mountHeight(item.category),
    symbol: item.symbol.url === '' ? null : item.symbol.url,
    hay: `${item.name} ${categoryLabel(item.category)} ${item.category} ${item.kind} ${item.id} furniture`,
    source: { kind: 'furniture', item },
  };
}

const DEVICE_GROUPS: Readonly<Record<string, GroupId[]>> = {
  light: ['lighting', 'electrical'],
  toilet: ['bath', 'plumbing'], lavatory: ['bath', 'plumbing'], shower: ['bath', 'plumbing'], bathtub: ['bath', 'plumbing'],
  kitchenSink: ['kitchen', 'plumbing'], gasRange: ['kitchen', 'mechanical'], exhaustFan: ['mechanical', 'bath'],
};

function deviceEntry(kind: DeviceKind): Entry {
  return {
    key: `device:${kind.id}`,
    name: kind.label,
    groups: DEVICE_GROUPS[kind.id] ?? [kind.system],
    placement: 'device',
    box: box3(kind.box),
    clearances: [],
    height: 0,
    symbol: null,
    hay: `${kind.label} ${kind.aliases.join(' ')} ${kind.system} ${kind.collection} ${kind.id} device`,
    source: { kind: 'device', device: kind },
  };
}

/** A door or window type as an entry: its width along the wall, a nominal depth across it. */
function openingEntry(type: TypeChoice): Entry {
  const width = Number(type.element['width'] ?? 0);
  const door = type.kind === 'doorType';
  return {
    key: `${door ? 'door' : 'window'}:${type.id}`,
    name: type.name,
    groups: [door ? 'doors' : 'windows'],
    placement: 'opening',
    box: { min: [0, -width / 2, 0], max: [0, width / 2, Number(type.element['height'] ?? 0)] },
    clearances: [],
    height: 0,
    symbol: null,
    hay: `${type.name} ${door ? 'door' : 'window'} ${typeof type.element['operation'] === 'string' ? type.element['operation'] : ''} ${type.starter ? 'starter' : ''}`,
    source: { kind: 'opening', type },
  };
}

const MM = 1_280;

/** Planting beds (FS_landscape 2.4): rectangles centred on their frame, so they turn about their middle. */
const BEDS: readonly { id: string; name: string; w: number; d: number; cover: string; edging: string; raised: boolean }[] = [
  { id: 'bed-1200x2400', name: 'Planting bed, 1200 × 2400 mm', w: 2400, d: 1200, cover: 'mulch', edging: 'none', raised: false },
  { id: 'bed-900x3600', name: 'Border bed, 900 × 3600 mm', w: 3600, d: 900, cover: 'mulch', edging: 'steel', raised: false },
  { id: 'bed-1200x1200-gravel', name: 'Gravel bed, 1200 × 1200 mm', w: 1200, d: 1200, cover: 'gravel', edging: 'stone', raised: false },
  { id: 'bed-raised-1200x2400', name: 'Raised bed, 1200 × 2400 mm, timber', w: 2400, d: 1200, cover: 'soil', edging: 'timber', raised: true },
];

interface RawPlant {
  kind: string;
  size: string;
  element: Record<string, unknown> & { form: string; name: string; fallback: { box: { min: number[]; max: number[] } } };
}

function landscapeEntries(): Entry[] {
  const plants = Object.entries((landscapeLibrary as unknown as { items: Record<string, RawPlant> }).items).map(([id, raw]): Entry => ({
    key: `landscape:${id}`,
    name: raw.element.name,
    groups: ['outdoor'],
    placement: 'level',
    box: box3(raw.element.fallback.box),
    clearances: [],
    height: 0,
    symbol: null,
    hay: `${raw.element.name} ${raw.element.form} ${raw.size} plant garden landscape outdoor`,
    source: { kind: 'landscape', collection: 'plants', element: raw.element },
  }));
  const beds = BEDS.map((b): Entry => {
    const [hx, hy] = [(b.d * MM) / 2, (b.w * MM) / 2];
    const top = (b.raised ? 450 : 50) * MM;
    return {
      key: `landscape:${b.id}`,
      name: b.name,
      groups: ['outdoor'],
      placement: 'level',
      box: { min: [-hx, -hy, 0], max: [hx, hy, top] },
      clearances: [],
      height: 0,
      symbol: null,
      hay: `${b.name} bed planting ${b.cover} ${b.edging} garden landscape outdoor`,
      source: {
        kind: 'landscape',
        collection: 'beds',
        element: {
          boundary: [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]],
          cover: b.cover,
          ...(b.edging === 'none' ? {} : { edging: b.edging }),
          catalogue: b.id,
          name: b.name,
          fallback: { box: { min: [-hx, -hy, 0], max: [hx, hy, top] } },
        },
      },
    };
  });
  return [...plants, ...beds];
}

/** The parts of the library that do not depend on the document. */
const FIXED: readonly Entry[] = [...LIBRARY.map(furnitureEntry), ...DEVICE_KINDS.map(deviceEntry), ...landscapeEntries()];

const cache = new WeakMap<FloorspecDocument, readonly Entry[]>();

/** The whole library for a document: the fixed parts and its door and window types. */
export function entriesFor(document: FloorspecDocument | null | undefined): readonly Entry[] {
  if (document === null || document === undefined) return FIXED;
  const hit = cache.get(document);
  if (hit !== undefined) return hit;
  const openings = [...typeChoices(document, 'doorType'), ...typeChoices(document, 'windowType')].map(openingEntry);
  const all = [...FIXED, ...openings];
  cache.set(document, all);
  return all;
}

export function entryByKey(document: FloorspecDocument | null | undefined, key: string): Entry | undefined {
  return entriesFor(document).find((e) => e.key === key);
}

/** Whether an entry matches a search: every word somewhere in its name, groups, kind or other words. */
export function matches(entry: Entry, query: string): boolean {
  const hay = `${entry.hay} ${entry.groups.map(groupLabel).join(' ')}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '')
    .every((w) => hay.includes(w));
}

/**
 * A search across the whole library, best first: a name that starts with the query, then one with
 * a word that does, then any match; recent items ahead of the rest at each step.
 */
export function search(entries: readonly Entry[], query: string, recent: readonly string[] = []): Entry[] {
  const q = query.trim().toLowerCase();
  const hits = entries.filter((e) => matches(e, q));
  if (q === '') return [...hits].sort((a, b) => rank(recent, a) - rank(recent, b));
  const first = q.split(/\s+/)[0] ?? '';
  const score = (e: Entry): number => {
    const name = e.name.toLowerCase();
    const base = name.startsWith(first) ? 0 : name.split(/[\s,·]+/).some((w) => w.startsWith(first)) ? 1 : 2;
    return base * 100 + rank(recent, e);
  };
  return [...hits].sort((a, b) => score(a) - score(b));
}

const rank = (recent: readonly string[], e: Entry): number => {
  const i = recent.indexOf(e.key);
  return i === -1 ? 50 : i;
};

const IN = 32_512;

/** "84 × 36″" or "2100 × 900 mm": width × depth, as the board's cards read. */
export function footprintText(entry: Entry, units: 'imperial' | 'metric'): string {
  const w = entry.box.max[1] - entry.box.min[1];
  const d = entry.box.max[0] - entry.box.min[0];
  const n = (v: number) => String(Math.round(v / (units === 'metric' ? MM : IN)));
  if (entry.placement === 'opening') return `${n(w)} × ${n(entry.box.max[2] - entry.box.min[2])}${units === 'metric' ? ' mm' : '″'}`;
  return `${n(w)} × ${n(d)}${units === 'metric' ? ' mm' : '″'}`;
}

/** The kind of thing an entry is, for a list's second line: "Seating", "Doors". */
export function kindText(entry: Entry): string {
  const g = entry.groups[0];
  return g === undefined ? words(entry.source.kind) : groupLabel(g);
}
