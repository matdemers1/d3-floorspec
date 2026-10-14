import type { LevelView, Point, Ring } from './model';
import { dist, distanceToRing, project, sub } from './geometry';
import { stationOf } from './arcs';

/**
 * Snapping (FLR-T-3.3, FLR-T-18.9): where a click lands, as an exact integer point the applier can
 * take as is. One engine for drawing, dragging, placing and measuring — the tools pass the pointer,
 * the person's snap settings (the status bar's snap menu) and what is being moved, and get a point,
 * what it snapped to, the smart guides to draw and a few words for the tag beside the pointer.
 *
 * In priority order, each only when its toggle in the settings is on:
 *  1. an existing **junction** — drawWall reuses a junction at the same point (Ops 4.1), which is
 *     what joins walls into rooms;
 *  2. a wall's **midpoint**, an **item**'s corner, edge middle or centre, or a point of **another
 *     level** (its junctions, ghosted) — whichever is nearest;
 *  3. a **wall** (anywhere on its body or face, or near its location line) — the point lands
 *     exactly on the location line, and normalization splits the wall there (Ops 5.2), making the
 *     T a junction. Only lattice points count: a point merely near an oblique line would leave a
 *     hairline gap that closes no room, so an oblique wall is a target only where it passes through
 *     integer points close together (45° does; most angles do not). With `faces` (measuring,
 *     placing), a wall's nearer face is a target too;
 *  4. while drawing from a point: **parallel or perpendicular** to a wall nearby (smart guides),
 *     else an **angle** step (15° by default, orthogonal first), length to the grid, and
 *     **alignment** with other junctions along the constrained line;
 *  5. otherwise **smart guides** — alignment with a junction's, a midpoint's or an item centre's x
 *     or y, and the extension line of an oblique wall — and the **grid**.
 *
 * The settings' master switch off leaves the point where the pointer is, rounded to the base unit;
 * `free` (⌘ or ⌥ held while dragging) keeps only the grid.
 */

export type SnapKind = 'junction' | 'midpoint' | 'item' | 'ghost' | 'wall' | 'face' | 'guide' | 'align' | 'angle' | 'grid' | 'free';

export interface Snap {
  point: Point;
  kind: SnapKind;
  /** The junction, wall or item snapped to. */
  ref?: string;
  /** Guide lines to draw, world coordinates. */
  guides: [Point, Point][];
  /** Degrees counter-clockwise from east, when drawing from a point. */
  angle?: number;
  /** FLR-T-18.9: what was snapped to, in words, for the tag by the pointer: "Midpoint of W3", "Parallel to W2". */
  label?: string;
}

/**
 * Which snaps are on (FLR-T-18.9): the snap menu's toggles, per project and per mode. `step` is the
 * grid in base units, null for the units' working step (½" or 10 mm); `angle` the degrees between
 * snapped directions.
 */
export interface SnapSettings {
  /** The master switch: off, nothing snaps. */
  on: boolean;
  junctions: boolean;
  /** Wall faces and location lines. */
  walls: boolean;
  midpoints: boolean;
  /** Smart guides and alignment: x/y alignment, extension lines, parallel and perpendicular. */
  guides: boolean;
  /** Items: furniture, fixtures and devices — their corners, edge middles and centres. */
  items: boolean;
  /** Points of the levels next to this one, ghosted. */
  ghosts: boolean;
  grid: boolean;
  step: number | null;
  angles: boolean;
  angle: number;
}

/** Every snap on but other levels, the units' grid, 15° — what the editor did before the menu existed, and more. */
export const SNAP_DEFAULTS: SnapSettings = { on: true, junctions: true, walls: true, midpoints: true, guides: true, items: true, ghosts: false, grid: true, step: null, angles: true, angle: 15 };

/** The angle steps the menu offers. */
export const ANGLE_STEPS: readonly number[] = [5, 15, 30, 45, 90];

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
  /** No snapping at all except to the grid (⌘ or ⌥). */
  free?: boolean;
  /** FLR-T-18.9: which snaps are on; absent, SNAP_DEFAULTS. */
  settings?: SnapSettings | undefined;
  /** Snap onto a wall's faces as well as its location line: for measuring and placing, never for drawing a wall. */
  faces?: boolean;
  /** Points of other levels (the ghosts), snapped to when `settings.ghosts` is on. */
  ghosts?: readonly Point[];
  /** Items not to snap to: those being moved. */
  excludeItems?: ReadonlySet<string>;
  /** An element's name, for the snap's label; absent, its ID. */
  name?: ((id: string) => string) | undefined;
}

export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

const roundTo = (v: number, step: number) => Math.round(v / step) * step;
const roundPoint = (p: Point): Point => [Math.round(p[0]), Math.round(p[1])];

/**
 * The lattice point on line ab (integer endpoints) nearest `near`, if it lies strictly inside the
 * segment and within `tol` of `near`. Lattice points on a line through integer points are spaced
 * (dx, dy)/gcd apart, exactly.
 */
export function latticeOnSegment(a: Point, b: Point, near: Point, tol: number): Point | null {
  return latticeOnLine(a, b, near, tol, true);
}

/** latticeOnSegment on the whole line through a and b, or (`inside`) strictly within the segment. */
export function latticeOnLine(a: Point, b: Point, near: Point, tol: number, inside = false): Point | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const g = gcd(dx, dy);
  if (g === 0) return null;
  const sx = dx / g;
  const sy = dy / g;
  const k = Math.round(((near[0] - a[0]) * sx + (near[1] - a[1]) * sy) / (sx * sx + sy * sy));
  if (inside && (k <= 0 || k >= g)) return null;
  const q: Point = [a[0] + k * sx, a[1] + k * sy];
  return dist(q, near) <= tol ? q : null;
}

/**
 * Snap a direction to `step`° steps (orthogonal within 7°, others within 4° — or a third of the
 * step, when that is less), or 45° when locked.
 */
export function snapAngle(theta: number, lock45: boolean, step = 15): number | null {
  const deg = (theta * 180) / Math.PI;
  if (lock45) return Math.round(deg / 45) * 45;
  const ortho = Math.round(deg / 90) * 90;
  if (Math.abs(deg - ortho) <= 7) return ortho;
  if (step >= 90) return null;
  const stepped = Math.round(deg / step) * step;
  if (Math.abs(deg - stepped) <= Math.min(4, step / 3)) return stepped;
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
  let best: { id: string; a: Point; b: Point; d: number; ring: Ring | null } | null = null;
  for (const w of level.walls) {
    if (exclude?.has(w.id) === true) continue;
    // An arc wall (Core 0.4, 21) is no edge to snap a junction onto: one inside it would have to split it.
    if (w.line.length > 2) continue;
    const d = Math.min(distanceToRing(p, w.ring), project(p, w.a, w.b).distance);
    if (d <= tol && (best === null || d < best.d)) best = { id: w.id, a: w.a, b: w.b, d, ring: w.ring };
  }
  for (const s of level.separators) {
    if (exclude?.has(s.id) === true || s.line.length > 2) continue;
    const d = project(p, s.a, s.b).distance;
    if (d <= tol && (best === null || d < best.d)) best = { id: s.id, a: s.a, b: s.b, d, ring: null };
  }
  return best;
}

/** The point on a ring's boundary nearest p. */
function nearestOnRing(p: Point, ring: Ring): { point: Point; distance: number } | null {
  let best: { point: Point; distance: number } | null = null;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const q = project(p, ring[j] as Point, ring[i] as Point);
    if (best === null || q.distance < best.distance) best = { point: q.point, distance: q.distance };
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

/** A point worth snapping to that is not a junction: a midpoint, an item's corner or centre, a ghost. */
export interface SnapTarget {
  point: Point;
  kind: 'midpoint' | 'item' | 'ghost';
  ref?: string;
  label: string;
  /** An item's centre or a midpoint: what x/y alignment lines up with ("centre = Sink"). */
  centre?: boolean;
}

/** An item's points: its footprint's corners and edge middles, and its centre; a point device's anchor. */
export function itemPoints(device: { footprint: Ring; placement: { point: Point } | null }): { points: Point[]; centre: Point } {
  const fp = device.footprint;
  if (fp.length < 3) {
    const at = device.placement?.point ?? fp[0] ?? [0, 0];
    return { points: [], centre: at };
  }
  const points: Point[] = [];
  for (let i = 0; i < fp.length; i++) {
    const a = fp[i] as Point;
    const b = fp[(i + 1) % fp.length] as Point;
    points.push(a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  }
  const xs = fp.map((p) => p[0]);
  const ys = fp.map((p) => p[1]);
  return { points, centre: [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2] };
}

/** The midpoints, item points and ghosts the settings snap to. */
export function snapTargets(level: LevelView, o: Pick<SnapOptions, 'settings' | 'ghosts' | 'excludeItems' | 'excludeWalls' | 'name'>): SnapTarget[] {
  const s = o.settings ?? SNAP_DEFAULTS;
  const name = o.name ?? ((id: string) => id);
  const out: SnapTarget[] = [];
  if (s.midpoints) {
    for (const w of [...level.walls, ...level.separators]) {
      if (w.line.length > 2 || o.excludeWalls?.has(w.id) === true) continue;
      const m: Point = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
      // On the lattice, so a wall drawn to it splits the wall exactly; within half a unit of the middle.
      const q = latticeOnSegment(w.a, w.b, m, Math.max(1, dist(w.a, w.b) / 2)) ?? roundPoint(m);
      out.push({ point: q, kind: 'midpoint', ref: w.id, label: `Midpoint of ${name(w.id)}`, centre: true });
    }
  }
  if (s.items) {
    // The smaller first: a cooktop set into an island is what a point on both means.
    const area = (r: Ring) => { const xs = r.map((p) => p[0]); const ys = r.map((p) => p[1]); return r.length < 3 ? 0 : (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)); };
    for (const d of [...level.devices].sort((x, y) => area(x.footprint) - area(y.footprint))) {
      if (o.excludeItems?.has(d.id) === true) continue;
      const { points, centre } = itemPoints(d);
      for (const p of points) out.push({ point: roundPoint(p), kind: 'item', ref: d.id, label: name(d.id) });
      out.push({ point: roundPoint(centre), kind: 'item', ref: d.id, label: `Centre of ${name(d.id)}`, centre: true });
    }
  }
  if (s.ghosts) for (const p of o.ghosts ?? []) out.push({ point: roundPoint(p), kind: 'ghost', label: 'On the level below' });
  return out;
}

/** The wall nearest p within `reach` that a segment from `from` runs parallel or perpendicular to, within 2°. */
function parallelTo(level: LevelView, from: Point, raw: Point, reach: number, step: number | null): { deg: number; u: Point; wall: string; perpendicular: boolean; a: Point; b: Point } | null {
  const theta = Math.atan2(raw[1] - from[1], raw[0] - from[0]);
  let best: { deg: number; u: Point; wall: string; perpendicular: boolean; a: Point; b: Point; d: number } | null = null;
  for (const w of level.walls) {
    if (w.line.length > 2) continue;
    const near = Math.min(project(raw, w.a, w.b).distance, project(from, w.a, w.b).distance);
    if (near > reach) continue;
    const phi = Math.atan2(w.b[1] - w.a[1], w.b[0] - w.a[0]);
    for (const [k, perpendicular] of [[0, false], [Math.PI / 2, true]] as const) {
      // The nearer of the line's two directions to the one being drawn.
      let dir = phi + k;
      let diff = Math.atan2(Math.sin(theta - dir), Math.cos(theta - dir));
      if (Math.abs(diff) > Math.PI / 2) {
        dir += Math.PI;
        diff = Math.atan2(Math.sin(theta - dir), Math.cos(theta - dir));
      }
      if (Math.abs(diff) > (2 * Math.PI) / 180) continue;
      const deg = (((dir * 180) / Math.PI) % 360 + 360) % 360;
      // An axis or an angle step is already snapped to: a guide here would say the same twice.
      if (step !== null && Math.abs(deg / step - Math.round(deg / step)) < 1e-6) continue;
      if (best === null || near < best.d) best = { deg, u: [Math.cos(dir), Math.sin(dir)], wall: w.id, perpendicular, a: w.a, b: w.b, d: near };
    }
  }
  return best;
}

export function snapPoint(level: LevelView | undefined, raw: Point, o: SnapOptions): Snap {
  const guides: [Point, Point][] = [];
  const s = o.settings ?? SNAP_DEFAULTS;
  const name = o.name ?? ((id: string) => id);
  if (!s.on && o.free !== true) return { point: roundPoint(raw), kind: 'free', guides, ...angleOf(o.from, roundPoint(raw)) };
  const grid = s.grid ? o.grid : 1;
  if (level === undefined || o.free === true) {
    return { point: [roundTo(raw[0], grid), roundTo(raw[1], grid)], kind: o.free === true ? 'free' : 'grid', guides };
  }

  // 1. A junction.
  const j = s.junctions ? nearestJunction(level, raw, o.tol, o.exclude) : null;
  if (j !== null) return { point: j.position, kind: 'junction', ref: j.id, guides, ...angleOf(o.from, j.position) };

  // 2. A midpoint, an item's point, another level's point: the nearest.
  const targets = snapTargets(level, o);
  let target: SnapTarget | null = null;
  let targetD = o.tol;
  for (const t of targets) {
    const d = dist(raw, t.point);
    if (d < targetD || (target === null && d <= targetD)) [target, targetD] = [t, d];
  }
  if (target !== null) return { point: target.point, kind: target.kind, ...(target.ref === undefined ? {} : { ref: target.ref }), guides, label: target.label, ...angleOf(o.from, target.point) };

  // The constrained direction, when drawing from a point: parallel or perpendicular to a wall near
  // it first (a smart guide), else an angle step.
  let constrained: { deg: number; u: Point; label?: string; guide?: [Point, Point] } | null = null;
  if (o.from !== undefined && dist(raw, o.from) > 0) {
    const from = o.from;
    const lock = o.lock45 === true;
    if (s.guides && !lock) {
      const par = parallelTo(level, from, raw, o.tol * 12, s.angles ? s.angle : null);
      if (par !== null) constrained = { deg: Math.round(par.deg), u: par.u, label: `${par.perpendicular ? 'Perpendicular' : 'Parallel'} to ${name(par.wall)}`, guide: [par.a, par.b] };
    }
    if (constrained === null && (s.angles || lock)) {
      const theta = Math.atan2(raw[1] - from[1], raw[0] - from[0]);
      const deg = snapAngle(theta, lock, s.angle);
      if (deg !== null) constrained = { deg, u: unitAt(deg) };
    }
  }

  // 3. A wall: exactly onto its location line, at a lattice point — or, measuring, onto a face.
  const edge = s.walls ? nearestEdge(level, raw, o.tol, o.excludeWalls) : null;
  if (edge !== null) {
    const onLine = project(raw, edge.a, edge.b);
    const face = o.faces === true && edge.ring !== null ? nearestOnRing(raw, edge.ring) : null;
    if (face !== null && face.distance < onLine.distance) {
      const q = roundPoint(face.point);
      return { point: q, kind: 'face', ref: edge.id, guides, label: `Face of ${name(edge.id)}`, ...angleOf(o.from, q) };
    }
    const ray = constrained !== null && o.from !== undefined ? rayLine(o.from, constrained.u, edge.a, edge.b) : null;
    // Off a ray, the distance along the wall from its start lands on the grid.
    const along = ray ?? alongGrid(edge.a, edge.b, onLine.point, grid);
    const q = latticeOnSegment(edge.a, edge.b, along, o.tol * 1.5);
    if (q !== null) return { point: q, kind: 'wall', ref: edge.id, guides, ...angleOf(o.from, q) };
  }

  // 4. Drawing from a point: the direction, then length on the grid, or aligned with a junction.
  if (o.from !== undefined && constrained !== null) {
    const from = o.from;
    const u = constrained.u;
    const extra: { label?: string } = constrained.label === undefined ? {} : { label: constrained.label };
    if (constrained.guide !== undefined) guides.push(constrained.guide);
    const along = (raw[0] - from[0]) * u[0] + (raw[1] - from[1]) * u[1];
    // Alignment: a junction (or, with guides, a midpoint or an item's centre) square to the ray.
    const aligners: { point: Point; ref: string; label?: string }[] = s.guides ? [
      ...level.junctions.filter((other) => o.exclude?.has(other.id) !== true).map((other) => ({ point: other.position, ref: other.id })),
      ...targets.filter((t) => t.centre === true && t.ref !== undefined).map((t) => ({ point: t.point, ref: t.ref as string, label: t.label })),
    ] : [];
    for (const other of aligners) {
      const t = (other.point[0] - from[0]) * u[0] + (other.point[1] - from[1]) * u[1];
      if (t <= 0 || Math.abs(t - along) > o.tol) continue;
      const q: Point = [Math.round(from[0] + u[0] * t), Math.round(from[1] + u[1] * t)];
      // Only when the target is square to the ray from q: the dimension reads as aligned.
      if (Math.abs(q[0] - other.point[0]) < 1 || Math.abs(q[1] - other.point[1]) < 1) {
        guides.push([q, other.point]);
        return { point: q, kind: 'align', ref: other.ref, guides, angle: constrained.deg, ...(other.label === undefined ? extra : { label: other.label }) };
      }
    }
    const length = Math.max(grid, roundTo(along, grid));
    const q: Point = [Math.round(from[0] + u[0] * length), Math.round(from[1] + u[1] * length)];
    guides.push([from, q]);
    return { point: q, kind: 'angle', guides, angle: constrained.deg, ...extra };
  }

  // 5. Smart guides — a junction's, a midpoint's or an item centre's x or y; an oblique wall's
  // extension line — and the grid.
  let alignX: { point: Point; label?: string } | null = null;
  let alignY: { point: Point; label?: string } | null = null;
  if (s.guides) {
    let bestX = o.tol;
    let bestY = o.tol;
    const aligners: { point: Point; label?: string }[] = [
      ...level.junctions.filter((other) => o.exclude?.has(other.id) !== true).map((other) => ({ point: other.position })),
      ...targets.filter((t) => t.centre === true).map((t) => ({ point: t.point, label: t.label.startsWith('Centre of ') ? `centre = ${t.label.slice('Centre of '.length)}` : t.label })),
    ];
    for (const other of aligners) {
      const dx = Math.abs(raw[0] - other.point[0]);
      const dy = Math.abs(raw[1] - other.point[1]);
      if (dx < bestX) [bestX, alignX] = [dx, other];
      if (dy < bestY) [bestY, alignY] = [dy, other];
    }
    if (alignX === null && alignY === null) {
      // An oblique wall's line, beyond its ends: where a wall drawn on from it would continue.
      for (const w of level.walls) {
        if (w.line.length > 2 || w.a[0] === w.b[0] || w.a[1] === w.b[1] || o.excludeWalls?.has(w.id) === true) continue;
        const pr = project(raw, w.a, w.b);
        if (pr.t > 0 && pr.t < 1) continue;
        const q = latticeOnLine(w.a, w.b, raw, o.tol);
        if (q === null) continue;
        const end = pr.t <= 0 ? w.a : w.b;
        guides.push([end, q]);
        return { point: q, kind: 'guide', ref: w.id, guides, label: `Extension of ${name(w.id)}`, ...angleOf(o.from, q) };
      }
    }
  }
  const point: Point = [alignX !== null ? Math.round(alignX.point[0]) : roundTo(raw[0], grid), alignY !== null ? Math.round(alignY.point[1]) : roundTo(raw[1], grid)];
  if (alignX !== null) guides.push([point, alignX.point]);
  if (alignY !== null) guides.push([point, alignY.point]);
  const label = alignX?.label ?? alignY?.label;
  return { point, kind: alignX !== null || alignY !== null ? 'align' : 'grid', guides, ...(label === undefined ? {} : { label }), ...angleOf(o.from, point) };
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

// ─── Smart guides while dragging (FLR-T-18.9) ───────────────────────────────────────────────

/** An axis-aligned box, base units. */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface AlignedMove {
  /** The move, adjusted so an edge or the centre lines up with something within tolerance. */
  d: Point;
  guides: [Point, Point][];
  label?: string;
}

/**
 * Smart guides for something being dragged (a selection, an item): its box moved by `d` lines up
 * its left, centre or right with a junction's x, an axis-aligned wall's face, or another item's
 * edge or centre — and the same for y — when within `tol`. The move is adjusted to match, and the
 * guides run from the box to what it lines up with. With guides off (or nothing near), `d` as it was.
 */
export function alignMove(level: LevelView, box: Box, d: Point, o: { tol: number; settings?: SnapSettings | undefined; excludeItems?: ReadonlySet<string>; excludeWalls?: ReadonlySet<string>; exclude?: ReadonlySet<string>; name?: ((id: string) => string) | undefined }): AlignedMove {
  const s = o.settings ?? SNAP_DEFAULTS;
  if (!s.on || !s.guides) return { d, guides: [] };
  const name = o.name ?? ((id: string) => id);
  type Line = { at: number; from: Point; label?: string };
  const xs: Line[] = [];
  const ys: Line[] = [];
  if (s.junctions) for (const j of level.junctions) if (o.exclude?.has(j.id) !== true) {
    xs.push({ at: j.position[0], from: j.position });
    ys.push({ at: j.position[1], from: j.position });
  }
  if (s.walls) for (const w of level.walls) {
    if (w.line.length > 2 || o.excludeWalls?.has(w.id) === true) continue;
    const mid: Point = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
    const rx = w.ring.map((p) => p[0]);
    const ry = w.ring.map((p) => p[1]);
    if (w.a[0] === w.b[0]) for (const x of [Math.min(...rx), Math.max(...rx)]) xs.push({ at: x, from: [x, mid[1]], label: `Face of ${name(w.id)}` });
    if (w.a[1] === w.b[1]) for (const y of [Math.min(...ry), Math.max(...ry)]) ys.push({ at: y, from: [mid[0], y], label: `Face of ${name(w.id)}` });
  }
  if (s.items) for (const dv of level.devices) {
    if (o.excludeItems?.has(dv.id) === true || dv.footprint.length < 3) continue;
    const fx = dv.footprint.map((p) => p[0]);
    const fy = dv.footprint.map((p) => p[1]);
    const b = { minX: Math.min(...fx), maxX: Math.max(...fx), minY: Math.min(...fy), maxY: Math.max(...fy) };
    const c: Point = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    xs.push({ at: b.minX, from: [b.minX, c[1]], label: name(dv.id) }, { at: c[0], from: c, label: `centre = ${name(dv.id)}` }, { at: b.maxX, from: [b.maxX, c[1]], label: name(dv.id) });
    ys.push({ at: b.minY, from: [c[0], b.minY], label: name(dv.id) }, { at: c[1], from: c, label: `centre = ${name(dv.id)}` }, { at: b.maxY, from: [c[0], b.maxY], label: name(dv.id) });
  }
  const pick = (moving: readonly number[], lines: Line[]): { shift: number; line: Line; at: number } | null => {
    let best: { shift: number; line: Line; at: number } | null = null;
    for (const m of moving) for (const l of lines) {
      const shift = l.at - m;
      if (Math.abs(shift) <= o.tol && (best === null || Math.abs(shift) < Math.abs(best.shift))) best = { shift, line: l, at: l.at };
    }
    return best;
  };
  const moved = { minX: box.minX + d[0], maxX: box.maxX + d[0], minY: box.minY + d[1], maxY: box.maxY + d[1] };
  const px = pick([moved.minX, (moved.minX + moved.maxX) / 2, moved.maxX], xs);
  const py = pick([moved.minY, (moved.minY + moved.maxY) / 2, moved.maxY], ys);
  const out: Point = [Math.round(d[0] + (px?.shift ?? 0)), Math.round(d[1] + (py?.shift ?? 0))];
  const guides: [Point, Point][] = [];
  const cy = (moved.minY + moved.maxY) / 2 + (py?.shift ?? 0);
  const cx = (moved.minX + moved.maxX) / 2 + (px?.shift ?? 0);
  if (px !== null) guides.push([[px.at, cy], [px.at, px.line.from[1]]]);
  if (py !== null) guides.push([[cx, py.at], [py.line.from[0], py.at]]);
  const label = px?.line.label ?? py?.line.label;
  return { d: out, guides, ...(label === undefined ? {} : { label }) };
}

/**
 * Smart guides for an opening slid along a straight, axis-aligned wall: its centre or an edge lines
 * up with another opening's centre, a junction or an item's centre across the plan ("centre =
 * Entry door O26"). Returns the adjusted offset and the guide, or null when nothing is near.
 */
export function alignOpening(level: LevelView, wall: { id: string; a: Point; b: Point; line: readonly Point[] }, opening: { id?: string; offset: number; width: number }, o: { tol: number; settings?: SnapSettings | undefined; name?: ((id: string) => string) | undefined }): { offset: number; guides: [Point, Point][]; label?: string } | null {
  const s = o.settings ?? SNAP_DEFAULTS;
  if (!s.on || !s.guides || wall.line.length > 2) return null;
  const axis = wall.a[1] === wall.b[1] ? 0 : wall.a[0] === wall.b[0] ? 1 : null;
  if (axis === null) return null;
  const k: 0 | 1 = axis;
  const name = o.name ?? ((id: string) => id);
  const sign = Math.sign(wall.b[k] - wall.a[k]) || 1;
  const L = Math.abs(wall.b[k] - wall.a[k]);
  const at = (t: number): Point => (k === 0 ? [wall.a[0] + sign * t, wall.a[1]] : [wall.a[0], wall.a[1] + sign * t]);
  const targets: { v: number; from: Point; label?: string }[] = [];
  for (const other of level.openings) {
    if (other.id === opening.id) continue;
    const c: Point = [(other.start[0] + other.end[0]) / 2, (other.start[1] + other.end[1]) / 2];
    targets.push({ v: c[k], from: c, label: `centre = ${name(other.id)}` });
  }
  if (s.junctions) for (const j of level.junctions) targets.push({ v: j.position[k], from: j.position });
  if (s.items) for (const d of level.devices) {
    const { centre } = itemPoints(d);
    targets.push({ v: centre[k], from: centre, label: `centre = ${name(d.id)}` });
  }
  let best: { offset: number; shift: number; from: Point; edge: number; label?: string } | null = null;
  for (const [edge, along] of [[0.5, opening.offset + opening.width / 2], [0, opening.offset], [1, opening.offset + opening.width]] as const) {
    const v = at(along)[k];
    for (const t of targets) {
      const shift = t.v - v;
      if (Math.abs(shift) > o.tol || (best !== null && Math.abs(shift) >= Math.abs(best.shift))) continue;
      const offset = Math.round(opening.offset + sign * shift);
      if (offset < 0 || offset > L - opening.width) continue;
      best = { offset, shift, from: t.from, edge, ...(t.label === undefined ? {} : { label: t.label }) };
    }
  }
  if (best === null) return null;
  const p = at(best.offset + opening.width * best.edge);
  return { offset: best.offset, guides: [[p, best.from]], ...(best.label === undefined ? {} : { label: best.label }) };
}
