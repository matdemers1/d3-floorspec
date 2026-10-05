/**
 * The program (Core 0.2, chapter 11): the rooms that fulfil each item, whether they meet its count
 * and areas (11.3), and whether the rooms of each adjacency's items are adjacent and connected
 * (11.4).
 *
 * Adjacency is read off the faces of each level's plane graph: every half-edge lies on the
 * boundary — outer or inner cycle — of exactly one face, and an edge lies between the faces of its
 * two half-edges. Net areas are compared exactly, as twice-areas of the room polygons (6.4).
 */
import { entries, get, programItems, adjacencies, type FloorspecDocument } from '../model/document.js';
import type { Analysis } from '../validate/invariants.js';

export interface DerivedProgramItem {
  rooms: string[];
  countMet: boolean;
  minAreaMet?: boolean;
  targetAreaMet?: boolean;
}

export interface DerivedAdjacency {
  a: string;
  b: string;
  kind: 'required' | 'preferred' | 'forbidden';
  adjacent: boolean;
  connected: boolean;
}

export interface DerivedProgram {
  items: Record<string, DerivedProgramItem>;
  adjacency: DerivedAdjacency[];
}

/** What the program's derivation and lints both need: relations between rooms, and their areas. */
export interface ProgramAnalysis {
  readonly derived: DerivedProgram;
  /** Twice each room's net area. */
  readonly area2: ReadonlyMap<string, bigint>;
  /** Each item's rooms, sorted. */
  readonly roomsOf: ReadonlyMap<string, readonly string[]>;
  /** Every pair of connected rooms (11.4), each pair sorted. Circulation (chapter 14) links them. */
  readonly connected: readonly (readonly [string, string])[];
  /** Rooms connected to the unbounded face of their level by a separator, a door or a cased opening (14.2). */
  readonly outside: ReadonlySet<string>;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** Walls that host an empty (cased) opening or a door: they connect the rooms either side (11.4). */
function connectingWalls(doc: FloorspecDocument): Set<string> {
  const out = new Set<string>();
  for (const [, o] of entries(doc.openings)) {
    if (o.fill === undefined || get(doc.types, o.fill)?.kind === 'doorType') out.add(o.wall);
  }
  return out;
}

interface Relations {
  adjacent: Set<string>;
  connected: Map<string, readonly [string, string]>;
  area2: Map<string, bigint>;
  outside: Set<string>;
}

function roomRelations(doc: FloorspecDocument, analysis: Analysis): Relations {
  const adjacent = new Set<string>();
  const connected = new Map<string, readonly [string, string]>();
  const area2 = new Map<string, bigint>();
  const outside = new Set<string>();
  const doors = connectingWalls(doc);
  for (const [, la] of analysis.levels) {
    const g = la.geometry;
    if (!g) continue;
    // The face each cycle bounds; cycles of the unbounded face bound none.
    const cycleIndex = new Map(g.graph.cycles.map((c, i) => [c, i]));
    const faceOfCycle = new Map<number, number>();
    g.faces.forEach((f, i) => {
      for (const c of [f.outer, ...f.inner]) faceOfCycle.set(cycleIndex.get(c)!, i);
    });
    const roomOfFace = new Map<number, string>();
    for (const [rid, face] of la.roomFaces) {
      roomOfFace.set(face, rid);
      area2.set(rid, g.roomPolygon(g.faces[face]!).area2);
    }
    g.edges.forEach((e, i) => {
      const fa = faceOfCycle.get(g.graph.cycleOf[2 * i]!);
      const fb = faceOfCycle.get(g.graph.cycleOf[2 * i + 1]!);
      const joins = e.kind === 'separator' || doors.has(e.id);
      // One side is the unbounded face: the room on the other is an entry (14.2).
      if (joins && (fa === undefined) !== (fb === undefined)) {
        const r = roomOfFace.get((fa ?? fb)!);
        if (r !== undefined) outside.add(r);
      }
      if (fa === undefined || fb === undefined || fa === fb) return;
      const ra = roomOfFace.get(fa);
      const rb = roomOfFace.get(fb);
      if (ra === undefined || rb === undefined) return;
      const k = pairKey(ra, rb);
      adjacent.add(k);
      if (joins) connected.set(k, ra < rb ? [ra, rb] : [rb, ra]);
    });
  }
  return { adjacent, connected, area2, outside };
}

const cache = new WeakMap<Analysis, ProgramAnalysis>();

/** 11.3, 11.4: the program's derived values for a valid document. */
export function analyseProgram(doc: FloorspecDocument, analysis: Analysis): ProgramAnalysis {
  const hit = cache.get(analysis);
  if (hit) return hit;
  const { adjacent, connected, area2, outside } = roomRelations(doc, analysis);
  const roomsOf = new Map<string, string[]>();
  const items = programItems(doc);
  for (const [iid] of items) roomsOf.set(iid, []);
  for (const [rid, r] of entries(doc.rooms)) if (r.brief !== undefined) roomsOf.get(r.brief)?.push(rid);
  const out: DerivedProgram = { items: {}, adjacency: [] };
  for (const [iid, item] of items) {
    const rs = roomsOf.get(iid)!;
    const v: DerivedProgramItem = { rooms: [...rs], countMet: rs.length >= (item.count ?? 1) };
    if (item.minArea !== undefined) {
      const min2 = 2n * BigInt(item.minArea);
      v.minAreaMet = rs.every((r) => area2.get(r)! >= min2);
    }
    if (item.targetArea !== undefined) {
      const target2 = 2n * BigInt(item.targetArea);
      v.targetAreaMet = rs.every((r) => area2.get(r)! >= target2);
    }
    Object.defineProperty(out.items, iid, { value: v, enumerable: true, writable: true, configurable: true });
  }
  for (const adj of adjacencies(doc)) {
    const as = roomsOf.get(adj.a) ?? [];
    const bs = roomsOf.get(adj.b) ?? [];
    const pairs = as.flatMap((x) => bs.filter((y) => y !== x).map((y) => pairKey(x, y)));
    out.adjacency.push({
      a: adj.a,
      b: adj.b,
      kind: adj.kind,
      adjacent: pairs.some((p) => adjacent.has(p)),
      connected: pairs.some((p) => connected.has(p)),
    });
  }
  const result = { derived: out, area2, roomsOf, connected: [...connected.values()], outside };
  cache.set(analysis, result);
  return result;
}
