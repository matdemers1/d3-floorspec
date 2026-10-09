/**
 * The plan as the assistant reads it: each room's wall runs — the stretches of wall face that look
 * into it, between corners and doors — with the receptacles already on them, its entries, and its
 * devices, all from the engine's evaluation (FLR-ADR-010). Positions along a wall are offsets along
 * its location line from its start junction, as a wall-face host states them (Core 13.3), computed
 * exactly from integers and rounded once.
 */
import { deriveEvaluation, evaluate, extElements, facingVector, isqrt, OFFICIAL_READER, officialElementRooms, predicates, type Derived, type Evaluation, type FloorspecDocument } from '@floorspec/engine';

type Point = readonly [number, number];
type Json = Record<string, unknown>;

export interface WallRun {
  room: string;
  wall: string;
  /** The wall face that looks into the room (Core 13.3). */
  side: 'left' | 'right';
  /** Offsets along the wall's location line, from < to. */
  from: number;
  to: number;
}

export interface Entry {
  room: string;
  /** The opening — or, for an open side, the separator — the room is entered through. */
  opening: string;
  wall: string;
  side: 'left' | 'right';
  /** The opening's extent along the wall. */
  from: number;
  to: number;
  /** Where its door hangs; null for a cased opening, which has no door. */
  hinge: 'start' | 'end' | null;
}

/** A stretch of a wall face with a counter along it: FS_furniture casework set against the face. */
export interface CounterSpan {
  wall: string;
  side: 'left' | 'right';
  /** Offsets along the wall's location line, from < to. */
  from: number;
  to: number;
  /** The casework element. */
  casework: string;
}

export interface RoomPlan {
  id: string;
  name: string;
  function: string;
  level: string;
  runs: WallRun[];
  entries: Entry[];
  /** A point strictly inside the room, on the grid when one is: where a ceiling light goes. */
  centre: Point | null;
  /** FS_electrical's elements in the room, as it derives them (FS_electrical 6.1). */
  devices: string[];
  /** The stretches of its wall faces with counter casework along them (FLR-T-12.26), by wall, side and offset. */
  counters: CounterSpan[];
  /** Whether it has counter casework at all — along a wall or not, an island say: when it does, only the spans above are counters. */
  hasCounters: boolean;
  /** Its arc walls (Core 21): no wall run is read along a curve, so they get no receptacles. */
  curved: string[];
}

export interface PlanReading {
  document: FloorspecDocument;
  evaluation: Evaluation;
  derived: Derived;
  rooms: RoomPlan[];
  /** The wall-face receptacles, by wall and side: their offsets. */
  receptaclesOn: (wall: string, side: 'left' | 'right') => { id: string; offset: number }[];
}

export class PlanError extends Error {}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `dot(P − S, d) / |d|`, the offset of P's projection along a wall, rounded half up once. */
function offsetAlong(p: Point, s: Point, d: Point, len: bigint): number {
  const dot = BigInt(p[0] - s[0]) * BigInt(d[0]) + BigInt(p[1] - s[1]) * BigInt(d[1]);
  const twice = (2n * dot + len) / (2n * len);
  return Number(dot < 0n ? -((-2n * dot + len) / (2n * len)) : twice);
}

/** The length of a wall's location line, rounded down: a host's offset never exceeds it (Core 13.3.2). */
function lengthOf(d: Point): bigint {
  return isqrt(BigInt(d[0]) ** 2n + BigInt(d[1]) ** 2n);
}

/** Remove intervals from an interval: what is left, in order. */
function subtract(from: number, to: number, cuts: readonly (readonly [number, number])[]): [number, number][] {
  let parts: [number, number][] = [[from, to]];
  for (const [a, b] of cuts) {
    const next: [number, number][] = [];
    for (const [x, y] of parts) {
      if (b <= x || a >= y) next.push([x, y]);
      else {
        if (a > x) next.push([x, a]);
        if (b < y) next.push([b, y]);
      }
    }
    parts = next;
  }
  return parts;
}

/** How near a face casework stands to count as along it: 2". */
const COUNTER_REACH = 65_024;

/** How far P is from a wall face's line, into the room (negative: behind the face), rounded toward zero. */
function intoRoom(p: Point, f: Point, d: Point, len: bigint, side: 'left' | 'right'): number {
  // The room is to the left of the location line walked start to end for the left face (Core 13.3).
  const cross = BigInt(d[0]) * BigInt(p[1] - f[1]) - BigInt(d[1]) * BigInt(p[0] - f[0]);
  return Number((side === 'left' ? cross : -cross) / len);
}

/**
 * Whether a facing (Core 13.1, microdegrees) points into the room off a wall face — within 45° of the
 * face's normal into the room: dot(F, n) > 0 and 2·dot² > |F|²·|n|², exactly.
 */
function facesInto(facing: number, d: Point, side: 'left' | 'right'): boolean {
  const [fx, fy] = facingVector(facing);
  const n: [bigint, bigint] = side === 'left' ? [BigInt(-d[1]), BigInt(d[0])] : [BigInt(d[1]), BigInt(-d[0])];
  const dot = fx * n[0] + fy * n[1];
  return dot > 0n && 2n * dot * dot > (fx * fx + fy * fy) * (n[0] * n[0] + n[1] * n[1]);
}

const centroid = (ps: readonly Point[]): Point => [Math.round(ps.reduce((a, p) => a + p[0], 0) / ps.length), Math.round(ps.reduce((a, p) => a + p[1], 0) / ps.length)];

function insideRoom(p: Point, outer: readonly Point[], holes: readonly (readonly Point[])[]): boolean {
  const q: [bigint, bigint] = [BigInt(p[0]), BigInt(p[1])];
  const ring = (r: readonly Point[]) => r.map(([x, y]) => [BigInt(x), BigInt(y)] as [bigint, bigint]);
  return predicates.locate(q, ring(outer)) === 'inside' && holes.every((h) => predicates.locate(q, ring(h)) === 'outside');
}

/** A point strictly inside a room polygon: its centroid on the grid if that is inside, else a grid search. */
function centreOf(outer: readonly Point[], holes: readonly (readonly Point[])[], grid: number): Point | null {
  const inside = (p: Point) => insideRoom(p, outer, holes);
  let a = 0n;
  let cx = 0n;
  let cy = 0n;
  for (let i = 0; i < outer.length; i++) {
    const [x0, y0] = outer[i]!;
    const [x1, y1] = outer[(i + 1) % outer.length]!;
    const c = BigInt(x0) * BigInt(y1) - BigInt(x1) * BigInt(y0);
    a += c;
    cx += (BigInt(x0) + BigInt(x1)) * c;
    cy += (BigInt(y0) + BigInt(y1)) * c;
  }
  const g = BigInt(grid);
  if (a !== 0n) {
    const p: Point = [Number(((cx / (3n * a)) / g) * g), Number(((cy / (3n * a)) / g) * g)];
    if (inside(p)) return p;
  }
  const xs = outer.map((p) => p[0]);
  const ys = outer.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (let n = 2; n <= 32; n *= 2)
    for (let i = 1; i < n; i++)
      for (let j = 1; j < n; j++) {
        const p: Point = [Math.floor((x0 + ((x1 - x0) * i) / n) / grid) * grid, Math.floor((y0 + ((y1 - y0) * j) / n) / grid) * grid];
        if (inside(p)) return p;
      }
  return null;
}

/** Read a plan: valid under the official extensions, or a PlanError that says why not. */
export function readPlan(
  input: string | Uint8Array | FloorspecDocument | object,
  options: { level?: string | undefined; rooms?: readonly string[] | undefined; grid: number; counterCategories?: readonly string[] | undefined },
): PlanReading {
  const evaluation = evaluate(input, OFFICIAL_READER);
  if (!evaluation.valid || evaluation.view === undefined || evaluation.analysis === undefined) {
    const codes = [...new Set(evaluation.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code))];
    throw new PlanError(`the plan is not valid (${codes.join(', ')}): fix it before laying out its electrical`);
  }
  // The primary design's view (Core 0.3, 19.3): the document itself when it has no design options.
  const doc = evaluation.view;
  const derived = deriveEvaluation(evaluation);
  if (options.level !== undefined && !Object.hasOwn(doc.levels ?? {}, options.level)) throw new PlanError(`there is no level ${options.level}`);
  for (const r of options.rooms ?? []) if (!Object.hasOwn(doc.rooms ?? {}, r)) throw new PlanError(`there is no room ${r}`);

  // FS_electrical's elements by room, as it derives them — empty when the plan does not use it. A
  // plan FS_electrical 0.1.0 does not evaluate (Core 0.3) gets the same rooms from Core's geometry.
  const electricalRooms = derived.extensions?.FS_electrical?.rooms ?? officialElementRooms(doc, evaluation.analysis, 'FS_electrical');
  const pos = (j: string): Point => doc.junctions![j]!.position;

  // Receptacles hosted on wall faces.
  const onFace = new Map<string, { id: string; offset: number }[]>();
  for (const x of extElements(doc)) {
    const h = x.element.host;
    if (x.extension !== 'FS_electrical' || x.collection !== 'receptacles' || h?.mode !== 'wallFace') continue;
    const key = `${h.wall}/${h.side}`;
    onFace.set(key, [...(onFace.get(key) ?? []), { id: x.id, offset: h.offset }]);
  }

  // Counter casework (FS_furniture 2.4): its footprint as derived (Core 13.2), by level.
  const categories = options.counterCategories ?? [];
  const casework: { id: string; level: string; footprint: readonly Point[]; facing: number | undefined }[] = [];
  for (const x of extElements(doc)) {
    if (x.extension !== 'FS_furniture' || x.collection !== 'casework') continue;
    const category = (x.element as unknown as Json)['category'];
    const fb = derived.fallbacks?.[x.id];
    if (typeof category !== 'string' || !categories.includes(category) || fb === undefined) continue;
    casework.push({ id: x.id, level: fb.level, footprint: fb.footprint, facing: derived.placements?.[x.id]?.facing });
  }

  const rooms: RoomPlan[] = [];
  const roomIds = Object.keys(doc.rooms ?? {}).sort(cmp);
  for (const rid of roomIds) {
    const room = doc.rooms![rid]!;
    if (options.rooms !== undefined && !options.rooms.includes(rid)) continue;
    if (options.level !== undefined && room.level !== options.level) continue;
    const la = evaluation.analysis.levels.get(room.level);
    const face = la?.roomFaces.get(rid);
    const polygon = derived.rooms[rid];
    if (la?.geometry === undefined || face === undefined || polygon === undefined) continue;
    const g = la.geometry;
    const f = g.faces[face]!;
    const runs: WallRun[] = [];
    const entries: Entry[] = [];
    // An open side — a separator — is an entry too: its junctions, where a wall run meets it.
    const open = new Map<string, string>();
    for (const cycle of [f.outer, ...f.inner])
      for (const h of cycle.halfEdges) {
        const e = g.edges[h >> 1]!;
        if (e.kind === 'separator') for (const j of [e.start, e.end]) if (!open.has(j)) open.set(j, e.id);
      }
    const openEntries: Entry[] = [];
    const counters: CounterSpan[] = [];
    const curved: string[] = [];
    const mine = casework.filter((c) => c.level === room.level);
    for (const cycle of [f.outer, ...f.inner]) {
      for (const h of cycle.halfEdges) {
        const e = g.edges[h >> 1]!;
        if (e.kind !== 'wall') continue;
        // A segment of an arc wall is `<id>~<k>` in the level graph (Core 21.3), not a wall of the
        // document: a run is a straight stretch of one wall's face, so a curve gets none.
        if (e.src !== undefined) {
          if (!curved.includes(e.src)) curved.push(e.src);
          continue;
        }
        const wall = doc.walls![e.id]!;
        // The room is on the half-edge's left: the wall's left face when the half-edge runs its way.
        const side: 'left' | 'right' = ((h & 1) === 0) === (e.start === wall.start) ? 'left' : 'right';
        const s = pos(wall.start);
        const t = pos(wall.end);
        const d: Point = [t[0] - s[0], t[1] - s[1]];
        const len = lengthOf(d);
        if (len === 0n) continue;
        const outline = derived.walls[e.id];
        if (outline === undefined) continue;
        const [fa, fb] = side === 'left' ? [outline.startLeft, outline.endLeft] : [outline.startRight, outline.endRight];
        const L = Number(len);
        const clamp = (v: number) => Math.min(L, Math.max(0, v));
        const a = clamp(offsetAlong(fa, s, d, len));
        const b = clamp(offsetAlong(fb, s, d, len));
        const cuts: [number, number][] = [];
        for (const [oid, o] of Object.entries(doc.openings ?? {}).sort(([x], [y]) => cmp(x, y))) {
          if (o === undefined || o.wall !== e.id) continue;
          const fill = o.fill === undefined ? undefined : doc.types?.[o.fill];
          if (fill?.kind === 'windowType') continue;
          const width = o.width ?? (fill !== undefined && fill.kind !== 'wallType' ? fill.width : undefined) ?? 0;
          cuts.push([o.offset, o.offset + width]);
          entries.push({ room: rid, opening: oid, wall: e.id, side, from: o.offset, to: o.offset + width, hinge: fill?.kind === 'doorType' ? (o.hinge ?? 'start') : null });
        }
        // Casework against this face: a corner of it within COUNTER_REACH of the face, none behind it,
        // and its back to the face — facing into the room — so a cabinet whose end only touches a
        // wall, a vanity in a corner say, is no counter along that wall.
        for (const c of mine) {
          const into = c.footprint.map((p) => intoRoom(p, fa, d, len, side));
          if (Math.min(...into) > COUNTER_REACH || Math.min(...into) < -COUNTER_REACH) continue;
          if (c.facing !== undefined && !facesInto(c.facing, d, side)) continue;
          const along = c.footprint.map((p) => clamp(offsetAlong(p, s, d, len)));
          const from = Math.max(Math.min(...along), Math.min(a, b));
          const to = Math.min(Math.max(...along), Math.max(a, b));
          if (to > from) counters.push({ wall: e.id, side, from, to, casework: c.id });
        }
        const parts = subtract(Math.min(a, b), Math.max(a, b), cuts);
        for (const [x, y] of parts) runs.push({ room: rid, wall: e.id, side, from: x, to: y });
        const first = parts[0];
        const last = parts[parts.length - 1];
        const sepAtStart = open.get(wall.start);
        const sepAtEnd = open.get(wall.end);
        if (sepAtStart !== undefined && first !== undefined && first[0] === Math.min(a, b)) openEntries.push({ room: rid, opening: sepAtStart, wall: e.id, side, from: first[0], to: first[0], hinge: null });
        if (sepAtEnd !== undefined && last !== undefined && last[1] === Math.max(a, b)) openEntries.push({ room: rid, opening: sepAtEnd, wall: e.id, side, from: last[1], to: last[1], hinge: null });
      }
    }
    runs.sort((x, y) => cmp(x.wall, y.wall) || cmp(x.side, y.side) || x.from - y.from);
    // Doors and cased openings first, then open sides, each by ID and then by where they are.
    entries.sort((x, y) => cmp(x.opening, y.opening) || x.from - y.from);
    openEntries.sort((x, y) => cmp(x.opening, y.opening) || cmp(x.wall, y.wall) || x.from - y.from);
    entries.push(...openEntries);
    rooms.push({
      id: rid,
      name: room.name ?? rid,
      function: room.function ?? 'unspecified',
      level: room.level,
      runs,
      entries,
      centre: centreOf(polygon.outer, polygon.holes, options.grid),
      devices: electricalRooms[rid] ?? [],
      counters: counters.sort((x, y) => cmp(x.wall, y.wall) || cmp(x.side, y.side) || x.from - y.from || cmp(x.casework, y.casework)),
      hasCounters: counters.length > 0 || mine.some((c) => insideRoom(centroid(c.footprint), polygon.outer, polygon.holes)),
      curved: curved.sort(cmp),
    });
  }
  return { document: doc, evaluation, derived, rooms, receptaclesOn: (wall, side) => [...(onFace.get(`${wall}/${side}`) ?? [])].sort((a, b) => a.offset - b.offset || cmp(a.id, b.id)) };
}

/** Every ID the document uses, records included: what a new element or circuit must not be called. */
export function usedIds(doc: FloorspecDocument): Set<string> {
  const used = new Set<string>();
  for (const [key, c] of Object.entries(doc as unknown as Json)) {
    if (key === 'extensions' || key === 'program' || !isObject(c)) continue;
    for (const k of Object.keys(c)) used.add(k);
  }
  const items = (doc.program as Json | undefined)?.['items'];
  if (isObject(items)) for (const k of Object.keys(items)) used.add(k);
  for (const data of Object.values((doc.extensions ?? {}) as Json)) {
    if (!isObject(data)) continue;
    for (const [member, value] of Object.entries(data)) {
      if (!isObject(value)) continue;
      if (member === 'collections') {
        for (const coll of Object.values(value)) if (isObject(coll)) for (const k of Object.keys(coll)) used.add(k);
      } else for (const k of Object.keys(value)) used.add(k);
    }
  }
  return used;
}
