import { blocked, discTouches, entryOf, groundAt, inSurface, placeAt, WALK, type Obstacle, type Surface, type World } from '../walk';
import type { EditorModel } from '../../model';
import type { HouseMesh } from '@floorspec/mesh';

/**
 * Walk it in VR (FLR-T-14.3): the walkthrough at 1:1 in a headset — where a teleport may land, how
 * the person is placed in the house, how they turn and change level — without three.js or WebXR, so
 * it can be tested. Everything is in the 3D view's frame: metres about the mesh's origin, x east,
 * y north, z up; a WebXR reference space (y up, −z ahead) is put into it by `rigPose`.
 *
 * A teleport lands only on a floor — a room's (Core 15.1) or a stair's step or landing (17.4) — that
 * a person fits on, no higher than a short climb above where they stand, and never through a wall:
 * the line across the plan from where they stand to where they land has to pass the walls (and the
 * junctions' fills) through an opening that spans a person — a door or an empty opening, never a
 * window. VR is read-only: nothing here writes the model.
 */

export type Vec3 = [number, number, number];

export const TELEPORT = {
  /** The highest a teleport climbs: up a flight's landing, never through a ceiling to the next floor. */
  maxClimb: 1.8,
  /** How far below the aimed point the floor may be: the aim lands on its top, not on a rug or a bed. */
  onFloor: 0.12,
  /** How narrow a way through the line across the plan needs: a door's width, not a person's. */
  pathRadius: 0.05,
  /** Steps along that line, metres: finer than the thinnest wall plus the radius twice. */
  pathStep: 0.08,
  /** The arc's launch speed, metres a second, and gravity: about 6 m of reach on the level. */
  speed: 7,
  gravity: 9.8,
  /** The arc's time step and its longest flight, seconds; a straight pointer's reach, metres. */
  dt: 0.025,
  flight: 2,
  reach: 25,
} as const;

/** Why a teleport cannot land where it is aimed. */
export type NoTeleport = 'not-a-floor' | 'too-high' | 'no-room' | 'through-a-wall' | 'a-wall' | 'a-ceiling' | 'nothing';

export type TeleportCheck =
  | { ok: true; x: number; y: number; floor: number; surface: Surface }
  | { ok: false; reason: NoTeleport; x: number; y: number; floor: number };

/** Where someone stands: plan position and the floor under their feet. */
export interface Feet {
  x: number;
  y: number;
  feet: number;
}

const wallsOnly = new WeakMap<World, World>();
/** The world with only its walls and fills in the way: what a teleport may not pass through. */
function walls(world: World): World {
  let w = wallsOnly.get(world);
  if (w === undefined) {
    w = { ...world, obstacles: world.obstacles.filter((o) => o.kind !== 'step') };
    wallsOnly.set(world, w);
  }
  return w;
}

/**
 * Whether the line across the plan from `a` to `b` passes through a wall: sampled every few
 * centimetres, a thin body (a door's width is plenty) moving from one floor height to the other.
 */
export function throughWall(world: World, a: Feet, b: Feet): string | null {
  const w = walls(world);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / TELEPORT.pathStep));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const feet = a.feet + (b.feet - a.feet) * t;
    const hit = blocked(w, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, feet, { eye: WALK.eye, radius: TELEPORT.pathRadius, stepUp: WALK.stepUp });
    if (hit !== null) return hit;
  }
  return null;
}

/** Whether a teleport from where someone stands may land at an aimed point (the floor's top under it). */
export function teleportCheck(world: World, from: Feet, to: { x: number; y: number; z: number }): TeleportCheck {
  const g = groundAt(world, to.x, to.y, to.z + TELEPORT.onFloor);
  const at = { x: to.x, y: to.y, floor: g.z };
  if (g.surface === null || (g.surface.kind !== 'floor' && g.surface.kind !== 'step') || to.z - g.z > TELEPORT.onFloor) return { ok: false, reason: 'not-a-floor', ...at };
  if (g.z - from.feet > TELEPORT.maxClimb) return { ok: false, reason: 'too-high', ...at };
  if (blocked(world, to.x, to.y, g.z) !== null) return { ok: false, reason: 'no-room', ...at };
  if (throughWall(world, from, { x: to.x, y: to.y, feet: g.z }) !== null) return { ok: false, reason: 'through-a-wall', ...at };
  return { ok: true, ...at, surface: g.surface };
}

/** Whether a point is inside a wall or a fill — not in an opening's cut through it. */
export function solidAt(world: World, x: number, y: number, z: number): Obstacle | null {
  for (const ob of world.obstacles) {
    if (ob.kind === 'step' || z < ob.zMin || z > ob.zMax) continue;
    if (x < ob.box.minX || x > ob.box.maxX || y < ob.box.minY || y > ob.box.maxY) continue;
    if (!discTouches(x, y, 0, ob.ring)) continue;
    if (ob.axis !== undefined) {
      const t = (x - ob.axis.a[0]) * ob.axis.u[0] + (y - ob.axis.a[1]) * ob.axis.u[1];
      if (ob.cuts.some((c) => t >= c.t0 && t <= c.t1 && z >= c.zMin && z <= c.zMax)) continue;
    }
    return ob;
  }
  return null;
}

/** The arc a controller throws: a parabola from its tip, sampled until it falls below the ground. */
export function arcPoints(origin: Vec3, direction: Vec3, ground: number): Vec3[] {
  const len = Math.hypot(...direction) || 1;
  const v: Vec3 = [(direction[0] / len) * TELEPORT.speed, (direction[1] / len) * TELEPORT.speed, (direction[2] / len) * TELEPORT.speed];
  const out: Vec3[] = [origin];
  for (let t = TELEPORT.dt; t <= TELEPORT.flight + 1e-9; t += TELEPORT.dt) {
    const p: Vec3 = [origin[0] + v[0] * t, origin[1] + v[1] * t, origin[2] + v[2] * t - 0.5 * TELEPORT.gravity * t * t];
    out.push(p);
    if (p[2] < ground - 1) break;
  }
  return out;
}

/** A pointer's straight ray, as a path: gaze-and-pinch on Vision Pro, a hand's pinch ray. */
export function rayPoints(origin: Vec3, direction: Vec3, reach: number = TELEPORT.reach): Vec3[] {
  const len = Math.hypot(...direction) || 1;
  return [origin, [origin[0] + (direction[0] / len) * reach, origin[1] + (direction[1] / len) * reach, origin[2] + (direction[2] / len) * reach]];
}

export interface PathHit {
  /** The path up to what it hit. */
  points: Vec3[];
  /** What it hit, and where: a floor's top from above, a wall, a floor from below (a ceiling), or nothing. */
  kind: 'floor' | 'wall' | 'ceiling' | 'nothing';
  at: Vec3 | null;
}

const SUB = 0.05;

/** Follow a path until it meets the house: the first floor it comes down on, wall it runs into or ceiling it rises into. */
export function castPath(world: World, path: readonly Vec3[]): PathHit {
  const points: Vec3[] = [path[0]!];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / SUB));
    for (let k = 1; k <= n; k++) {
      const p: Vec3 = [a[0] + ((b[0] - a[0]) * (k - 1)) / n, a[1] + ((b[1] - a[1]) * (k - 1)) / n, a[2] + ((b[2] - a[2]) * (k - 1)) / n];
      const q: Vec3 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, a[2] + ((b[2] - a[2]) * k) / n];
      // A floor crossed between p and q: the nearest along the way.
      let best: { s: number; at: Vec3; down: boolean } | null = null;
      for (const s of world.surfaces) {
        const lo = Math.min(p[2], q[2]);
        const hi = Math.max(p[2], q[2]);
        if (s.top < lo || s.top > hi || p[2] === q[2]) continue;
        const f = (s.top - p[2]) / (q[2] - p[2]);
        const at: Vec3 = [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, s.top];
        if (!inSurface(at[0], at[1], s)) continue;
        if (best === null || f < best.s) best = { s: f, at, down: q[2] < p[2] };
      }
      const wall = solidAt(world, q[0], q[1], q[2]);
      if (best !== null) {
        points.push(best.at);
        return { points, kind: best.down ? 'floor' : 'ceiling', at: best.at };
      }
      if (wall !== null) {
        points.push(q);
        return { points, kind: 'wall', at: q };
      }
    }
    points.push(b);
  }
  return { points, kind: 'nothing', at: null };
}

/** Aim from a controller (an arc) or a pointer (a ray) and say whether, and where, it lands. */
export function aim(world: World, from: Feet, origin: Vec3, direction: Vec3, arc: boolean): { path: PathHit; check: TeleportCheck } {
  const path = castPath(world, arc ? arcPoints(origin, direction, world.base) : rayPoints(origin, direction));
  if (path.kind !== 'floor' || path.at === null) {
    const at = path.at ?? path.points[path.points.length - 1]!;
    return { path, check: { ok: false, reason: path.kind === 'wall' ? 'a-wall' : path.kind === 'ceiling' ? 'a-ceiling' : 'nothing', x: at[0], y: at[1], floor: at[2] } };
  }
  return { path, check: teleportCheck(world, from, { x: path.at[0], y: path.at[1], z: path.at[2] }) };
}

// ─── Levels ──────────────────────────────────────────────────────────────────────────────────

/** The level someone is on: the level of the floor or step under their feet, else the highest at or below them. */
export function levelAt(world: World, at: Feet): string | null {
  const on = placeAt(world, at.x, at.y, at.feet);
  if (on !== null) return on.level;
  const below = [...world.levels].filter((l) => l.elevation <= at.feet + 0.05).sort((a, b) => b.elevation - a.elevation)[0];
  return below?.id ?? world.levels[0]?.id ?? null;
}

/**
 * Where a level switch puts someone: straight above or below where they stand, on that level's floor,
 * when there is one there they fit on; else in the middle of that level's room nearest to them.
 */
export function levelTarget(world: World, level: string, at: { x: number; y: number }): { x: number; y: number; floor: number; room: string } | null {
  const floors = world.surfaces.filter((s) => s.kind === 'floor' && s.level === level);
  const here = floors.filter((s) => inSurface(at.x, at.y, s)).sort((a, b) => b.top - a.top)[0];
  if (here !== undefined && blocked(world, at.x, at.y, here.top) === null) return { x: at.x, y: at.y, floor: here.top, room: here.id };
  const centre = (s: Surface) => [(s.box.minX + s.box.maxX) / 2, (s.box.minY + s.box.maxY) / 2] as const;
  const near = [...floors].sort((a, b) => Math.hypot(centre(a)[0] - at.x, centre(a)[1] - at.y) - Math.hypot(centre(b)[0] - at.x, centre(b)[1] - at.y));
  for (const s of near) {
    const [x, y] = centre(s);
    if (inSurface(x, y, s) && blocked(world, x, y, s.top) === null) return { x, y, floor: s.top, room: s.id };
  }
  return null;
}

/** Where a VR walk starts: a room's middle, when one is chosen; else where the walkthrough starts (the entry). */
export function startOf(world: World, model: EditorModel, mesh: HouseMesh, room: string | null, level: string | null): { x: number; y: number; floor: number; yaw: number } | null {
  if (room !== null) {
    const s = world.surfaces.find((f) => f.kind === 'floor' && f.id === room);
    if (s !== undefined) {
      const t = levelTarget(world, s.level, { x: (s.box.minX + s.box.maxX) / 2, y: (s.box.minY + s.box.maxY) / 2 });
      if (t !== null) return { x: t.x, y: t.y, floor: t.floor, yaw: s.box.maxX - s.box.minX >= s.box.maxY - s.box.minY ? 0 : Math.PI / 2 };
    }
  }
  const w = entryOf(world, model, mesh, level);
  return w === null ? null : { x: w.x, y: w.y, floor: w.feet, yaw: w.yaw };
}

// ─── The rig: where the headset's space is put in the house ──────────────────────────────────

/**
 * Where the headset's reference space is in the house: its origin on the floor at (x, y), facing
 * `yaw` (radians anticlockwise from east, as a walker's heading), raised by `lift` — 0 standing on a
 * floor-level space; a seated person's, or a space whose origin is the head, lifted to eye height.
 */
export interface Rig {
  x: number;
  y: number;
  floor: number;
  yaw: number;
  lift: number;
}

type Quat = [number, number, number, number];

const mul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/**
 * The rig as a pose in the house: a position, and an orientation (x, y, z, w) that turns the
 * reference space's y-up, −z-ahead frame into the house's z up, facing `yaw`. Its inverse is the
 * offset WebXR's `getOffsetReferenceSpace` takes, so a pose in the offset space is in the house.
 */
export function rigPose(rig: Rig): { position: Vec3; orientation: Quat } {
  const s = Math.SQRT1_2;
  // y up to z up: a quarter turn about x. Then ahead (−z, now +y, north) turned to the heading.
  const upright: Quat = [s, 0, 0, s];
  const h = (rig.yaw - Math.PI / 2) / 2;
  const heading: Quat = [0, 0, Math.sin(h), Math.cos(h)];
  return { position: [rig.x, rig.y, rig.floor + rig.lift], orientation: mul(heading, upright) };
}

/** A point of the reference space (y up, metres) where the rig puts it in the house. */
export function toHouse(rig: Rig, local: Vec3): Vec3 {
  const { position, orientation: q } = rigPose(rig);
  const v: Quat = [local[0], local[1], local[2], 0];
  const r = mul(mul(q, v), [-q[0], -q[1], -q[2], q[3]]);
  return [r[0] + position[0], r[1] + position[1], r[2] + position[2]];
}

/** Turn the rig by `delta` radians about where the head is, so the person turns on the spot. */
export function turnRig(rig: Rig, head: { x: number; y: number }, delta: number): Rig {
  const c = Math.cos(delta);
  const s = Math.sin(delta);
  const dx = rig.x - head.x;
  const dy = rig.y - head.y;
  return { ...rig, x: head.x + c * dx - s * dy, y: head.y + s * dx + c * dy, yaw: Math.atan2(Math.sin(rig.yaw + delta), Math.cos(rig.yaw + delta)) };
}

/** Move the rig so the head stands over a teleport's target, on its floor. */
export function moveRig(rig: Rig, head: { x: number; y: number }, to: { x: number; y: number; floor: number }): Rig {
  return { ...rig, x: rig.x + (to.x - head.x), y: rig.y + (to.y - head.y), floor: to.floor };
}

/** The snap turn's step (the board: "Snap turn · 30°"), and a smooth turn's speed. */
export const SNAP = Math.PI / 6;
export const SMOOTH_TURN = Math.PI / 2;

/**
 * A thumbstick's turn: one snap each time it is pushed past the threshold (and let back), or with
 * snap turning off, a smooth turn while it is held. `armed` is whether the stick has come back.
 */
export function stickTurn(x: number, armed: boolean, snap: boolean, dt: number): { delta: number; armed: boolean } {
  if (!snap) return { delta: Math.abs(x) > 0.2 ? -x * SMOOTH_TURN * dt : 0, armed: true };
  if (armed && Math.abs(x) > 0.7) return { delta: x > 0 ? -SNAP : SNAP, armed: false };
  return { delta: 0, armed: armed || Math.abs(x) < 0.3 };
}

/** The headset browser's name, from what the browser says it is: for the "Headset ready" line. */
export function headsetBrowser(userAgent: string): string {
  if (/OculusBrowser/i.test(userAgent)) return 'Quest browser';
  if (/Wolvic/i.test(userAgent)) return 'Wolvic';
  if (/PicoBrowser/i.test(userAgent)) return 'Pico browser';
  if (/Macintosh/.test(userAgent) && /Safari/.test(userAgent) && !/Chrome|Chromium|Edg/.test(userAgent)) return 'Vision Pro Safari';
  if (/Chrome|Chromium/.test(userAgent)) return 'Chrome';
  return 'This browser';
}

/** A teleport's refusal in words, for the menu's line. */
export const NO_TELEPORT: Readonly<Record<NoTeleport, string>> = {
  'not-a-floor': 'Only floors and stairs',
  'too-high': 'Too far up: take the stair',
  'no-room': 'No room to stand there',
  'through-a-wall': 'Not through a wall',
  'a-wall': 'A wall is in the way',
  'a-ceiling': 'A ceiling is in the way',
  nothing: 'Point at a floor',
};
