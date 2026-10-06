import type { LevelView, Point } from './model';
import { dist, distanceToRing, project, sub } from './geometry';
import { stationOf } from './arcs';

/**
 * Snapping (FLR-T-3.3): where a click lands, as an exact integer point the applier can take as is.
 *
 * In priority order:
 *  1. an existing **junction** — drawWall reuses a junction at the same point (Ops 4.1), which is
 *     what joins walls into rooms;
 *  2. a **wall** (anywhere on its body or face, or near its location line) — the point lands
 *     exactly on the location line, and normalization splits the wall there (Ops 5.2), making the
 *     T a junction. Only lattice points count: a point merely near an oblique line would leave a
 *     hairline gap that closes no room, so an oblique wall is a target only where it passes through
 *     integer points close together (45° does; most angles do not);
 *  3. while drawing from a point: **angle** steps of 15° (orthogonal first), length to the grid, and
 *     **alignment** with other junctions along the constrained line;
 *  4. otherwise the **grid**, and alignment with junction x or y.
 */

export type SnapKind = 'junction' | 'wall' | 'align' | 'angle' | 'grid' | 'free';

export interface Snap {
  point: Point;
  kind: SnapKind;
  /** The junction or wall snapped to. */
  ref?: string;
  /** Guide lines to draw, world coordinates. */
  guides: [Point, Point][];
  /** Degrees counter-clockwise from east, when drawing from a point. */
  angle?: number;
}

export interface SnapOptions {
  /** The point a segment is being drawn from. */
  from?: Point | undefined;
  /** Tolerance in base units (pixels × base units per pixel). */
  tol: number;
  /** The grid step, base units. */
  grid: number;
  /** Junctions not to snap to: the one being dragged. */
  exclude?: ReadonlySet<string>;
  /** Walls not to snap onto: those meeting a dragged junction. */
  excludeWalls?: ReadonlySet<string>;
  /** Constrain to 45° steps (Shift). */
  lock45?: boolean;
  /** No snapping at all except to the grid (Alt). */
  free?: boolean;
}

export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

const roundTo = (v: number, step: number) => Math.round(v / step) * step;

/**
 * The lattice point on line ab (integer endpoints) nearest `near`, if it lies strictly inside the
 * segment and within `tol` of `near`. Lattice points on a line through integer points are spaced
 * (dx, dy)/gcd apart, exactly.
 */
export function latticeOnSegment(a: Point, b: Point, near: Point, tol: number): Point | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const g = gcd(dx, dy);
  if (g === 0) return null;
  const sx = dx / g;
  const sy = dy / g;
  const k = Math.round(((near[0] - a[0]) * sx + (near[1] - a[1]) * sy) / (sx * sx + sy * sy));
  if (k <= 0 || k >= g) return null;
  const q: Point = [a[0] + k * sx, a[1] + k * sy];
  return dist(q, near) <= tol ? q : null;
}

/** Snap a direction to 15° steps (orthogonal within 7°, others within 4°), or 45° when locked. */
export function snapAngle(theta: number, lock45: boolean): number | null {
  const deg = (theta * 180) / Math.PI;
  if (lock45) return Math.round(deg / 45) * 45;
  const ortho = Math.round(deg / 90) * 90;
  if (Math.abs(deg - ortho) <= 7) return ortho;
  const fifteen = Math.round(deg / 15) * 15;
  if (Math.abs(deg - fifteen) <= 4) return fifteen;
  return null;
}

/** cos/sin of a whole-degree angle, exact on the axes so orthogonal walls stay on integers. */
export function unitAt(deg: number): Point {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return [1, 0];
  if (d === 90) return [0, 1];
  if (d === 180) return [-1, 0];
  if (d === 270) return [0, -1];
  const r = (d * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

function nearestJunction(level: LevelView, p: Point, tol: number, exclude?: ReadonlySet<string>) {
  let best: { id: string; position: Point; d: number } | null = null;
  for (const j of level.junctions) {
    if (exclude?.has(j.id) === true) continue;
    const d = dist(p, j.position);
    if (d <= tol && (best === null || d < best.d)) best = { id: j.id, position: j.position, d };
  }
  return best;
}

/** The wall (or separator) whose body, or location line, is nearest p within tol. */
function nearestEdge(level: LevelView, p: Point, tol: number, exclude?: ReadonlySet<string>) {
  let best: { id: string; a: Point; b: Point; d: number } | null = null;
  for (const w of level.walls) {
    if (exclude?.has(w.id) === true) continue;
    // An arc wall (Core 0.4, 21) is no edge to snap a junction onto: one inside it would have to split it.
    if (w.line.length > 2) continue;
    const d = Math.min(distanceToRing(p, w.ring), project(p, w.a, w.b).distance);
    if (d <= tol && (best === null || d < best.d)) best = { id: w.id, a: w.a, b: w.b, d };
  }
  for (const s of level.separators) {
    if (exclude?.has(s.id) === true || s.line.length > 2) continue;
    const d = project(p, s.a, s.b).distance;
    if (d <= tol && (best === null || d < best.d)) best = { id: s.id, a: s.a, b: s.b, d };
  }
  return best;
}

function alongGrid(a: Point, b: Point, p: Point, grid: number): Point {
  const l = dist(a, b);
  if (l === 0) return p;
  const t = roundTo(dist(a, p), grid);
  return [a[0] + ((b[0] - a[0]) * t) / l, a[1] + ((b[1] - a[1]) * t) / l];
}

/** Where the ray from `from` along `u` meets line ab, if it does ahead of `from`. */
function rayLine(from: Point, u: Point, a: Point, b: Point): Point | null {
  const d = sub(b, a);
  const denom = u[0] * d[1] - u[1] * d[0];
  if (Math.abs(denom) < 1e-12) return null;
  const w = sub(a, from);
  const t = (w[0] * d[1] - w[1] * d[0]) / denom;
  if (t <= 0) return null;
  return [from[0] + u[0] * t, from[1] + u[1] * t];
}

export function snapPoint(level: LevelView | undefined, raw: Point, o: SnapOptions): Snap {
  const guides: [Point, Point][] = [];
  if (level === undefined || o.free === true) {
    return { point: [roundTo(raw[0], o.grid), roundTo(raw[1], o.grid)], kind: o.free === true ? 'free' : 'grid', guides };
  }

  // 1. A junction.
  const j = nearestJunction(level, raw, o.tol, o.exclude);
  if (j !== null) return { point: j.position, kind: 'junction', ref: j.id, guides, ...angleOf(o.from, j.position) };

  // The constrained direction, when drawing from a point.
  let constrained: { deg: number; u: Point } | null = null;
  if (o.from !== undefined && dist(raw, o.from) > 0) {
    const theta = Math.atan2(raw[1] - o.from[1], raw[0] - o.from[0]);
    const deg = snapAngle(theta, o.lock45 === true);
    if (deg !== null) constrained = { deg, u: unitAt(deg) };
  }

  // 2. A wall: exactly onto its location line, at a lattice point.
  const edge = nearestEdge(level, raw, o.tol, o.excludeWalls);
  if (edge !== null) {
    const ray = constrained !== null && o.from !== undefined ? rayLine(o.from, constrained.u, edge.a, edge.b) : null;
    // Off a ray, the distance along the wall from its start lands on the grid.
    const target = ray ?? alongGrid(edge.a, edge.b, project(raw, edge.a, edge.b).point, o.grid);
    const q = latticeOnSegment(edge.a, edge.b, target, o.tol * 1.5);
    if (q !== null) return { point: q, kind: 'wall', ref: edge.id, guides, ...angleOf(o.from, q) };
  }

  // 3. Drawing from a point: angle, then length on the grid, or aligned with a junction.
  if (o.from !== undefined && constrained !== null) {
    const from = o.from;
    const along = (raw[0] - from[0]) * constrained.u[0] + (raw[1] - from[1]) * constrained.u[1];
    // Alignment: a junction whose x (on a vertical-ish line) or y lines up with the ray.
    for (const other of level.junctions) {
      if (o.exclude?.has(other.id) === true) continue;
      const t = (other.position[0] - from[0]) * constrained.u[0] + (other.position[1] - from[1]) * constrained.u[1];
      if (t <= 0 || Math.abs(t - along) > o.tol) continue;
      const q: Point = [Math.round(from[0] + constrained.u[0] * t), Math.round(from[1] + constrained.u[1] * t)];
      // Only when the junction is square to the ray from q: the dimension reads as aligned.
      if (Math.abs(q[0] - other.position[0]) < 1 || Math.abs(q[1] - other.position[1]) < 1) {
        guides.push([q, other.position]);
        return { point: q, kind: 'align', ref: other.id, guides, angle: constrained.deg };
      }
    }
    const length = Math.max(o.grid, roundTo(along, o.grid));
    const q: Point = [Math.round(from[0] + constrained.u[0] * length), Math.round(from[1] + constrained.u[1] * length)];
    guides.push([from, q]);
    return { point: q, kind: 'angle', guides, angle: constrained.deg };
  }

  // 4. The grid, and alignment with a junction's x or y.
  let alignX: Point | null = null;
  let alignY: Point | null = null;
  let bestX = o.tol;
  let bestY = o.tol;
  for (const other of level.junctions) {
    if (o.exclude?.has(other.id) === true) continue;
    const dx = Math.abs(raw[0] - other.position[0]);
    const dy = Math.abs(raw[1] - other.position[1]);
    if (dx < bestX) [bestX, alignX] = [dx, other.position];
    if (dy < bestY) [bestY, alignY] = [dy, other.position];
  }
  const point: Point = [alignX?.[0] ?? roundTo(raw[0], o.grid), alignY?.[1] ?? roundTo(raw[1], o.grid)];
  if (alignX !== null) guides.push([point, alignX]);
  if (alignY !== null) guides.push([point, alignY]);
  return { point, kind: alignX !== null || alignY !== null ? 'align' : 'grid', guides, ...angleOf(o.from, point) };
}

function angleOf(from: Point | undefined, to: Point): { angle?: number } {
  if (from === undefined || dist(from, to) === 0) return {};
  return { angle: Math.round(((Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI + 360) % 360) };
}

/**
 * A point at an exact typed length from `from`, along a whole-degree direction. Orthogonal
 * directions are exact; others are rounded once per coordinate, as a reference point is (Ops 3.2).
 */
export function pointAtLength(from: Point, deg: number, length: number): Point {
  const u = unitAt(deg);
  return [Math.round(from[0] + u[0] * length), Math.round(from[1] + u[1] * length)];
}

export interface OpeningSnap {
  /** The near edge's offset along the wall, base units. */
  offset: number;
  centered: boolean;
  /** Which side of the location line the pointer is on: a door swings towards it. */
  side: 'left' | 'right';
  /** Which end the pointer is nearer: a door hinges at it. */
  nearer: 'start' | 'end';
  fits: boolean;
}

/**
 * Where an opening of `width` goes on a wall, centred on the pointer: snapped to the wall's centre
 * when within `tol` of it, otherwise to the grid, and kept inside the wall (Core 7.3).
 */
/**
 * snapOpening on a wall as the editor holds it: along its polyline for an arc wall (Core 0.4, 21.6), whose
 * openings are placed by stations — the pointer seen as a station and a distance across.
 */
export function snapOpeningOn(wall: { a: Point; b: Point; line: readonly Point[]; arc?: { length: number } }, width: number, pointer: Point, o: { tol: number; grid: number }): OpeningSnap {
  if (wall.line.length <= 2 || wall.arc === undefined) return snapOpening(wall.a, wall.b, Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]), width, pointer, o);
  const st = stationOf(wall.line, pointer);
  return snapOpening([0, 0], [wall.arc.length, 0], wall.arc.length, width, [st.along, st.across], o);
}

export function snapOpening(a: Point, b: Point, wallLength: number, width: number, pointer: Point, o: { tol: number; grid: number }): OpeningSnap {
  const d = sub(b, a);
  const l = Math.hypot(d[0], d[1]) || 1;
  const along = ((pointer[0] - a[0]) * d[0] + (pointer[1] - a[1]) * d[1]) / l;
  const across = (d[0] * (pointer[1] - a[1]) - d[1] * (pointer[0] - a[0])) / l;
  const max = Math.floor(wallLength - width);
  const fits = max >= 0;
  const centre = (wallLength - width) / 2;
  let offset = along - width / 2;
  let centered = false;
  if (Math.abs(offset - centre) <= o.tol) {
    offset = Math.round(centre);
    centered = true;
  } else {
    offset = roundTo(offset, o.grid);
  }
  offset = Math.max(0, Math.min(Math.max(max, 0), offset));
  return { offset, centered, side: across >= 0 ? 'left' : 'right', nearer: along <= wallLength / 2 ? 'start' : 'end', fits };
}
