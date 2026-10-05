/**
 * Where the headless 3D render looks from (FLR-T-8.5): the editor's named views — the four
 * isometric corners and the top (apps/web editor/three/camera.ts, the same azimuths and elevations)
 * — framed on what is drawn, or a person standing in a room: at eye height in its doorway, or else
 * in its far corner, looking at the middle of the room.
 *
 * Everything is in the scene's frame: metres, +Y up, Floorspec (x, y, z) at (x, z, −y).
 */
import type { SceneDoor, SceneRoom, Vec3 } from '../export/gltf/scene.js';

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

function inside(pt: readonly [number, number], ring: readonly (readonly [number, number])[]): boolean {
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

/**
 * A person in a room: in its doorway (just inside, the first door by ID that opens into it), else in
 * the corner farthest from its middle, at eye height (1.6 m, lower under a low ceiling), looking at
 * the middle of the room a little below eye height, through a wide lens.
 */
export function roomCamera(room: SceneRoom, doors: readonly SceneDoor[]): Camera {
  const c = centroid(room.outer);
  const eyeZ = room.floor + Math.min(1.6, Math.max(0.3, (room.ceiling - room.floor) * 0.62));
  let at: [number, number] | undefined;
  let from = '';
  for (const d of [...doors].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (d.level !== room.level) continue;
    for (const s of [1, -1]) {
      const p: [number, number] = [d.mid[0] + s * d.normal[0] * (d.halfThickness + 0.45), d.mid[1] + s * d.normal[1] * (d.halfThickness + 0.45)];
      if (inside(p, room.outer)) {
        at = p;
        from = ` from its doorway ${d.id}`;
        break;
      }
    }
    if (at !== undefined) break;
  }
  if (at === undefined) {
    let far = room.outer[0]!;
    let best = -1;
    for (const p of room.outer) {
      const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
      if (d > best) {
        best = d;
        far = p;
      }
    }
    for (const step of [0.45, 0.7, 1, 1.5]) {
      const len = Math.max(best, 1e-9);
      const p: [number, number] = [far[0] + ((c[0] - far[0]) / len) * step, far[1] + ((c[1] - far[1]) / len) * step];
      at = p;
      if (inside(p, room.outer)) break;
    }
    from = ' from its far corner';
  }
  const eye = yUp(at![0], at![1], eyeZ);
  const flat = Math.hypot(c[0] - at![0], c[1] - at![1]);
  // The middle of the room, a little below the eye: the floor in the bottom of the picture.
  const target = yUp(c[0], c[1], eyeZ - Math.max(0.25, flat * 0.18));
  const name = room.name === undefined ? room.id : `${room.name} (${room.id})`;
  return { eye, target, up: [0, 1, 0], fovY: 68, near: 0.05, label: `${name}${from}` };
}
