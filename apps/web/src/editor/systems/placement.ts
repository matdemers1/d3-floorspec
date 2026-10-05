import type { LevelView, Point, WallView } from '../model';
import { add, cross, dist, faceAt, leftNormal, project, scale, sub } from '../geometry';
import type { DeviceKind, Mount } from './catalog';
import type { HostRef } from './ops';
import type { DeviceView } from './view';

/**
 * Where a device goes under the pointer (FLR-T-5.7): the host it would be placed on, worked out
 * from the level as the engine derived it. A wall mount snaps to the nearer face of the nearest
 * wall, at an offset along its location line rounded to the grid; a floor fixture in a room backs
 * onto a wall face when it is near one, facing into the room; a ceiling or floor device stays
 * where it is put, inside its room. The result is a host reference the applier resolves exactly —
 * the editor never computes a placement it then stores.
 */

export interface DeviceHover {
  host: HostRef;
  /** Where to draw the marker, in plan, and which way the device would face. */
  point: Point;
  facing: Point;
  /** For a wall face: which end the offset is measured from when one is typed. */
  nearer?: 'start' | 'end';
  /** A reason it cannot go here; undefined when it can. */
  problem?: string;
}

/** How far into the room a fixture backed onto a wall stands from the face: 10 mm, so its host point is strictly inside the room (Core 13.3.4). */
export const BACK_GAP = 12_800;
/** How near a wall face a floor fixture must be put to back onto it: 600 mm. */
export const BACK_REACH = 768_000;

const unit = (v: Point): Point => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

/** The direction of a vector as a Core angle: microdegrees, counter-clockwise from +X, in (−180°, 180°]. */
export function angleOf(v: Point): number {
  const deg = Math.round((Math.atan2(v[1], v[0]) * 180 * 1_000_000) / Math.PI);
  return deg === -180_000_000 ? 180_000_000 : deg;
}

/** The point on a wall's face, on one side, `offset` along its location line from the start junction (Core 13.1). */
export function facePoint(wall: WallView, side: 'left' | 'right', offset: number): Point {
  const t = unit(sub(wall.b, wall.a));
  const n = leftNormal(wall.a, wall.b);
  return add(add(wall.a, scale(t, offset)), scale(n, side === 'left' ? wall.left : -wall.right));
}

/** The nearest wall face to a point within `reach` of it: the wall, the side, and the offset along it. */
export function nearestFace(level: LevelView, p: Point, reach: number): { wall: WallView; side: 'left' | 'right'; offset: number; distance: number } | null {
  let best: { wall: WallView; side: 'left' | 'right'; offset: number; distance: number } | null = null;
  for (const wall of level.walls) {
    const L = dist(wall.a, wall.b);
    if (L === 0) continue;
    const pr = project(p, wall.a, wall.b);
    if (pr.t < 0 || pr.t > 1) continue;
    const side: 'left' | 'right' = cross(sub(wall.b, wall.a), sub(p, wall.a)) > 0 ? 'left' : 'right';
    // Distance to the face on that side, not to the location line.
    const distance = Math.max(0, pr.distance - (side === 'left' ? wall.left : wall.right));
    if (distance > reach) continue;
    if (best === null || distance < best.distance) best = { wall, side, offset: pr.t * L, distance };
  }
  return best;
}

/** Round to the grid, and keep within [0, max]. */
const snapTo = (v: number, grid: number, max: number) => Math.min(max, Math.max(0, Math.round(v / grid) * grid));

export interface HoverOptions {
  /** The editor's grid step: offsets and positions round to it. */
  grid: number;
  /** How near counts, in base units: the pointer's tolerance. */
  tol: number;
  /** A wall mount's height above the wall's base. */
  height: number;
  /** A floor or ceiling device's rotation, when it stands free of the walls. */
  rotation?: number;
}

/** The host a device of `mount` would be placed on at `p`, or null when nothing is near. */
export function hoverFor(level: LevelView, mount: Mount, p: Point, o: HoverOptions): DeviceHover | null {
  if (mount === 'wall') {
    // Reaching a wall from inside a room: half a wall thickness and the pointer's tolerance.
    const face = nearestFace(level, p, o.tol + 64_000);
    if (face === null) return null;
    const L = dist(face.wall.a, face.wall.b);
    const offset = snapTo(face.offset, o.grid, Math.floor(L));
    const n = leftNormal(face.wall.a, face.wall.b);
    return {
      host: { mode: 'wallFace', wall: face.wall.id, side: face.side, at: offset, height: o.height },
      point: facePoint(face.wall, face.side, offset),
      facing: face.side === 'left' ? n : scale(n, -1),
      nearer: offset <= L / 2 ? 'start' : 'end',
    };
  }
  const room = faceAt(level, p)?.room ?? null;
  if (room === null) {
    if (mount === 'ceiling') return { host: { mode: 'free', level: level.id, at: round(p, o.grid) }, point: round(p, o.grid), facing: [1, 0], problem: 'A ceiling device goes in a room: point inside one.' };
    const at = round(p, o.grid);
    return { host: { mode: 'free', level: level.id, at, ...(o.rotation === undefined ? {} : { rotation: o.rotation }) }, point: at, facing: [1, 0] };
  }
  if (mount === 'floorWall') {
    const face = nearestFace(level, p, BACK_REACH);
    if (face !== null) {
      const n = leftNormal(face.wall.a, face.wall.b);
      const inward = face.side === 'left' ? n : scale(n, -1);
      const L = dist(face.wall.a, face.wall.b);
      const offset = snapTo(face.offset, o.grid, Math.floor(L));
      const at = round(add(facePoint(face.wall, face.side, offset), scale(inward, BACK_GAP)), 1);
      // Backed onto a face that is not this room's — the far side of a wall — it stands free.
      if (faceAt(level, at)?.room === room) return { host: { mode: 'surface', room, surface: 'floor', at, rotation: angleOf(inward) }, point: at, facing: inward };
    }
  }
  const at = round(p, o.grid);
  const rotation = o.rotation ?? 0;
  const rad = (rotation / 1_000_000) * (Math.PI / 180);
  return { host: { mode: 'surface', room, surface: mount === 'ceiling' ? 'ceiling' : 'floor', at, ...(rotation === 0 ? {} : { rotation }) }, point: at, facing: [Math.cos(rad), Math.sin(rad)] };
}

const round = (p: Point, grid: number): [number, number] => [Math.round(p[0] / grid) * grid, Math.round(p[1] / grid) * grid];

/** The mount an existing device is moved by: its kind's, or what its host says. */
export function mountOf(device: DeviceView): Mount {
  const host = device.host;
  if (host?.['mode'] === 'wallFace') return 'wall';
  if (host?.['mode'] === 'surface' && host['surface'] === 'ceiling') return 'ceiling';
  if (device.kind?.mount === 'floorWall') return 'floorWall';
  return 'floor';
}

/** The host a dragged device would move to: the same kind of host, at the pointer, keeping its height and rotation. */
export function dragHost(level: LevelView, device: DeviceView, p: Point, o: Omit<HoverOptions, 'height' | 'rotation'>): DeviceHover | null {
  const host = device.host ?? {};
  const height = typeof host['height'] === 'number' ? host['height'] : 0;
  const rotation = typeof host['rotation'] === 'number' ? host['rotation'] : undefined;
  return hoverFor(level, mountOf(device), p, { ...o, height, ...(rotation === undefined ? {} : { rotation }) });
}

/** A wall's room-side face for a device centred on it: the side with a room, the right (interior) side first. */
export function roomSide(level: LevelView, wall: WallView): 'left' | 'right' {
  const mid: Point = [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2];
  const n = leftNormal(wall.a, wall.b);
  const probe = (side: 'left' | 'right') => faceAt(level, add(mid, scale(n, side === 'left' ? wall.left + 25_600 : -(wall.right + 25_600))))?.room ?? null;
  return probe('right') !== null || probe('left') === null ? 'right' : 'left';
}

/** The hover a device tool starts with when a wall is selected: centred on its room-side face. */
export function centredOn(level: LevelView, wall: WallView, kind: DeviceKind, height: number, grid: number): DeviceHover | null {
  if (kind.mount !== 'wall') return null;
  const L = dist(wall.a, wall.b);
  const side = roomSide(level, wall);
  const offset = Math.round(L / 2 / grid) * grid;
  const n = leftNormal(wall.a, wall.b);
  return { host: { mode: 'wallFace', wall: wall.id, side, at: offset, height }, point: facePoint(wall, side, offset), facing: side === 'left' ? n : scale(n, -1), nearer: 'start' };
}
