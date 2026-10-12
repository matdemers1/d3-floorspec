/**
 * The plan as staging reads it: for each room its polygon, floor and ceiling, its wall faces — each
 * with the windows in it and where it is free — its entries and the swings of its doors, the
 * furniture in it with each piece's frame and group, and everything a new item must keep out of:
 * furniture, every clearance envelope, fixtures and devices, stairs. All from the engine's
 * evaluation (FLR-ADR-010), through the electrical assistant's reading of wall runs and entries.
 */
import { direction, extElements, furniture, type Derived, type FloorspecDocument } from '@floorspec/engine';
import { readPlan, type RoomPlan } from '@floorspec/assistant-electrical';
import { frameAt, MM, toPlan, type Frame, type P, type Solid } from './geometry.js';

type Json = Record<string, unknown>;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A wall face that looks into a room: a straight wall's left or right face, its line on the plan. */
export interface Face {
  readonly wall: string;
  readonly side: 'left' | 'right';
  /** The wall's start junction, and its direction (unit) and length along its location line. */
  readonly start: P;
  readonly dir: P;
  readonly length: number;
  /** Into the room, unit; and the same as an integer vector, for an exact facing. */
  readonly inward: P;
  /** Microdegrees: the facing of something standing against the face, looking into the room. */
  readonly facing: number;
  /** How far the face stands from the location line, into the room. */
  readonly offset: number;
  /** The wall's top, absolute: nothing hangs above it — a guard rail is no place for a picture. */
  readonly top: number;
}

/** A point on a face: `at` along the wall's location line, `out` from the face into the room. */
export const onFace = (f: Face, at: number, out = 0): P => [f.start[0] + f.dir[0] * at + f.inward[0] * (f.offset + out), f.start[1] + f.dir[1] * at + f.inward[1] * (f.offset + out)];

/** The frame of something whose back is against a face, its middle at `at`, `out` from it. */
export const faceFrame = (f: Face, at: number, out = 0): Frame => frameAt(onFace(f, at, out), f.facing);

/** Where along a face a plan point is (its offset along the location line), and how far out of the face. */
export function alongFace(f: Face, p: P): { at: number; out: number } {
  const dx = p[0] - f.start[0];
  const dy = p[1] - f.start[1];
  return { at: dx * f.dir[0] + dy * f.dir[1], out: dx * f.inward[0] + dy * f.inward[1] - f.offset };
}

/** A window or door in a wall: its span along the wall, and its sill and head above the room's floor. */
export interface Hole {
  readonly id: string;
  readonly kind: 'window' | 'door' | 'opening';
  readonly wall: string;
  readonly from: number;
  readonly to: number;
  readonly sill: number;
  readonly head: number;
}

/** A stretch of a face in the room, between corners and doors (windows lie within it). */
export interface Run {
  readonly face: Face;
  readonly from: number;
  readonly to: number;
}

/** A piece of furniture in the plan, as staging reads it. */
export interface Piece {
  readonly id: string;
  readonly collection: string;
  readonly category: string;
  /** The element it is grouped by (FS_furniture 4.3): its `with`, or itself. */
  readonly root: string;
  readonly room: string | null;
  readonly level: string;
  readonly frame: Frame;
  /** Its box in its frame, base units. */
  readonly box: { readonly min: readonly number[]; readonly max: readonly number[] };
  readonly solid: Solid;
  /** For decor already in the plan — an `other` piece placed from the starter library — its library item. */
  readonly decor?: string;
}

/** Something a new item keeps out of, and whose: its group root when it is FS_furniture's or one of its envelopes. */
export interface Obstacle extends Solid {
  readonly owner: string;
  /** For FS_furniture and its envelopes: the group (4.3) — an item of that group may overlap it. */
  readonly group: string | null;
  readonly what: 'furniture' | 'envelope' | 'fixture' | 'device' | 'stair' | 'entry' | 'decor';
}

export interface StagingRoom {
  readonly id: string;
  readonly name: string;
  readonly function: string;
  readonly level: string;
  readonly plan: RoomPlan;
  readonly outer: readonly P[];
  readonly holes: readonly (readonly P[])[];
  /** The floor's top and the ceiling's lowest point, absolute. */
  readonly floor: number;
  readonly ceiling: number;
  readonly runs: readonly Run[];
  readonly holesInWalls: readonly Hole[];
  readonly pieces: readonly Piece[];
  /** Plan points of the receptacles that serve the room (FS_electrical's, in it). */
  readonly receptacles: readonly P[];
  /** The area of its polygon, base units squared. */
  readonly area: number;
  /** The rooms open to it across a separator (an open plan's kitchen beside its great room): a rug may reach into them. */
  open: string[];
}

export interface Reading {
  readonly document: FloorspecDocument;
  readonly derived: Derived;
  readonly rooms: StagingRoom[];
  /** Everything on each level a new item keeps out of. */
  readonly obstacles: ReadonlyMap<string, Obstacle[]>;
  /** Every FS_furniture piece by ID. */
  readonly pieces: ReadonlyMap<string, Piece>;
  /** Whether the plan uses FS_electrical: then a lamp goes only within a cord's reach of a receptacle. */
  readonly electrical: boolean;
}

/** The faces of a room's runs, by wall and side, computed once. */
function faceOf(doc: FloorspecDocument, derived: Derived, wall: string, side: 'left' | 'right'): Face | null {
  const w = doc.walls?.[wall];
  if (w === undefined) return null;
  const s = doc.junctions![w.start]!.position;
  const e = doc.junctions![w.end]!.position;
  const dx = e[0] - s[0];
  const dy = e[1] - s[1];
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) return null;
  const n: [number, number] = side === 'left' ? [-dy, dx] : [dy, -dx];
  const inward: P = [n[0] / length, n[1] / length];
  const outline = derived.walls[wall];
  if (outline === undefined) return null;
  const f0 = side === 'left' ? outline.startLeft : outline.startRight;
  const offset = (f0[0] - s[0]) * inward[0] + (f0[1] - s[1]) * inward[1];
  return { wall, side, start: [s[0], s[1]], dir: [dx / length, dy / length], length, inward, facing: direction(BigInt(n[0]), BigInt(n[1])), offset, top: outline.topElevation };
}

/** The windows and doors of a wall, their sills and heads above `floor`. */
function holesOf(doc: FloorspecDocument, derived: Derived, wall: string, floor: number): Hole[] {
  const types = (doc.types ?? {}) as Record<string, { kind?: string; width?: number } | undefined>;
  return Object.entries((doc.openings ?? {}) as Record<string, { wall?: string; offset?: number; width?: number; fill?: string } | undefined>)
    .flatMap(([id, o]): Hole[] => {
      if (o?.wall !== wall || typeof o.offset !== 'number') return [];
      const t = o.fill === undefined ? undefined : types[o.fill];
      const kind: Hole['kind'] = t?.kind === 'windowType' ? 'window' : t?.kind === 'doorType' ? 'door' : 'opening';
      const width = o.width ?? (t?.kind === 'wallType' ? undefined : t?.width) ?? 0;
      const d = derived.openings[id];
      return [{ id, kind, wall, from: o.offset, to: o.offset + width, sill: (d?.sillElevation ?? floor) - floor, head: (d?.headElevation ?? floor + 2100 * MM) - floor }];
    })
    .sort((a, b) => a.from - b.from || cmp(a.id, b.id));
}

const solidOf = (f: { footprint: readonly (readonly [number, number])[]; bottom: number; top: number }): Solid => ({ poly: f.footprint.map((p): P => [p[0], p[1]]), bottom: f.bottom, top: f.top });

/** Read a plan for staging: valid under the official extensions, else the electrical reader's PlanError. */
export function readStaging(input: string | Uint8Array | FloorspecDocument | object): Reading {
  // Every room: one staged may reach into another open to it.
  const plan = readPlan(input, { grid: MM });
  const doc = plan.document;
  const derived = plan.derived;
  const furnitureItems = derived.extensions?.FS_furniture?.items ?? {};
  const electricalRooms = derived.extensions?.FS_electrical?.rooms ?? {};

  // Every FS_furniture element: its frame, box and group.
  const pieces = new Map<string, Piece>();
  for (const x of extElements(doc)) {
    if (x.extension !== 'FS_furniture') continue;
    const el = x.element as unknown as Json;
    const fb = derived.fallbacks?.[x.id];
    const pl = derived.placements?.[x.id];
    const box = (el['fallback'] as Json | undefined)?.['box'] as Piece['box'] | undefined;
    if (fb === undefined || pl === undefined || box === undefined) continue;
    const asset = (el['fallback'] as Json | undefined)?.['asset'];
    const assets = (doc.assets ?? {}) as Record<string, { sha256?: unknown } | undefined>;
    const item = el['category'] === 'other' && typeof asset === 'string' && Object.hasOwn(assets, asset) ? furniture.starterLibraryItem(assets[asset]?.sha256) : undefined;
    pieces.set(x.id, {
      ...(item === undefined ? {} : { decor: item }),
      id: x.id,
      collection: x.collection,
      category: typeof el['category'] === 'string' ? el['category'] : 'other',
      root: typeof el['with'] === 'string' ? el['with'] : x.id,
      room: furnitureItems[x.id]?.room ?? null,
      level: fb.level,
      frame: frameAt([pl.point[0], pl.point[1]], pl.facing),
      box,
      solid: solidOf(fb),
    });
  }

  // What a new item keeps out of, by level.
  const obstacles = new Map<string, Obstacle[]>();
  const add = (level: string, o: Obstacle) => obstacles.set(level, [...(obstacles.get(level) ?? []), o]);
  for (const id of Object.keys(derived.fallbacks ?? {}).sort(cmp)) {
    const fb = derived.fallbacks![id]!;
    const piece = pieces.get(id);
    // Decor already placed is in the way of anything new, grouped or not: staging twice adds nothing twice.
    if (piece !== undefined) add(fb.level, { ...piece.solid, owner: id, group: piece.decor === undefined ? piece.root : null, what: piece.decor === undefined ? 'furniture' : 'decor' });
    else add(fb.level, { ...solidOf(fb), owner: id, group: null, what: fb.extension === 'FS_electrical' ? 'device' : 'fixture' });
  }
  for (const owner of Object.keys(derived.clearances ?? {}).sort(cmp))
    for (const name of Object.keys(derived.clearances![owner]!).sort(cmp)) {
      const c = derived.clearances![owner]![name]!;
      add(c.level, { ...solidOf(c), owner, group: pieces.get(owner)?.root ?? null, what: 'envelope' });
    }
  for (const [sid, st] of Object.entries(derived.stairs ?? {}).sort(([a], [b]) => cmp(a, b))) {
    const s = (doc.stairs as Record<string, { level?: string } | undefined> | undefined)?.[sid];
    if (s?.level === undefined) continue;
    const [x0, y0, z0] = st.box.min;
    const [x1, y1, z1] = st.box.max;
    add(s.level, { poly: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], bottom: z0, top: z1, owner: sid, group: null, what: 'stair' });
  }

  const rooms: StagingRoom[] = [];
  for (const rp of plan.rooms) {
    const poly = derived.rooms[rp.id];
    if (poly === undefined) continue;
    const floor = derived.floors?.[rp.id]?.top ?? (doc.levels?.[rp.level]?.elevation ?? 0);
    const ceiling = derived.ceilings?.[rp.id]?.low ?? floor + 2400 * MM;
    const faces = new Map<string, Face>();
    const runs: Run[] = [];
    for (const r of rp.runs) {
      const key = `${r.wall}/${r.side}`;
      let face = faces.get(key);
      if (face === undefined) {
        const f = faceOf(doc, derived, r.wall, r.side);
        if (f === null) continue;
        face = f;
        faces.set(key, f);
      }
      runs.push({ face, from: r.from, to: r.to });
    }
    const walls = [...new Set(runs.map((r) => r.face.wall))].sort(cmp);
    const receptacles: P[] = [];
    const devices = new Set(electricalRooms[rp.id] ?? []);
    for (const x of extElements(doc)) {
      if (x.extension !== 'FS_electrical' || x.collection !== 'receptacles' || !devices.has(x.id)) continue;
      const fb = derived.fallbacks?.[x.id];
      if (fb === undefined) continue;
      const ring = fb.footprint;
      receptacles.push([(ring[0]![0] + ring[2]![0]) / 2, (ring[0]![1] + ring[2]![1]) / 2]);
    }
    const outer = poly.outer.map((p): P => [p[0], p[1]]);
    const holes = poly.holes.map((h) => h.map((p): P => [p[0], p[1]]));
    let a2 = 0;
    for (let i = 0; i < outer.length; i++) a2 += outer[i]![0] * outer[(i + 1) % outer.length]![1] - outer[(i + 1) % outer.length]![0] * outer[i]![1];
    rooms.push({
      id: rp.id,
      name: rp.name,
      function: rp.function,
      level: rp.level,
      plan: rp,
      outer,
      holes,
      floor,
      ceiling,
      runs,
      holesInWalls: walls.flatMap((w) => holesOf(doc, derived, w, floor)),
      pieces: [...pieces.values()].filter((p) => p.room === rp.id).sort((a, b) => cmp(a.id, b.id)),
      receptacles,
      area: Math.abs(a2) / 2,
      open: [],
    });
  }
  // Open neighbours: rooms entered from each other across one separator.
  const separators = new Set(Object.keys((doc.separators ?? {})));
  for (const room of rooms) {
    const mine = new Set(room.plan.entries.filter((e) => separators.has(e.opening)).map((e) => e.opening));
    room.open = rooms.filter((o) => o !== room && o.level === room.level && o.plan.entries.some((e) => mine.has(e.opening))).map((o) => o.id);
  }
  const used = (doc.extensionsUsed ?? {}) as Record<string, unknown>;
  return { document: doc, derived, rooms, obstacles, pieces, electrical: Object.hasOwn(used, 'FS_electrical') };
}

/** The entry zones of a room: in front of each door and opening, into the room — kept clear of anything standing. */
export function entryZones(room: StagingRoom): Obstacle[] {
  const out: Obstacle[] = [];
  for (const e of room.plan.entries) {
    const run = room.runs.find((r) => r.face.wall === e.wall && r.face.side === e.side);
    if (run === undefined) continue;
    const f = run.face;
    const a = Math.min(e.from, e.to) - 150 * MM;
    const b = Math.max(e.from, e.to) + 150 * MM;
    const depth = 1200 * MM;
    out.push({ poly: [onFace(f, a, -50 * MM), onFace(f, b, -50 * MM), onFace(f, b, depth), onFace(f, a, depth)], bottom: room.floor, top: room.floor + 2400 * MM, owner: e.opening, group: null, what: 'entry' });
  }
  return out;
}

/** A piece's local box corners on the plan, grown or shrunk by `d` on every side. */
export function pieceRect(p: Piece, d = 0): P[] {
  const [x0, y0] = p.box.min;
  const [x1, y1] = p.box.max;
  return [toPlan(p.frame, x0! - d, y0! - d), toPlan(p.frame, x1! + d, y0! - d), toPlan(p.frame, x1! + d, y1! + d), toPlan(p.frame, x0! - d, y1! + d)];
}

export { isObject };
