import type { Layers } from '../store';
import type { LevelView, Point } from '../model';
import { anchorOf } from '../systems/view';
import { visible } from '../systems/hit';

/**
 * What the multi-selection reads of the plan (FLR-T-18.8): each selectable element's outline as
 * points, so a marquee can ask whether it lies inside (a window) or touches (a crossing), and the
 * toolbar, align and distribute can ask where a selection's bounds are. Floats here, for picking
 * only — nothing computed here is written to the model without being rounded by the op builder.
 */

export interface Shape {
  id: string;
  points: readonly Point[];
  /** A ring (a wall's outline, a room's face) rather than a polyline (a separator) or a point. */
  closed: boolean;
  /**
   * A room, a slab or a roof: an area the marquee is usually drawn inside of. Taken only when it
   * lies wholly inside the marquee, even by a crossing, so catching three chairs never also catches
   * the great room they stand in.
   */
  area: boolean;
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const rectOf = (a: Point, b: Point): Rect => ({ minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) });

const box = (min: readonly number[], max: readonly number[]): Point[] => [
  [min[0] ?? 0, min[1] ?? 0],
  [max[0] ?? 0, min[1] ?? 0],
  [max[0] ?? 0, max[1] ?? 0],
  [min[0] ?? 0, max[1] ?? 0],
];

/** One element's shape on a level, or undefined when it is not drawn there. */
export function shapeOf(level: LevelView, id: string): Shape | undefined {
  const wall = level.walls.find((w) => w.id === id);
  if (wall !== undefined) return { id, points: wall.ring, closed: true, area: false };
  const device = level.devices.find((d) => d.id === id);
  if (device !== undefined) return { id, points: device.footprint.length > 0 ? device.footprint : [anchorOf(device)], closed: device.footprint.length > 2, area: false };
  const opening = level.openings.find((o) => o.id === id);
  if (opening !== undefined) return { id, points: [opening.start, opening.end], closed: false, area: false };
  const separator = level.separators.find((s) => s.id === id);
  if (separator !== undefined) return { id, points: separator.line, closed: false, area: false };
  const junction = level.junctions.find((j) => j.id === id);
  if (junction !== undefined) return { id, points: [junction.position], closed: false, area: false };
  const stair = level.stairs.find((s) => s.id === id);
  if (stair !== undefined) return { id, points: box(stair.derived.box.min, stair.derived.box.max), closed: true, area: false };
  const room = level.faces.find((f) => f.room === id);
  if (room !== undefined) return { id, points: room.outer, closed: true, area: true };
  const slab = level.slabs.find((s) => s.id === id);
  if (slab !== undefined) return { id, points: slab.outline, closed: true, area: true };
  const roof = level.roofs.find((r) => r.id === id);
  if (roof !== undefined) return { id, points: roof.derived.outline, closed: true, area: true };
  return undefined;
}

/**
 * Every element a marquee can catch on a level, with its layer shown: walls, openings, separators,
 * stairs, the devices and furniture of the shown systems, rooms, slabs, and roofs with the roof
 * layer on. Junctions are not caught — a wall brings its own.
 */
export function selectableShapes(level: LevelView, layers: Layers): Shape[] {
  const ids: string[] = [];
  if (layers.walls) ids.push(...level.walls.map((w) => w.id));
  if (layers.openings) ids.push(...level.openings.map((o) => o.id));
  ids.push(...level.separators.map((s) => s.id));
  ids.push(...level.stairs.map((s) => s.id));
  ids.push(...level.devices.filter((d) => visible(d, layers)).map((d) => d.id));
  if (layers.rooms) ids.push(...level.rooms.map((r) => r.id));
  ids.push(...level.slabs.map((s) => s.id));
  if (layers.roof) ids.push(...level.roofs.map((r) => r.id));
  return ids.map((id) => shapeOf(level, id)).filter((s): s is Shape => s !== undefined && s.points.length > 0);
}

const inside = (p: Point, r: Rect): boolean => p[0] >= r.minX && p[0] <= r.maxX && p[1] >= r.minY && p[1] <= r.maxY;

/** Do segments ab and cd cross or touch? */
function segmentsMeet(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const on = (p: Point, q: Point, r: Point) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}

function pointInPolygon(p: Point, ring: readonly Point[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point;
    const b = ring[j] as Point;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/** Wholly inside the rectangle: what a window (a marquee dragged to the right) takes. */
export function within(shape: Shape, r: Rect): boolean {
  return shape.points.every((p) => inside(p, r));
}

/** Inside or touching the rectangle: what a crossing (a marquee dragged to the left) takes. */
export function touches(shape: Shape, r: Rect): boolean {
  if (shape.points.some((p) => inside(p, r))) return true;
  const corners = box([r.minX, r.minY], [r.maxX, r.maxY]);
  const n = shape.points.length;
  const segments = shape.closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const a = shape.points[i] as Point;
    const b = shape.points[(i + 1) % n] as Point;
    for (let k = 0; k < 4; k++) if (segmentsMeet(a, b, corners[k] as Point, corners[(k + 1) % 4] as Point)) return true;
  }
  return shape.closed && corners.some((c) => pointInPolygon(c, shape.points));
}

/**
 * The elements a marquee catches: dragged right (`crossing` false), those wholly inside it — the
 * window; dragged left, those it touches — the crossing (AutoCAD's convention). An area is always
 * taken only when it is wholly inside.
 */
export function marqueeHits(shapes: readonly Shape[], r: Rect, crossing: boolean): string[] {
  return shapes.filter((s) => (crossing && !s.area ? touches(s, r) : within(s, r))).map((s) => s.id);
}

/** The bounds of some elements on a level, or null when none of them is drawn there. */
export function boundsOfIds(level: LevelView, ids: readonly string[]): Rect | null {
  let r: Rect | null = null;
  for (const id of ids) {
    const s = shapeOf(level, id);
    if (s === undefined) continue;
    for (const p of s.points) {
      r = r === null ? { minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] } : { minX: Math.min(r.minX, p[0]), minY: Math.min(r.minY, p[1]), maxX: Math.max(r.maxX, p[0]), maxY: Math.max(r.maxY, p[1]) };
    }
  }
  return r;
}
