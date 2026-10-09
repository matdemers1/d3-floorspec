import type { HouseMesh } from '@floorspec/mesh';
import type { EditorModel, Point } from '../model';

/**
 * The walkthrough's physics (FLR-T-7.5, FLR-REQ-114), without three.js so it can be tested: what
 * a person can stand on, what stops them, and one step of walking.
 *
 * Everything comes from what the engine derived and the mesher built — nothing is measured off
 * the screen. The ground is every room's floor top (Core 15.1), every slab's top (15.7) and every
 * stair step's and landing's top (17.4); the obstacles are the walls' outlines from base to top
 * (5.7, 5.9) with their openings' cuts let through when a person fits (7.4), the junction fills,
 * and each stair step as the solid the mesher builds (two risers deep). Climbing a stair is then
 * nothing special: a riser is lower than the step-up height, so walking forward steps onto the
 * next tread, the landing, and the floor at the head.
 *
 * Units: metres in the document's frame (x east, y north, z up) relative to the mesh's origin —
 * the same frame the 3D scene draws in.
 */

export type P2 = readonly [number, number];

export interface Surface {
  id: string;
  kind: 'floor' | 'slab' | 'step';
  level: string;
  outer: P2[];
  holes: P2[][];
  top: number;
  box: Box2;
}

export interface Cut {
  id: string;
  /** Along the wall's location line from its start, metres. */
  t0: number;
  t1: number;
  zMin: number;
  zMax: number;
}

export interface Obstacle {
  id: string;
  kind: 'wall' | 'fill' | 'step';
  ring: P2[];
  zMin: number;
  zMax: number;
  box: Box2;
  /** A wall's location line, start and unit direction, for its cuts. */
  axis?: { a: P2; u: P2 };
  cuts: Cut[];
}

interface Box2 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface World {
  surfaces: Surface[];
  obstacles: Obstacle[];
  /** The ground outside the house: the lowest level's elevation. */
  base: number;
  levels: { id: string; name: string; elevation: number }[];
}

export interface WalkOptions {
  /** Eye above the floor under it. */
  eye: number;
  /** A person's radius in plan. */
  radius: number;
  /** The highest step taken without climbing — a riser is lower, a window sill is higher. */
  stepUp: number;
  /** Walking and running speeds, metres a second. */
  speed: number;
  fast: number;
  /** Turning speed, radians a second (arrow keys). */
  turn: number;
}

export const WALK: WalkOptions = { eye: 1.6, radius: 0.2, stepUp: 0.35, speed: 1.4, fast: 3.2, turn: Math.PI / 2 };

/** Above the eye, the top of a head: what a door head must clear. */
const CROWN = 0.12;
const GRAVITY = 9.8;

export interface Walker {
  x: number;
  y: number;
  /** The soles of the feet. */
  feet: number;
  /** Falling speed, metres a second (negative down). */
  vz: number;
  /** Heading, radians anticlockwise from east. */
  yaw: number;
  /** Looking up (positive) or down, radians. */
  pitch: number;
}

export interface WalkInput {
  /** Forward (+1) or back (−1). */
  forward: number;
  /** Right (+1) or left (−1). */
  strafe: number;
  /** Turn left (+1) or right (−1), as the arrow keys do. */
  turn: number;
  fast: boolean;
}

export const NO_INPUT: WalkInput = { forward: 0, strafe: 0, turn: 0, fast: false };

const boxOf = (pts: readonly P2[]): Box2 => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
};

/** Build the walkable world of a model as meshed (`mesh.origin` is subtracted, units become metres). */
export function buildWorld(model: EditorModel, mesh: HouseMesh): World {
  const k = mesh.unitsPerMetre;
  const [ox, oy, oz] = mesh.origin;
  const p = (q: Point | readonly number[]): P2 => [((q[0]) - ox) / k, ((q[1]) - oy) / k];
  const z = (v: number) => (v - oz) / k;
  const surfaces: Surface[] = [];
  const obstacles: Obstacle[] = [];

  const levels = model.levels.map((l) => ({ id: l.id, name: l.name, elevation: z(l.elevation) }));
  const base = levels.length === 0 ? 0 : Math.min(...levels.map((l) => l.elevation));

  for (const level of model.levels) {
    for (const room of level.rooms) {
      const outer = room.outer.map(p);
      surfaces.push({ id: room.id, kind: 'floor', level: level.id, outer, holes: room.holes.map((h) => h.map(p)), top: z(room.floorTop ?? level.elevation), box: boxOf(outer) });
    }
    for (const slab of level.slabs) {
      const outer = slab.outline.map(p);
      surfaces.push({ id: slab.id, kind: 'slab', level: level.id, outer, holes: [], top: z(slab.top), box: boxOf(outer) });
    }
    for (const stair of level.stairs) {
      const riser = stair.derived.riserHeight / k;
      for (const step of stair.derived.steps ?? []) {
        const outer = step.outline.map(p);
        const top = z(step.top);
        const box = boxOf(outer);
        surfaces.push({ id: stair.id, kind: 'step', level: level.id, outer, holes: [], top, box });
        obstacles.push({ id: stair.id, kind: 'step', ring: outer, zMin: top - 2 * riser, zMax: top, box, cuts: [] });
      }
    }
  }

  // Heights from the mesh: each wall's base and top (5.9), each opening's cut, each fill's span.
  const parts = new Map<string, { zMin: number; zMax: number }>();
  for (const part of mesh.parts) {
    if (part.kind === 'wall' || part.kind === 'opening' || part.kind === 'junctionFill') parts.set(part.key, { zMin: z(part.bbox.min[2]), zMax: z(part.bbox.max[2]) });
  }
  const cutsOf = new Map<string, Cut[]>();
  for (const level of model.levels) {
    for (const wall of level.walls) {
      const span = parts.get(`wall:${wall.id}`);
      if (span === undefined) continue;
      const a = p(wall.a);
      const b = p(wall.b);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const u: P2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      const cuts: Cut[] = [];
      cutsOf.set(wall.id, cuts);
      const ring = wall.ring.map(p);
      obstacles.push({ id: wall.id, kind: 'wall', ring, zMin: span.zMin, zMax: span.zMax, box: boxOf(ring), axis: { a, u }, cuts });
    }
    for (const fill of level.fills) {
      const span = parts.get(`junctionFill:${fill.id}`);
      if (span === undefined) continue;
      const ring = fill.ring.map(p);
      obstacles.push({ id: fill.id, kind: 'fill', ring, zMin: span.zMin, zMax: span.zMax, box: boxOf(ring), cuts: [] });
    }
  }
  for (const level of model.levels) {
    for (const opening of level.openings) {
      const span = parts.get(`opening:${opening.id}`);
      const wall = obstacles.find((o) => o.kind === 'wall' && o.id === opening.wall);
      if (span === undefined || wall?.axis === undefined) continue;
      const { a, u } = wall.axis;
      const along = (q: Point) => {
        const r = p(q);
        return (r[0] - a[0]) * u[0] + (r[1] - a[1]) * u[1];
      };
      const [t0, t1] = [along(opening.start), along(opening.end)].sort((m, n) => m - n) as [number, number];
      cutsOf.get(opening.wall)?.push({ id: opening.id, t0, t1, zMin: span.zMin, zMax: span.zMax });
    }
  }
  return { surfaces, obstacles, base, levels };
}

// ─── Geometry ────────────────────────────────────────────────────────────────────────────────

function inRing(x: number, y: number, ring: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as P2;
    const [xj, yj] = ring[j] as P2;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inSurface(x: number, y: number, s: Surface): boolean {
  if (x < s.box.minX || x > s.box.maxX || y < s.box.minY || y > s.box.maxY) return false;
  return inRing(x, y, s.outer) && !s.holes.some((h) => inRing(x, y, h));
}

function segmentDistance(x: number, y: number, a: P2, b: P2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/** Whether a disc touches a polygon: its centre inside, or an edge within the radius. */
export function discTouches(x: number, y: number, r: number, ring: readonly P2[]): boolean {
  if (inRing(x, y, ring)) return true;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if (segmentDistance(x, y, ring[j] as P2, ring[i] as P2) < r) return true;
  return false;
}

// ─── Queries ─────────────────────────────────────────────────────────────────────────────────

/**
 * The ground under a point: the highest surface under it that is no higher than `reach` (the feet
 * plus a step), or the ground outside the house. A floor overhead is not ground.
 */
export function groundAt(world: World, x: number, y: number, reach: number): { z: number; surface: Surface | null } {
  let best: Surface | null = null;
  for (const s of world.surfaces) {
    if (s.top > reach + 1e-6) continue;
    if (best !== null && s.top <= best.top) continue;
    if (inSurface(x, y, s)) best = s;
  }
  return best === null ? { z: world.base, surface: null } : { z: best.top, surface: best };
}

/** The room a point stands in, on the floor at `feet` (within a step). */
export function roomAt(world: World, x: number, y: number, feet: number, stepUp = WALK.stepUp): Surface | null {
  let best: Surface | null = null;
  for (const s of world.surfaces) {
    if (s.kind !== 'floor' || s.top > feet + stepUp + 1e-6 || s.top < feet - 2 * stepUp) continue;
    if (best !== null && s.top <= best.top) continue;
    if (inSurface(x, y, s)) best = s;
  }
  return best;
}

/** What a person is standing on: the surface under their feet (within a centimetre), or null outside. */
export function placeAt(world: World, x: number, y: number, feet: number): Surface | null {
  const g = groundAt(world, x, y, feet + 0.01);
  return g.surface !== null && g.surface.top >= feet - 0.05 ? g.surface : null;
}

/**
 * Whether a person standing at (x, y) with their feet at `feet` would be inside something: a wall,
 * a fill or a step too high to step onto. Their body runs from a step above their feet to the crown
 * of their head; a wall's opening lets them through when it spans that body and they fit its width.
 */
export function blocked(world: World, x: number, y: number, feet: number, o: Pick<WalkOptions, 'eye' | 'radius' | 'stepUp'> = WALK): string | null {
  const low = feet + o.stepUp;
  const high = feet + o.eye + CROWN;
  const r = o.radius;
  for (const ob of world.obstacles) {
    if (ob.zMax <= low || ob.zMin >= high) continue;
    if (x + r < ob.box.minX || x - r > ob.box.maxX || y + r < ob.box.minY || y - r > ob.box.maxY) continue;
    if (!discTouches(x, y, r, ob.ring)) continue;
    if (ob.axis !== undefined && ob.cuts.length > 0) {
      const t = (x - ob.axis.a[0]) * ob.axis.u[0] + (y - ob.axis.a[1]) * ob.axis.u[1];
      if (ob.cuts.some((c) => c.zMin <= low && c.zMax >= high && t >= c.t0 + r && t <= c.t1 - r)) continue;
    }
    return ob.id;
  }
  return null;
}

// ─── Walking ─────────────────────────────────────────────────────────────────────────────────

/** Stand someone at (x, y): on the highest ground no higher than `near` plus a step (default: anything below the sky). */
export function standAt(world: World, x: number, y: number, yaw: number, near = Infinity): Walker {
  const g = groundAt(world, x, y, near === Infinity ? Number.MAX_SAFE_INTEGER : near + WALK.stepUp);
  return { x, y, feet: g.z, vz: 0, yaw, pitch: 0 };
}

const STEP = 0.04;

/**
 * One frame of walking: turn, then move in short steps — each one slides along whatever blocks it
 * and steps up onto ground within a step — then fall, or follow the ground down a step.
 */
export function stepWalker(world: World, w: Walker, input: WalkInput, dt: number, o: WalkOptions = WALK): Walker {
  const t = Math.min(Math.max(dt, 0), 0.1);
  const yaw = w.yaw + input.turn * o.turn * t;
  let { x, y, feet, vz } = w;
  const fx = Math.cos(yaw);
  const fy = Math.sin(yaw);
  // Right of the heading is (fy, −fx).
  let mx = input.forward * fx + input.strafe * fy;
  let my = input.forward * fy - input.strafe * fx;
  const len = Math.hypot(mx, my);
  const grounded = vz === 0;
  if (len > 0) {
    const dist = (input.fast ? o.fast : o.speed) * t * Math.min(1, len);
    mx /= len;
    my /= len;
    const n = Math.max(1, Math.ceil(dist / STEP));
    const d = dist / n;
    for (let i = 0; i < n; i++) {
      const tries: [number, number][] = [[x + mx * d, y + my * d], [x + mx * d, y], [x, y + my * d]];
      let moved = false;
      for (const [nx, ny] of tries) {
        if (nx === x && ny === y) continue;
        const g = groundAt(world, nx, ny, feet + o.stepUp);
        const at = Math.max(feet, g.z);
        if (blocked(world, nx, ny, at, o) !== null) continue;
        x = nx;
        y = ny;
        // Up a step at once; down one by following the ground, when standing on it.
        if (g.z > feet) feet = g.z;
        else if (grounded && feet - g.z <= o.stepUp) feet = g.z;
        moved = true;
        break;
      }
      if (!moved) break;
    }
  }
  const g = groundAt(world, x, y, feet + 1e-6);
  if (g.z < feet) {
    vz -= GRAVITY * t;
    feet = Math.max(g.z, feet + vz * t);
    if (feet === g.z) vz = 0;
  } else {
    feet = g.z;
    vz = 0;
  }
  return { x, y, feet, vz, yaw, pitch: w.pitch };
}

/** Look around by a number of radians: heading wraps, pitch stops short of straight up and down. */
export function look(w: Walker, dYaw: number, dPitch: number): Walker {
  const limit = (85 * Math.PI) / 180;
  return { ...w, yaw: Math.atan2(Math.sin(w.yaw + dYaw), Math.cos(w.yaw + dYaw)), pitch: Math.max(-limit, Math.min(limit, w.pitch + dPitch)) };
}

/** Where the eye is. */
export const eyeAt = (w: Walker, eye = WALK.eye): [number, number, number] => [w.x, w.y, w.feet + eye];

// ─── Where to start ──────────────────────────────────────────────────────────────────────────

/**
 * Where a walk starts when no point is given: just inside an entry door — a door with a room's
 * floor on one side and none on the other, on the lowest level that has one — facing in; else in
 * the middle of the largest room on the given level, facing its longer way.
 */
export function entryOf(world: World, model: EditorModel, mesh: HouseMesh, preferLevel: string | null): Walker | null {
  const k = mesh.unitsPerMetre;
  const [ox, oy] = mesh.origin;
  const p = (q: Point): P2 => [(q[0] - ox) / k, (q[1] - oy) / k];
  const order = [...model.levels].sort((a, b) => a.elevation - b.elevation);
  for (const level of order) {
    for (const opening of level.openings) {
      if (opening.kind !== 'door') continue;
      const a = p(opening.start);
      const b = p(opening.end);
      const c: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const n: P2 = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
      const elevation = (level.elevation - mesh.origin[2]) / k;
      for (const side of [1, -1]) {
        const ix = c[0] + n[0] * side * 0.7;
        const iy = c[1] + n[1] * side * 0.7;
        const ox2 = c[0] - n[0] * side * 0.7;
        const oy2 = c[1] - n[1] * side * 0.7;
        const inside = roomAt(world, ix, iy, elevation);
        const outside = roomAt(world, ox2, oy2, elevation);
        if (inside !== null && outside === null) {
          const yaw = Math.atan2(n[1] * side, n[0] * side);
          const w = standAt(world, ix, iy, yaw, inside.top);
          if (blocked(world, w.x, w.y, w.feet) === null) return w;
        }
      }
    }
  }
  const level = model.levels.find((l) => l.id === preferLevel) ?? order[0];
  const rooms = world.surfaces.filter((s) => s.kind === 'floor' && (level === undefined || s.level === level.id));
  const largest = rooms.sort((s, t) => (t.box.maxX - t.box.minX) * (t.box.maxY - t.box.minY) - (s.box.maxX - s.box.minX) * (s.box.maxY - s.box.minY))[0];
  if (largest === undefined) return null;
  const cx = (largest.box.minX + largest.box.maxX) / 2;
  const cy = (largest.box.minY + largest.box.maxY) / 2;
  const yaw = largest.box.maxX - largest.box.minX >= largest.box.maxY - largest.box.minY ? 0 : Math.PI / 2;
  return standAt(world, cx, cy, yaw, largest.top);
}
