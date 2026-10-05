import type { LevelView, Point, Ring } from '../editor/model';
import { add, dist, inFace, leftNormal, scale, signedArea, sub } from '../editor/geometry';
import { angleOf, facePoint, nearestFace } from '../editor/systems/placement';
import type { HostRef } from '../editor/systems/ops';
import type { Box } from './gltf';
import type { Mounting } from './library';
import type { ClearanceEnvelope } from '@floorspec/engine';

/**
 * Where "Place in <room>" puts an item (FLR-T-8.3, FS_furniture 4.1): a first spot a person then
 * drags or types into place, never a placement the editor stores — the result is a host reference
 * the applier resolves exactly (Ops 0.2 4.10).
 *
 * - An item that stands against a wall — most of them: a refrigerator, a sofa, a bed, a cabinet —
 *   backs onto the room's longest free stretch of wall face, facing into the room, on a `surface`
 *   host 10 mm off the face (so its point is strictly inside the room, Core 13.3.4).
 * - An item that hangs or is set (a wall cabinet, a shelf, a cooktop, a microwave, a wall oven) is
 *   hosted on that wall face at its category's height (library.ts `mountHeight`), so it moves with
 *   the wall (Core 13.3).
 * - An island, a table, a chair or a stool stands free in the room, at its middle.
 *
 * A spot is free when the item's footprint and its envelopes stay in the room and clear of every
 * other element's footprint and envelope on the level (FS_furniture 4.5's two lints) — tested in
 * floats on the plan, which is all a first guess needs; the engine's lints are the real answer.
 */

/** Items that stand in the middle of a room rather than against a wall. */
const FREE_STANDING = new Set(['island', 'diningTable', 'coffeeTable', 'sideTable', 'chair', 'stool', 'bench', 'armchair', 'crib']);

/** How far off a wall face a floor item stands: 10 mm, so its point is strictly inside the room. */
export const BACK_GAP = 12_800;
/** Spots tried along a face, from its middle outwards: every 150 mm. */
const STEP = 192_000;

export interface Spot {
  host: HostRef;
  /** The frame's origin in plan, and its facing as a unit vector. */
  point: Point;
  facing: Point;
  /** False when no free spot was found and this one is only the best there is. */
  free: boolean;
}

export interface ItemShape {
  box: Box;
  mounting: Mounting;
  category: string;
  clearances: Record<string, ClearanceEnvelope>;
  height?: number;
}

/** A box's footprint in plan for a frame at `o` facing `u` (Core 13.2), in floats. */
export function footprintAt(o: Point, u: Point, b: { min: readonly number[]; max: readonly number[] }): Point[] {
  const v: Point = [-u[1], u[0]];
  const at = (p: number, q: number): Point => [o[0] + p * u[0] + q * v[0], o[1] + p * u[1] + q * v[1]];
  const [x0, y0] = [b.min[0] ?? 0, b.min[1] ?? 0];
  const [x1, y1] = [b.max[0] ?? 0, b.max[1] ?? 0];
  return [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];
}

/** Whether two convex polygons' interiors overlap by more than `eps` (the separating-axis test). */
export function overlaps(a: Ring, b: Ring, eps = 1): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i] as Point;
      const q = poly[(i + 1) % poly.length] as Point;
      const n: Point = [q[1] - p[1], p[0] - q[0]];
      const l = Math.hypot(n[0], n[1]) || 1;
      const proj = (r: Ring) => r.map((x) => (x[0] * n[0] + x[1] * n[1]) / l);
      const pa = proj(a);
      const pb = proj(b);
      if (Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)) <= eps) return false;
    }
  }
  return true;
}

/** What is already on the level that an item must keep clear of: footprints and envelopes. */
export function obstacles(level: LevelView, extra: readonly Ring[] = []): Ring[] {
  return [...level.devices.flatMap((d) => [d.footprint, ...d.clearances.map((c) => c.ring)]), ...extra];
}

/** Whether every corner of a footprint is in the room (nudged 1 mm towards its middle, so a corner on a face counts). */
function inside(room: { outer: Ring; holes: readonly Ring[] }, ring: Ring): boolean {
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  return ring.every((p) => {
    const d = Math.hypot(cx - p[0], cy - p[1]) || 1;
    return inFace([p[0] + ((cx - p[0]) / d) * 1_280, p[1] + ((cy - p[1]) / d) * 1_280], room);
  });
}

const roundPt = (p: Point): [number, number] => [Math.round(p[0]), Math.round(p[1])];

/**
 * The first spot for an item in a room: against its walls, longest face first, from each face's
 * middle outwards; or, for a free-standing item, at the room's middle. Null when the room is not on
 * the level.
 */
export function spotIn(level: LevelView, roomId: string, item: ItemShape, avoid: readonly Ring[] = obstacles(level)): Spot | null {
  const room = level.rooms.find((r) => r.id === roomId);
  if (room === undefined) return null;
  const shape = { outer: room.outer, holes: room.holes };
  const b = item.box;
  const envelopes = Object.values(item.clearances);
  const clear = (o: Point, u: Point): { fits: boolean; free: boolean } => {
    const own = [footprintAt(o, u, b), ...envelopes.map((e) => footprintAt(o, u, e))];
    const fits = inside(shape, own[0] as Ring);
    return { fits, free: fits && own.every((r) => avoid.every((x) => !overlaps(r, x))) };
  };

  if (FREE_STANDING.has(item.category) && item.mounting === 'floor') {
    // The middle of the room's bounding box, else its anchor; the item centred on it, facing +x.
    const xs = room.outer.map((p) => p[0]);
    const ys = room.outer.map((p) => p[1]);
    const mid: Point = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const centre = (p: Point): Point => [p[0] - (b.min[0] + b.max[0]) / 2, p[1] - (b.min[1] + b.max[1]) / 2];
    for (const at of [mid, room.anchor]) {
      const o = roundPt(centre(at));
      if (!inFace(o, shape) && !inFace(at, shape)) continue;
      const c = clear(o, [1, 0]);
      if (c.fits) return { host: { mode: 'surface', room: roomId, surface: 'floor', at: inFace(o, shape) ? o : roundPt(at) }, point: o, facing: [1, 0], free: c.free };
    }
    return { host: { mode: 'surface', room: roomId, surface: 'floor', at: roundPt(room.anchor) }, point: room.anchor, facing: [1, 0], free: false };
  }

  // The room's faces, longest first; the ring's inward side is its left when it runs counter-clockwise.
  const ccw = signedArea(room.outer) > 0;
  const ring = room.outer;
  const edges = ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length] as Point })).filter((e) => dist(e.a, e.b) > 0).sort((x, y) => dist(y.a, y.b) - dist(x.a, x.b));
  const width = b.max[1] - b.min[1];
  const qc = (b.min[1] + b.max[1]) / 2;
  let fallback: Spot | null = null;
  for (const e of edges) {
    const L = dist(e.a, e.b);
    if (width > L) continue;
    const t = scale(sub(e.b, e.a), 1 / L);
    const n = ccw ? leftNormal(e.a, e.b) : scale(leftNormal(e.a, e.b), -1);
    const v: Point = [-n[1], n[0]];
    const offsets = [0];
    for (let k = STEP; k <= L / 2; k += STEP) offsets.push(k, -k);
    for (const off of offsets) {
      const s = L / 2 + off;
      if (s - width / 2 < 0 || s + width / 2 > L) continue;
      const along = add(e.a, scale(t, s));
      if (item.mounting === 'floor') {
        // The back of the box (its least x) on the face, its middle (y) at the spot.
        const o = roundPt(add(add(along, scale(n, BACK_GAP - b.min[0])), scale(v, -qc)));
        const c = clear(o, n);
        const spot: Spot = { host: { mode: 'surface', room: roomId, surface: 'floor', at: o, rotation: angleOf(n) }, point: o, facing: n, free: c.free };
        if (c.free && inFace(o, shape)) return spot;
        if (fallback === null && c.fits && inFace(o, shape)) fallback = spot;
        continue;
      }
      // Hung or set on the wall face at a height: the wall and the side whose face this is.
      const face = nearestFace(level, add(along, scale(n, 2_560)), 64_000);
      if (face === null) continue;
      const offset = Math.min(Math.floor(dist(face.wall.a, face.wall.b)), Math.max(0, Math.round(face.offset)));
      const o = facePoint(face.wall, face.side, offset);
      const c = clear(o, n);
      const spot: Spot = { host: { mode: 'wallFace', wall: face.wall.id, side: face.side, at: offset, height: item.height ?? 0 }, point: o, facing: n, free: c.free };
      if (c.free) return spot;
      fallback ??= c.fits ? spot : null;
    }
  }
  if (fallback !== null) return fallback;
  return { host: { mode: 'surface', room: roomId, surface: 'floor', at: roundPt(room.anchor) }, point: room.anchor, facing: [1, 0], free: false };
}

/** The angle a frame faces, in microdegrees: what a `surface` or `free` host's rotation is. */
export { angleOf };
