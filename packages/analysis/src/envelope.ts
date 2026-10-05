/**
 * The thermal envelope of one design, read from the engine's evaluation — nothing here re-derives
 * geometry the engine derives.
 *
 * - **Rooms** are conditioned unless their function is `garage` or `exterior` (Core 4.1). Their area
 *   is Core's net area (6.4); their volume is that area times the mean of the ceiling's low and high
 *   above the floor's top (15.1, 15.5).
 * - **A wall side** faces a room (the room whose face it bounds, 18.6), the outside (the level's
 *   unbounded face, 6.1), or neither (a bounded face with no room: a stair well, an open-to-below).
 *   A wall is in the envelope when one side faces a conditioned room, or a void (taken as heated
 *   air), and the other the outside or an unconditioned room. Its area is its outside face's length (the derived face ends, 5.7) times its
 *   height (5.9), gross; its openings come off it.
 * - **Which way it faces** is its outward normal, turned by the site's `trueNorth` (1.8) to a bearing
 *   clockwise from true north, and binned N/E/S/W by 90° sectors centred on each.
 * - **Openings** in an envelope wall: windows and doors by their fill's type kind (8.4), the unit's
 *   width × height (7.2), and its declared clear opening (7.4), the operable area, when there is one.
 * - **Ceilings** to the roof: each level's conditioned area not covered by the next level up in the
 *   same building, compared by area, in plan. **The ground floor** is the lowest level of each
 *   building, whose outside walls' length is the slab edge.
 */
import {
  deriveEvaluation,
  facingRooms,
  openingDimensions,
  effectiveClearOpening,
  type Evaluation,
  type FloorspecDocument,
  type Derived,
} from '@floorspec/engine';

/** Base units (1/1280 mm) in a metre. */
export const UNITS_PER_METRE = 1_280_000;
const m = (units: number): number => units / UNITS_PER_METRE;
const m2 = (units2: number): number => units2 / UNITS_PER_METRE / UNITS_PER_METRE;

export type Orientation = 'N' | 'E' | 'S' | 'W';
export const ORIENTATIONS: readonly Orientation[] = ['N', 'E', 'S', 'W'];

/** A bearing (degrees clockwise from true north) to its façade. */
export function orientationOf(bearing: number): Orientation {
  const b = ((bearing % 360) + 360) % 360;
  if (b >= 315 || b < 45) return 'N';
  if (b < 135) return 'E';
  if (b < 225) return 'S';
  return 'W';
}

/** Unconditioned room functions (Core 4.1). */
export const UNCONDITIONED = new Set(['garage', 'exterior']);
/** Rooms people spend time in, for the ventilation notes. */
export const HABITABLE = new Set(['sleeping', 'living', 'dining', 'kitchen', 'office']);

export interface EnvelopeRoom {
  readonly id: string;
  readonly name?: string;
  readonly function: string;
  readonly level: string;
  readonly conditioned: boolean;
  /** m². */
  readonly area: number;
  /** m³. */
  readonly volume: number;
}

export interface EnvelopeWall {
  readonly id: string;
  readonly name?: string;
  readonly level: string;
  /** The wall's type ID, or undefined for a wall with its own layers or none. */
  readonly type?: string;
  /** The conditioned room it bounds; absent for a wall of a void (a stair well, an open-to-below). */
  readonly room?: string;
  /** What is on its other side. */
  readonly toward: 'outside' | 'unconditioned';
  /** The unconditioned room on its other side, when there is one. */
  readonly otherRoom?: string;
  /** Metres: the outside face. */
  readonly length: number;
  readonly height: number;
  /** m², gross. */
  readonly gross: number;
  /** The outward normal's bearing, degrees clockwise from true north. */
  readonly facing: number;
  readonly orientation: Orientation;
}

export interface EnvelopeOpening {
  readonly id: string;
  readonly name?: string;
  readonly wall: string;
  readonly kind: 'window' | 'door' | 'opening';
  /** The fill's operation (8.4), when it declares one. */
  readonly operation?: string;
  /** A window that opens: its operation is not `fixed`, or (with none declared) it declares a clear opening. */
  readonly operable: boolean;
  /** m². */
  readonly area: number;
  /** m²: the declared clear opening (7.4) — its area, or width × height. */
  readonly clearArea?: number;
  /** The room it serves; absent in a wall of a void. */
  readonly room?: string;
  readonly toward: 'outside' | 'unconditioned';
  readonly facing: number;
  readonly orientation: Orientation;
}

export interface EnvelopeCeiling {
  readonly building: string;
  readonly level: string;
  /** m², in plan. */
  readonly area: number;
  /** The level has a vaulted ceiling over some of it: its true area is larger than in plan. */
  readonly vaulted: boolean;
}

export interface EnvelopeSlab {
  readonly building: string;
  readonly level: string;
  /** Metres of outside wall along the lowest level. */
  readonly edge: number;
  /** m² of conditioned floor on it. */
  readonly area: number;
}

export interface Envelope {
  readonly rooms: EnvelopeRoom[];
  readonly walls: EnvelopeWall[];
  readonly openings: EnvelopeOpening[];
  readonly ceilings: EnvelopeCeiling[];
  readonly slabs: EnvelopeSlab[];
  /** m². */
  readonly conditionedArea: number;
  /** m³. */
  readonly volume: number;
  /** Degrees, counter-clockwise from project north to true north (1.8). */
  readonly trueNorth: number;
  /** Degrees north, when the site has a location. */
  readonly latitude?: number;
  /** Openings in the envelope with no width or height to measure (left out). */
  readonly unmeasured: string[];
}

const hasName = (name: string | undefined): { name?: string } => (name === undefined ? {} : { name });

/** The envelope of an evaluated design: `ev` is a valid evaluation whose view is derived. */
export function envelopeOf(ev: Evaluation, derived: Derived = deriveEvaluation(ev)): Envelope {
  const doc = ev.view as FloorspecDocument;
  const analysis = ev.analysis!;
  const trueNorth = (doc.site?.trueNorth ?? 0) / 1e6;
  const latitude = doc.site?.location === undefined ? undefined : doc.site.location.latitude / 1e6;

  // Rooms.
  const rooms = new Map<string, EnvelopeRoom>();
  for (const id of Object.keys(doc.rooms ?? {}).sort()) {
    const r = doc.rooms![id]!;
    const poly = derived.rooms[id];
    if (poly === undefined) continue;
    const level = doc.levels?.[r.level];
    const area = m2(Number(poly.area));
    const floorTop = derived.floors?.[id]?.top ?? level?.elevation ?? 0;
    const c = derived.ceilings?.[id];
    const height = c === undefined ? (level?.ceilingHeight ?? level?.height ?? 0) : (c.low + c.high) / 2 - floorTop;
    const fn = r.function ?? 'unspecified';
    rooms.set(id, { id, ...hasName(r.name), function: fn, level: r.level, conditioned: !UNCONDITIONED.has(fn), area, volume: area * Math.max(0, m(height)) });
  }

  // What each wall side faces.
  const facing = facingRooms(analysis.levels);
  const outside = new Set<string>();
  for (const [, la] of analysis.levels) {
    const g = la.geometry;
    if (!g) continue;
    for (const c of g.graph.unbounded)
      for (const h of c.halfEdges) {
        const e = g.edges[h >> 1]!;
        if (e.kind === 'wall') outside.add(`${e.id}/${(h & 1) === 0 ? 'left' : 'right'}`);
      }
  }

  const walls: EnvelopeWall[] = [];
  for (const id of Object.keys(doc.walls ?? {}).sort()) {
    const w = doc.walls![id]!;
    const d = derived.walls[id];
    if (d === undefined) continue;
    const side = (s: 'left' | 'right'): { kind: 'room'; room: EnvelopeRoom } | { kind: 'outside' } | { kind: 'none' } => {
      const rid = facing.get(`${id}/${s}`);
      const room = rid === undefined ? undefined : rooms.get(rid);
      if (room) return { kind: 'room', room };
      return outside.has(`${id}/${s}`) ? { kind: 'outside' } : { kind: 'none' };
    };
    const L = side('left');
    const R = side('right');
    let inner: 'left' | 'right' | undefined;
    let toward: 'outside' | 'unconditioned' | undefined;
    let otherRoom: string | undefined;
    for (const [a, b, s] of [[L, R, 'left'], [R, L, 'right']] as const) {
      // A side in a bounded face with no room is a void inside the house — heated air.
      if (a.kind === 'outside' || (a.kind === 'room' && !a.room.conditioned)) continue;
      if (b.kind === 'outside') { inner = s; toward = 'outside'; break; }
      if (b.kind === 'room' && !b.room.conditioned) { inner = s; toward = 'unconditioned'; otherRoom = b.room.id; break; }
    }
    if (inner === undefined || toward === undefined) continue;
    const out = inner === 'left' ? 'right' : 'left';
    const [p, q] = out === 'left' ? [d.startLeft, d.endLeft] : [d.startRight, d.endRight];
    const length = m(Math.hypot(q[0] - p[0], q[1] - p[1]));
    const height = m(d.topElevation - d.baseElevation);
    const j0 = doc.junctions![w.start]!.position;
    const j1 = doc.junctions![w.end]!.position;
    const dx = j1[0] - j0[0];
    const dy = j1[1] - j0[1];
    // The left normal is (−dy, dx); the outward one points to the outside side.
    const [nx, ny] = out === 'left' ? [-dy, dx] : [dy, -dx];
    const bearing = ((Math.atan2(nx, ny) / Math.PI) * 180 + trueNorth + 720) % 360;
    const inside = inner === 'left' ? L : R;
    walls.push({
      id,
      ...hasName(w.name),
      level: w.level,
      ...(w.type === undefined ? {} : { type: w.type }),
      ...(inside.kind === 'room' ? { room: inside.room.id } : {}),
      toward,
      ...(otherRoom === undefined ? {} : { otherRoom }),
      length,
      height,
      gross: length * height,
      facing: bearing,
      orientation: orientationOf(bearing),
    });
  }

  // Openings in envelope walls.
  const byWall = new Map(walls.map((w) => [w.id, w]));
  const openings: EnvelopeOpening[] = [];
  const unmeasured: string[] = [];
  for (const id of Object.keys(doc.openings ?? {}).sort()) {
    const o = doc.openings![id]!;
    const w = byWall.get(o.wall);
    if (w === undefined) continue;
    const dims = openingDimensions(doc, o);
    if (dims.width === undefined || dims.height === undefined) {
      unmeasured.push(id);
      continue;
    }
    const fill = o.fill === undefined ? undefined : doc.types?.[o.fill];
    const kind = fill?.kind === 'windowType' ? 'window' : fill?.kind === 'doorType' ? 'door' : 'opening';
    const operation = fill !== undefined && fill.kind !== 'wallType' ? (fill.operation as string | undefined) : undefined;
    const clear = effectiveClearOpening(doc, o);
    const clearArea = clear === undefined ? undefined : clear.area !== undefined ? m2(clear.area) : m2(clear.width * clear.height);
    const operable = kind === 'window' && (operation === undefined ? clear !== undefined : operation !== 'fixed');
    openings.push({
      id,
      ...hasName(o.name),
      wall: w.id,
      kind,
      ...(operation === undefined ? {} : { operation }),
      operable,
      area: m2(dims.width * dims.height),
      ...(clearArea === undefined ? {} : { clearArea }),
      ...(w.room === undefined ? {} : { room: w.room }),
      toward: w.toward,
      facing: w.facing,
      orientation: w.orientation,
    });
  }

  // Ceilings and the ground floor, per building, by level elevation.
  const levelsOf = new Map<string, { id: string; elevation: number }[]>();
  for (const id of Object.keys(doc.levels ?? {}).sort()) {
    const l = doc.levels![id]!;
    levelsOf.set(l.building, [...(levelsOf.get(l.building) ?? []), { id, elevation: l.elevation }]);
  }
  const conditionedOn = (level: string): number => [...rooms.values()].filter((r) => r.level === level && r.conditioned).reduce((s, r) => s + r.area, 0);
  const vaultedOn = (level: string): boolean => [...rooms.values()].some((r) => r.level === level && r.conditioned && derived.ceilings?.[r.id]?.kind === 'vaulted');
  const ceilings: EnvelopeCeiling[] = [];
  const slabs: EnvelopeSlab[] = [];
  for (const [building, ls] of [...levelsOf].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const sorted = [...ls].sort((a, b) => a.elevation - b.elevation || (a.id < b.id ? -1 : 1));
    const areas = sorted.map((l) => conditionedOn(l.id));
    sorted.forEach((l, i) => {
      const exposed = Math.max(0, areas[i]! - (areas[i + 1] ?? 0));
      if (exposed > 0) ceilings.push({ building, level: l.id, area: exposed, vaulted: vaultedOn(l.id) });
    });
    const lowest = sorted.find((_, i) => areas[i]! > 0);
    if (lowest !== undefined) {
      const edge = walls.filter((w) => w.level === lowest.id && w.toward === 'outside').reduce((s, w) => s + w.length, 0);
      slabs.push({ building, level: lowest.id, edge, area: conditionedOn(lowest.id) });
    }
  }

  const conditioned = [...rooms.values()].filter((r) => r.conditioned);
  return {
    rooms: [...rooms.values()],
    walls,
    openings,
    ceilings,
    slabs,
    conditionedArea: conditioned.reduce((s, r) => s + r.area, 0),
    volume: conditioned.reduce((s, r) => s + r.volume, 0),
    trueNorth,
    ...(latitude === undefined ? {} : { latitude }),
    unmeasured,
  };
}
