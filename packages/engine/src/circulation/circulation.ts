/**
 * Circulation (Core 0.2, chapter 14): each building's door graph, its entries, which rooms are
 * reachable from an entry, which sleeping rooms are reachable only through another sleeping room,
 * and the circulation lints FS-LINT-012 … 014.
 *
 * The door graph's nodes are rooms. Two rooms are linked when they are connected (11.4), or when
 * both have the function `circulation` and are on different levels of one building — the stand-in
 * for stairs, which Core 0.2 does not define (14.1). A room is an entry when an edge between its
 * face and its level's unbounded face is a separator, or a wall hosting a door or an empty opening
 * (14.2). Everything here is a search over a finite graph: exact, and independent of the order in
 * which a document lists its elements.
 */
import { analyseProgram } from '../derive/program.js';
import { entries, get, type FloorspecDocument } from '../model/document.js';
import type { Analysis, Reporter } from '../validate/invariants.js';

/** 14.3: what a deriver derives for one room. */
export interface DerivedCirculationRoom {
  /** The room is an entry (14.2). */
  entry: boolean;
  /** The room is reachable from an entry of its building. */
  reachable: boolean;
  /** Present only for a sleeping room: it is reachable only through another sleeping room. */
  throughSleeping?: boolean;
}

export interface BuildingCirculation {
  /** A wall on one of the building's levels hosts a door or an empty opening (14.4). */
  readonly evaluated: boolean;
  /** The building's rooms, sorted. */
  readonly rooms: readonly string[];
  /** Its entries, sorted. */
  readonly entries: readonly string[];
}

export interface CirculationAnalysis {
  /** Every room, by ID. */
  readonly derived: Record<string, DerivedCirculationRoom>;
  /** Every building, by ID. */
  readonly buildings: ReadonlyMap<string, BuildingCirculation>;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const functionOf = (doc: FloorspecDocument, rid: string): string => get(doc.rooms, rid)?.function ?? 'unspecified';

/** Every node reachable from `start` through `links`, never entering `removed`. */
function reach(links: ReadonlyMap<string, ReadonlySet<string>>, start: Iterable<string>, removed: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const todo: string[] = [];
  for (const r of start)
    if (!removed.has(r) && !seen.has(r)) {
      seen.add(r);
      todo.push(r);
    }
  while (todo.length) {
    const r = todo.pop()!;
    for (const s of links.get(r) ?? [])
      if (!seen.has(s) && !removed.has(s)) {
        seen.add(s);
        todo.push(s);
      }
  }
  return seen;
}

const cache = new WeakMap<Analysis, CirculationAnalysis>();

/** 14.1–14.3: the circulation of a valid document. */
export function analyseCirculation(doc: FloorspecDocument, analysis: Analysis): CirculationAnalysis {
  const hit = cache.get(analysis);
  if (hit) return hit;
  const { connected, outside } = analyseProgram(doc, analysis);

  const links = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!links.has(a)) links.set(a, new Set());
    if (!links.has(b)) links.set(b, new Set());
    links.get(a)!.add(b);
    links.get(b)!.add(a);
  };
  for (const [a, b] of connected) link(a, b);

  const buildingOf = new Map<string, string>();
  for (const [rid, room] of entries(doc.rooms)) buildingOf.set(rid, get(doc.levels, room.level)!.building);
  const halls = [...buildingOf.keys()].filter((r) => functionOf(doc, r) === 'circulation').sort(cmp);
  for (let i = 0; i < halls.length; i++)
    for (let k = i + 1; k < halls.length; k++) {
      const a = halls[i]!;
      const b = halls[k]!;
      if (buildingOf.get(a) === buildingOf.get(b) && get(doc.rooms, a)!.level !== get(doc.rooms, b)!.level) link(a, b);
    }

  // Walls that host a door or an empty opening make their building evaluated (14.4).
  const doorLevels = new Set<string>();
  for (const [, o] of entries(doc.openings))
    if (o.fill === undefined || get(doc.types, o.fill)?.kind === 'doorType') doorLevels.add(get(doc.walls, o.wall)!.level);

  const derived: Record<string, DerivedCirculationRoom> = {};
  const buildings = new Map<string, BuildingCirculation>();
  for (const [bid] of entries(doc.buildings).sort(([a], [b]) => cmp(a, b))) {
    const rooms = [...buildingOf].filter(([, b]) => b === bid).map(([r]) => r).sort(cmp);
    const entrySet = rooms.filter((r) => outside.has(r));
    const reachable = reach(links, entrySet);
    const sleeping = new Set(rooms.filter((r) => functionOf(doc, r) === 'sleeping'));
    const evaluated = entries(doc.levels).some(([lid, l]) => l.building === bid && doorLevels.has(lid));
    buildings.set(bid, { evaluated, rooms, entries: entrySet });
    for (const r of rooms) {
      const v: DerivedCirculationRoom = { entry: outside.has(r), reachable: reachable.has(r) };
      if (sleeping.has(r)) {
        const others = new Set([...sleeping].filter((s) => s !== r));
        v.throughSleeping = v.reachable && !reach(links, entrySet, others).has(r);
      }
      Object.defineProperty(derived, r, { value: v, enumerable: true, writable: true, configurable: true });
    }
  }
  const result = { derived, buildings };
  cache.set(analysis, result);
  return result;
}

const ptr = (collection: string, id: string): string => `/${collection}/${id.replace(/~/g, '~0').replace(/\//g, '~1')}`;

/**
 * 14.4: FS-LINT-014 once for an evaluated building with rooms and no entry; otherwise FS-LINT-012
 * for each unreachable room and FS-LINT-013 for each sleeping room reached only through another.
 * Never an error (FS-CORE-14.4.3), and nothing for a building that is not evaluated (14.4.2).
 */
export function circulationLints(doc: FloorspecDocument, analysis: Analysis, r: Reporter): void {
  const { derived, buildings } = analyseCirculation(doc, analysis);
  for (const [bid, b] of buildings) {
    if (!b.evaluated || !b.rooms.length) continue;
    if (!b.entries.length) {
      r.report('FS-LINT-014', `Building ${bid} has doors but no way in: no room has a door, cased opening or separator to the outside.`, [bid], {
        pointer: ptr('buildings', bid),
      });
      continue;
    }
    for (const rid of b.rooms) {
      const v = derived[rid]!;
      const level = get(doc.rooms, rid)!.level;
      if (!v.reachable)
        r.report('FS-LINT-012', `${rid} cannot be reached from an entry of ${bid} through doors.`, [rid], { level, pointer: ptr('rooms', rid) });
      else if (v.throughSleeping)
        r.report('FS-LINT-013', `${rid} is a sleeping room that can only be reached through another sleeping room.`, [rid], { level, pointer: ptr('rooms', rid) });
    }
  }
}
