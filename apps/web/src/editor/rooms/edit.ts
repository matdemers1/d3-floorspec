import type { FaceView, LevelView, Point, Ring } from '../model';
import { faceAt, inRing, interiorPoint, signedArea } from '../geometry';
import type { Batch } from '../ops';
import type { UnitSystem } from '../units';

/**
 * Rooms you can grab (FLR-T-18.10; the board's "Rooms get handles too" card on frame 18.4). The
 * editor sends the Ops the standard already has for rooms — `resizeRoom` for an edge handle (Ops 4.4)
 * and `moveRoom` for the room dragged by its floor (Ops 4.3) — and `addRoom` for the magic wand. This
 * module is the geometry behind them, with no React and no store: which sides of a room's face a
 * handle can move, how far a drag moves one, and which faces a wand click could mean.
 */

export type Side = 'north' | 'south' | 'east' | 'west';
export const SIDES: readonly Side[] = ['north', 'east', 'south', 'west'];
/** Each side's unit vector, y up (Ops 4.4: east (1, 0), north (0, 1), west (−1, 0), south (0, −1)). */
export const SIDE_UNIT: Readonly<Record<Side, Point>> = { east: [1, 0], north: [0, 1], west: [-1, 0], south: [0, -1] };

export interface RoomSide {
  side: Side;
  /** Whether resizeRoom can move it: its edges face exactly that way, lie on one line and follow each other round the room. */
  ok: boolean;
  /** Why not, when it cannot — the words the applier's FS-OPS-008 uses. */
  why?: string;
  /** The middle of the side's run of edges on the room's floor outline: where its handle sits. */
  at: Point;
  /** The run's two ends, along the side. */
  from: Point;
  to: Point;
}

const EPS = 1e-6;

/** The face a room is anchored in, on its level. */
export function roomFace(level: LevelView, room: string): FaceView | undefined {
  return level.faces.find((f) => f.room === room);
}

/** The outward unit normal of edge a → b of a ring wound `ccw`, when it is exactly one of the four sides; else null. */
function sideOfEdge(a: Point, b: Point, ccw: boolean): Side | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  if (l === 0) return null;
  // The outward normal: right of a → b on a counter-clockwise ring, left on a clockwise one.
  const nx = ccw ? dy / l : -dy / l;
  const ny = ccw ? -dx / l : dx / l;
  if (Math.abs(ny) < EPS) return nx > 0 ? 'east' : 'west';
  if (Math.abs(nx) < EPS) return ny > 0 ? 'north' : 'south';
  return null;
}

/**
 * The four sides of a room as resizeRoom sees them (Ops 4.4), read from its floor outline: the edges
 * facing exactly that way must exist, lie on one line and be consecutive round the room. A side that
 * is missing gets no handle; one that is oblique or jogged gets a handle that says why it cannot move.
 */
export function roomSides(level: LevelView, room: string): RoomSide[] {
  const face = roomFace(level, room);
  if (face === undefined) return [];
  return sidesOfRing(face.outer);
}

export function sidesOfRing(ring: Ring): RoomSide[] {
  const n = ring.length;
  if (n < 3) return [];
  const ccw = signedArea(ring) > 0;
  const facing = ring.map((p, i) => sideOfEdge(p, ring[(i + 1) % n] as Point, ccw));
  const out: RoomSide[] = [];
  for (const side of SIDES) {
    const idx = facing.map((s, i) => (s === side ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 0) continue;
    const u = SIDE_UNIT[side];
    const coord = (p: Point) => p[0] * u[0] + p[1] * u[1];
    const along = (p: Point) => p[0] * u[1] - p[1] * u[0];
    const pts = idx.flatMap((i) => [ring[i] as Point, ring[(i + 1) % n] as Point]);
    const starts = idx.filter((i) => facing[(i - 1 + n) % n] !== side);
    const line = coord(pts[0] as Point);
    const collinear = pts.every((p) => Math.abs(coord(p) - line) <= 1);
    // The handle: on the side's line, at the middle of its run; a jogged side's at the middle of its longest edge.
    let a: Point;
    let b: Point;
    if (collinear) {
      const ts = pts.map(along);
      const lo = pts[ts.indexOf(Math.min(...ts))] as Point;
      const hi = pts[ts.indexOf(Math.max(...ts))] as Point;
      [a, b] = [lo, hi];
    } else {
      const longest = idx.reduce((best, i) => {
        const p = ring[i] as Point;
        const q = ring[(i + 1) % n] as Point;
        const lb = Math.hypot((ring[(best + 1) % n] as Point)[0] - (ring[best] as Point)[0], (ring[(best + 1) % n] as Point)[1] - (ring[best] as Point)[1]);
        return Math.hypot(q[0] - p[0], q[1] - p[1]) > lb ? i : best;
      }, idx[0] as number);
      [a, b] = [ring[longest] as Point, ring[(longest + 1) % n] as Point];
    }
    const at: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const why = !collinear ? 'is jogged: its edges do not lie on one line' : starts.length !== 1 ? 'is jogged: its edges are not consecutive' : undefined;
    out.push({ side, ok: why === undefined, ...(why === undefined ? {} : { why }), at, from: a, to: b });
  }
  return out;
}

/** The room's size across a side: its floor outline's extent along that side's axis. */
export function extentAcross(level: LevelView, room: string, side: Side): number {
  const face = roomFace(level, room);
  if (face === undefined) return 0;
  const xs = face.outer.map((p) => (SIDE_UNIT[side][0] !== 0 ? p[0] : p[1]));
  return xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs);
}

/** The smallest a handle may pull a room down to across a side: a foot, or 300 mm. */
export const minRoom = (units: UnitSystem): number => (units === 'metric' ? 384_000 : 390_144);

/**
 * How far a drag moves a side: the pointer's travel along the side's outward direction, on the grid
 * (free with ⇧, as an item's edge handle is — FLR-T-18.4), never pulling the room thinner than `min`.
 */
export function sideDrag(side: Side, from: Point, to: Point, o: { grid: number; free: boolean; extent: number; min: number }): number {
  const u = SIDE_UNIT[side];
  const raw = (to[0] - from[0]) * u[0] + (to[1] - from[1]) * u[1];
  const by = o.free ? Math.round(raw) : Math.round(raw / o.grid) * o.grid;
  const least = -Math.max(0, o.extent - o.min);
  return Math.max(least, by);
}

/** A room dragged by its floor: the pointer's travel on the grid (⌥ free, ⇧ along one axis — the group drag's keys, FLR-T-18.8). */
export function roomDrag(from: Point, to: Point, o: { grid: number; free: boolean; axis: boolean }): Point {
  let d: Point = [to[0] - from[0], to[1] - from[1]];
  if (o.axis) d = Math.abs(d[0]) >= Math.abs(d[1]) ? [d[0], 0] : [0, d[1]];
  if (!o.free) d = [Math.round(d[0] / o.grid) * o.grid, Math.round(d[1] / o.grid) * o.grid];
  return [Math.round(d[0]), Math.round(d[1])];
}

export const resizeRoom = (room: string, side: Side, by: number): Batch => [{ op: 'resizeRoom', room, side, by }];
export const moveRoom = (room: string, by: Point): Batch => [{ op: 'moveRoom', room, by: [by[0], by[1]] }];

// ─── The magic wand ──────────────────────────────────────────────────────────────────────────

/** A face the wand could make a room of: a point inside it (where addRoom anchors the room), and its outline. */
export interface Candidate {
  at: Point;
  face: FaceView;
  /** How it relates to the click: the space clicked, one around it or inside it, or one beside it. */
  how: 'here' | 'around' | 'inside' | 'beside';
}

/**
 * The faces a click with the magic wand could mean, the most likely first: the face under the point,
 * then the ones it is nested in or that are nested in it (a closet inside a room is a hole in the
 * room's face), then the faces beside it across one wall or separator, nearest first. Only faces with
 * no room yet — the wand makes rooms; it does not take one over.
 */
export function wandCandidates(level: LevelView, point: Point): Candidate[] {
  const here = faceAt(level, point);
  const out: Candidate[] = [];
  const seen = new Set<FaceView>();
  const push = (face: FaceView, how: Candidate['how']) => {
    if (seen.has(face)) return;
    seen.add(face);
    if (face.room !== null) return;
    const at = interiorPoint(face);
    if (at !== null) out.push({ at, face, how });
  };
  if (here !== undefined) push(here, 'here');
  // Around: faces whose outline holds the point in one of their holes, the nearest (smallest) first.
  const around = level.faces.filter((f) => f !== here && inRing(point, f.outer)).sort((a, b) => (a.area2 < b.area2 ? -1 : a.area2 > b.area2 ? 1 : 0));
  for (const f of around) push(f, 'around');
  const base = here ?? around[0];
  if (base === undefined) return out;
  // Inside: faces lying in one of the base face's holes.
  for (const f of level.faces) {
    if (f === base || base.holes.length === 0) continue;
    const p = interiorPoint(f);
    if (p !== null && base.holes.some((h) => inRing(p, h))) push(f, 'inside');
  }
  // Beside: across each edge of the base face, past the thickest wall there could be.
  const thick = [...new Set([0, ...level.walls.map((w) => Math.round(w.thickness))])].sort((a, b) => a - b);
  const beside: { face: FaceView; d: number }[] = [];
  for (const ring of [base.outer, ...base.holes]) {
    const ccw = signedArea(ring) > 0;
    const outward = ring === base.outer ? ccw : !ccw;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as Point;
      const b = ring[(i + 1) % ring.length] as Point;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l === 0) continue;
      const n: Point = outward ? [(b[1] - a[1]) / l, -(b[0] - a[0]) / l] : [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
      for (const t of [0.25, 0.5, 0.75]) {
        const m: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        for (const w of thick) {
          const probe: Point = [m[0] + n[0] * (w + 1024), m[1] + n[1] * (w + 1024)];
          const f = faceAt(level, probe);
          if (f === undefined) continue;
          if (f !== base) beside.push({ face: f, d: Math.hypot(probe[0] - point[0], probe[1] - point[1]) });
          break;
        }
      }
    }
  }
  beside.sort((x, y) => x.d - y.d);
  for (const { face } of beside) push(face, 'beside');
  return out;
}

/** The room function a name suggests (Core 6.3's functions), for the wand's prompt; null when it suggests none. */
export function functionFromName(name: string): string | null {
  const n = name.toLowerCase();
  const table: [RegExp, string][] = [
    [/\b(bed|bedroom|nursery|guest room|bunk)/, 'sleeping'],
    [/\b(bath|powder|wc|toilet|shower|ensuite|en-suite|lav)/, 'bath'],
    [/\b(kitchen|kitchenette|scullery)/, 'kitchen'],
    [/\b(pantry|closet|storage|store|wardrobe|attic)/, 'storage'],
    [/\b(living|family|great room|lounge|den|sitting|rec)/, 'living'],
    [/\b(dining|breakfast|nook)/, 'dining'],
    [/\b(office|study|library|studio)/, 'office'],
    [/\b(laundry|utility room|mudroom|mud room)/, 'laundry'],
    [/\b(utility)/, 'utility'],
    [/\b(hall|corridor|entry|foyer|landing|stair|vestibule|gallery)/, 'circulation'],
    [/\b(mechanical|furnace|boiler|plant)/, 'mechanical'],
    [/\b(garage|carport)/, 'garage'],
    [/\b(porch|deck|patio|terrace|balcony|courtyard|veranda)/, 'exterior'],
  ];
  return table.find(([re]) => re.test(n))?.[1] ?? null;
}
