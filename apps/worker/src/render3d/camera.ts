/**
 * Where the headless 3D render looks from (FLR-T-8.5): the editor's named views — the four
 * isometric corners and the top (apps/web editor/three/camera.ts, the same azimuths and elevations)
 * — framed on what is drawn, or a person standing in a room: at eye height, in a doorway or a corner
 * clear of its furniture and fixtures, looking at what the room holds (FLR-T-12.29).
 *
 * Everything is in the scene's frame: metres, +Y up, Floorspec (x, y, z) at (x, z, −y).
 */
import type { SceneDoor, SceneObstacle, SceneRoom, Vec3 } from '../export/gltf/scene.js';

export const PRESETS = ['sw', 'se', 'ne', 'nw', 'top'] as const;
export type Preset = (typeof PRESETS)[number];

export interface Camera {
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
  /** Vertical field of view, degrees. */
  readonly fovY: number;
  readonly near: number;
  /** What the camera is, in words: "SW iso", "Kitchen (R3) from its doorway D2". */
  readonly label: string;
}

const DEG = Math.PI / 180;
const ISO = Math.atan(1 / Math.SQRT2);
/** The editor's presets: azimuth anticlockwise from east, elevation above the horizon. */
const ANGLES: Record<Preset, { azimuth: number; elevation: number; label: string }> = {
  sw: { azimuth: -135 * DEG, elevation: ISO, label: 'SW iso' },
  se: { azimuth: -45 * DEG, elevation: ISO, label: 'SE iso' },
  ne: { azimuth: 45 * DEG, elevation: ISO, label: 'NE iso' },
  nw: { azimuth: 135 * DEG, elevation: ISO, label: 'NW iso' },
  top: { azimuth: -90 * DEG, elevation: 90 * DEG, label: 'Top' },
};

/** Floorspec plan (x, y) and height z to the scene's frame. */
export const yUp = (x: number, y: number, z: number): Vec3 => [x, z, -y];

/** A named view framing a box: its bounding sphere fills the narrower field of view. */
export function presetCamera(preset: Preset, box: { min: Vec3; max: Vec3 }, aspect: number): Camera {
  const a = ANGLES[preset];
  const fovY = 30;
  const target: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const radius = Math.max(0.5, Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2);
  const vertical = (fovY * DEG) / 2;
  const horizontal = Math.atan(Math.tan(vertical) * aspect);
  const distance = (radius / Math.sin(Math.min(vertical, horizontal))) * 1.02;
  const c = Math.cos(a.elevation);
  // Floorspec's direction to the eye, (cos az cos el, sin az cos el, sin el), in the scene's frame.
  const dir = yUp(c * Math.cos(a.azimuth), c * Math.sin(a.azimuth), Math.sin(a.elevation));
  const eye: Vec3 = [target[0] + dir[0] * distance, target[1] + dir[1] * distance, target[2] + dir[2] * distance];
  // Straight down, north is up the picture.
  const up: Vec3 = preset === 'top' ? yUp(0, 1, 0) : [0, 1, 0];
  return { eye, target, up, fovY, near: Math.max(0.05, distance - radius * 1.5), label: a.label };
}

export function inside(pt: readonly [number, number], ring: readonly (readonly [number, number])[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The area centroid of a ring (its vertex mean for a degenerate one). */
export function centroid(ring: readonly (readonly [number, number])[]): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j]!;
    const [x1, y1] = ring[i]!;
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-12) return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Find a room by its ID, or by its name (any case). */
export function findRoom(rooms: readonly SceneRoom[], key: string): SceneRoom | undefined {
  return rooms.find((r) => r.id === key) ?? rooms.find((r) => r.name?.toLowerCase() === key.toLowerCase()) ?? rooms.find((r) => r.id.toLowerCase() === key.toLowerCase());
}

/** Clear floor a person keeps between the eye and any fixture or piece of furniture, metres. */
export const CLEARANCE = 0.3;
/** Half the picture's width, a little inside it: 68° high at 4:3 is about 42° either side. */
const HALF_VIEW = 40 * DEG;
/** A footprint smaller than this (m²) — a receptacle, a switch — is not something to look at. */
const SMALL = 0.05;
/** Nearer than this to what it looks at, a camera sees its feet. */
const NEAR_TARGET = 1;

type Pt = readonly [number, number];

/** The distance from a point to a ring's boundary. */
function edgeDistance(pt: Pt, ring: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]!;
    const [bx, by] = ring[i]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(pt[0] - (ax + t * dx), pt[1] - (ay + t * dy)));
  }
  return best;
}

/** How far a point is from a footprint: 0 inside it. */
function clearOf(pt: Pt, ring: readonly Pt[]): number {
  return inside(pt, ring) ? 0 : edgeDistance(pt, ring);
}

function area(ring: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  return Math.abs(a) / 2;
}

/** Where a camera might stand, and how its label says so. */
interface Spot {
  readonly at: [number, number];
  readonly from: string;
}

/**
 * A person in a room (FLR-T-8.5, FLR-T-12.29), at eye height (1.6 m, lower under a low ceiling),
 * looking a little down through a wide lens at what the room holds — the middle of its fixtures and
 * furniture (the extension elements standing in it below the eye), or the middle of the room when
 * it holds none.
 *
 * Where they stand: never inside an extension element's footprint (`obstacles`, every element on
 * the room's level, whatever its height) nor within 0.3 m of one, and at least a metre from what
 * they look at. The spots tried, in order: just inside each doorway into the room (doors by ID, a
 * step further in when the first is blocked), then each corner stepped toward the middle (the
 * corner farthest from the middle first), then the middle itself. Of the spots that are clear, the
 * one that sees the most of the room's contents in its picture wins, the earlier spot on a tie — so
 * a doorway before a corner — and the same model always gives the same camera. With no clear spot
 * among those, the clearest point of the room's floor; with none at all, its far corner.
 */
export function roomCamera(room: SceneRoom, doors: readonly SceneDoor[], obstacles: readonly SceneObstacle[] = []): Camera {
  const c = centroid(room.outer);
  const eyeZ = room.floor + Math.min(1.6, Math.max(0.3, (room.ceiling - room.floor) * 0.62));
  const here = obstacles.filter((o) => o.level === room.level).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // What the room holds: what stands in it below the eye and is big enough to look at.
  const contents = here.filter((o) => o.bottom < eyeZ && area(o.footprint) >= SMALL).map((o) => centroid(o.footprint)).filter((p) => inside(p, room.outer));
  let look: [number, number] = contents.length === 0 ? c : [contents.reduce((s, p) => s + p[0], 0) / contents.length, contents.reduce((s, p) => s + p[1], 0) / contents.length];
  const clearance = (p: Pt): number => here.reduce((m, o) => Math.min(m, clearOf(p, o.footprint)), Infinity);
  const standable = (p: Pt): boolean => inside(p, room.outer) && clearance(p) >= CLEARANCE;
  const corners = room.outer.map((p, i) => ({ p, i, far: Math.hypot(p[0] - c[0], p[1] - c[1]) })).sort((a, b) => b.far - a.far || a.i - b.i);

  /** The spots, each the first of its places that passes `ok`. */
  const spotsWhere = (ok: (p: Pt) => boolean): Spot[] => {
    const spots: Spot[] = [];
    for (const d of [...doors].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (d.level !== room.level) continue;
      const step = (s: number, depth: number): [number, number] => [d.mid[0] + s * d.normal[0] * (d.halfThickness + depth), d.mid[1] + s * d.normal[1] * (d.halfThickness + depth)];
      const side = [1, -1].find((s) => inside(step(s, 0.45), room.outer));
      if (side === undefined) continue;
      const at = [0.45, 0.9].map((depth) => step(side, depth)).find(ok);
      if (at !== undefined) spots.push({ at, from: ` from its doorway ${d.id}` });
    }
    for (const { p, far } of corners) {
      const at = [0.45, 0.7, 1, 1.5].map((step): [number, number] => [p[0] + ((c[0] - p[0]) / Math.max(far, 1e-9)) * step, p[1] + ((c[1] - p[1]) / Math.max(far, 1e-9)) * step]).find(ok);
      if (at !== undefined) spots.push({ at, from: ' from its corner' });
    }
    if (ok(c)) spots.push({ at: [c[0], c[1]], from: ' from its middle' });
    return spots;
  };
  const away = (p: Pt): number => Math.hypot(look[0] - p[0], look[1] - p[1]);
  let spots = spotsWhere((p) => standable(p) && away(p) >= NEAR_TARGET);
  // A room too small to stand a metre from its middle: as far as it allows.
  if (spots.length === 0) spots = spotsWhere((p) => standable(p) && away(p) >= 0.25);

  // How many of the room's contents each spot's picture holds.
  const seen = (at: Pt): number => {
    const ahead = Math.atan2(look[1] - at[1], look[0] - at[0]);
    let n = 0;
    for (const q of contents) {
      if (Math.hypot(q[0] - at[0], q[1] - at[1]) < CLEARANCE) continue;
      let off = Math.atan2(q[1] - at[1], q[0] - at[0]) - ahead;
      off = Math.atan2(Math.sin(off), Math.cos(off));
      if (Math.abs(off) <= HALF_VIEW) n++;
    }
    return n;
  };
  let spot: Spot | undefined;
  let best = -1;
  for (const s of spots) {
    const n = seen(s.at);
    if (n > best) {
      best = n;
      spot = s;
    }
  }
  spot ??= openFloor(room, clearance) ?? farCorner(room, c, corners[0]!);

  const at = spot.at;
  const eye = yUp(at[0], at[1], eyeZ);
  if (away(at) < 0.25) {
    // Standing on what it would look at: look at the farthest corner instead.
    const far = room.outer.reduce((f, p) => (Math.hypot(p[0] - at[0], p[1] - at[1]) > Math.hypot(f[0] - at[0], f[1] - at[1]) ? p : f), room.outer[0]!);
    look = [far[0], far[1]];
  }
  const flat = Math.hypot(look[0] - at[0], look[1] - at[1]);
  // What the room holds, a little below the eye: the floor in the bottom of the picture.
  const target = yUp(look[0], look[1], eyeZ - Math.max(0.25, flat * 0.18));
  const name = room.name === undefined ? room.id : `${room.name} (${room.id})`;
  return { eye, target, up: [0, 1, 0], fovY: 68, near: 0.05, label: `${name}${spot.from}` };
}

/** The point of a room's floor farthest from anything in it, on a 0.1 m grid: for a room too full for every other spot. */
function openFloor(room: SceneRoom, clearance: (p: Pt) => number): Spot | undefined {
  const xs = room.outer.map((p) => p[0]);
  const ys = room.outer.map((p) => p[1]);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  const [nx, ny] = [Math.ceil((Math.max(...xs) - x0) / 0.1), Math.ceil((Math.max(...ys) - y0) / 0.1)];
  let found: [number, number] | undefined;
  let best = 0;
  for (let j = 1; j < ny; j++)
    for (let i = 1; i < nx; i++) {
      const p: [number, number] = [x0 + i * 0.1, y0 + j * 0.1];
      if (!inside(p, room.outer)) continue;
      // Away from the walls too: a person stands in the room, not in its wall.
      const m = Math.min(clearance(p), edgeDistance(p, room.outer));
      if (m > best) {
        best = m;
        found = p;
      }
    }
  return found === undefined ? undefined : { at: found, from: ' from its open floor' };
}

/** The corner farthest from the middle, stepped in until it is in the room. */
function farCorner(room: SceneRoom, c: Pt, corner: { p: Pt; far: number }): Spot {
  let at: [number, number] = [corner.p[0], corner.p[1]];
  for (const step of [0.45, 0.7, 1, 1.5]) {
    const len = Math.max(corner.far, 1e-9);
    at = [corner.p[0] + ((c[0] - corner.p[0]) / len) * step, corner.p[1] + ((c[1] - corner.p[1]) / len) * step];
    if (inside(at, room.outer)) break;
  }
  return { at, from: ' from its far corner' };
}
