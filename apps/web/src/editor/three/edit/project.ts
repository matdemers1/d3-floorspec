import type { Vec3 } from '@floorspec/mesh';
import type { Point, WallView } from '../../model';
import { leftNormal } from '../../geometry';

/**
 * From the pointer in 3D to a host (FLR-T-14.8): the pointer's ray through the camera met with the
 * plane an item moves in — the floor (or ceiling) it stands on, at the height it was grabbed, for an
 * item on a floor; the face of its wall for one on a wall; its wall's location line, upright, for an
 * opening — and taken back to the document's plan, base units. Items move only on their host: the
 * plane is the host's, so a drag can never lift an armchair off the floor or a picture off its wall.
 *
 * Metres are the mesh's frame (about its origin, z up); base units the document's (1/1280 mm).
 */

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/** Where the ray meets the level plane z = `z`, or null when it runs along it or away from it. */
export function onLevel(ray: Ray, z: number): Vec3 | null {
  const dz = ray.dir[2];
  if (Math.abs(dz) < 1e-9) return null;
  const t = (z - ray.origin[2]) / dz;
  if (t <= 0) return null;
  return [ray.origin[0] + t * ray.dir[0], ray.origin[1] + t * ray.dir[1], z];
}

/**
 * Where the ray meets the upright plane through `p` (metres, plan) with the horizontal normal `n`,
 * or null when it runs along it (within a degree or so) or away from it.
 */
export function onUpright(ray: Ray, p: readonly [number, number], n: readonly [number, number]): Vec3 | null {
  const denom = ray.dir[0] * n[0] + ray.dir[1] * n[1];
  if (Math.abs(denom) < 0.02) return null;
  const t = ((p[0] - ray.origin[0]) * n[0] + (p[1] - ray.origin[1]) * n[1]) / denom;
  if (t <= 0) return null;
  return [ray.origin[0] + t * ray.dir[0], ray.origin[1] + t * ray.dir[1], ray.origin[2] + t * ray.dir[2]];
}

/** A point in the mesh's frame (metres) in the document's plan (base units, unrounded). */
export function toPlan(p: Vec3, origin: Vec3, k: number): Point {
  return [origin[0] + p[0] * k, origin[1] + p[1] * k];
}

/** A height in the mesh's frame (metres) in the document's (base units, unrounded). */
export function toElevation(z: number, origin: Vec3, k: number): number {
  return origin[2] + z * k;
}

/** A point in the document (base units) in the mesh's frame (metres). */
export function toMetres(p: readonly [number, number], z: number, origin: Vec3, k: number): Vec3 {
  return [(p[0] - origin[0]) / k, (p[1] - origin[1]) / k, (z - origin[2]) / k];
}

/** A wall's face as an upright plane in the mesh's frame: a point on it and its normal, out of the wall on `side`. */
export function faceOf(wall: Pick<WallView, 'a' | 'b' | 'left' | 'right'>, side: 'left' | 'right', origin: Vec3, k: number): { p: [number, number]; n: [number, number] } {
  const n = leftNormal(wall.a, wall.b);
  const off = side === 'left' ? wall.left : -wall.right;
  const out: [number, number] = side === 'left' ? [n[0], n[1]] : [-n[0], -n[1]];
  return { p: [(wall.a[0] + n[0] * off - origin[0]) / k, (wall.a[1] + n[1] * off - origin[1]) / k], n: out };
}

/** A wall's location line as an upright plane in the mesh's frame. */
export function lineOf(wall: Pick<WallView, 'a' | 'b'>, origin: Vec3, k: number): { p: [number, number]; n: [number, number] } {
  const n = leftNormal(wall.a, wall.b);
  return { p: [(wall.a[0] - origin[0]) / k, (wall.a[1] - origin[1]) / k], n: [n[0], n[1]] };
}

/** How far along a wall from its start a plan point is, base units (its projection on the location line). */
export function alongWall(wall: Pick<WallView, 'a' | 'b'>, p: Point): number {
  const dx = wall.b[0] - wall.a[0];
  const dy = wall.b[1] - wall.a[1];
  const l = Math.hypot(dx, dy) || 1;
  return ((p[0] - wall.a[0]) * dx + (p[1] - wall.a[1]) * dy) / l;
}

/**
 * A wall mount dragged on its face (FLR-T-14.8): its offset along the wall by as far as the pointer
 * went along it, and its height by as far as it went up — each by the grid unless `free`, kept on the
 * wall (an offset within it, a height not below its base). `snapAlong` lines the offset up (the smart
 * guides, in plan). The wall and the side are the item's own: it never leaves its face.
 */
export function faceDrag(o: { offset: number; height: number; length: number; along: number; up: number; grid: number; free: boolean; snapAlong?: (offset: number) => number }): { offset: number; height: number } {
  const step = (v: number) => (o.free ? Math.round(v) : Math.round(v / o.grid) * o.grid);
  let offset = o.offset + step(o.along);
  if (o.snapAlong !== undefined && !o.free) offset = o.snapAlong(offset);
  offset = Math.max(0, Math.min(Math.floor(o.length), Math.round(offset)));
  const height = Math.max(0, o.height + step(o.up));
  return { offset, height };
}

/** The compass words for a move in plan (+x east, +y north): "2′-1″ east, 8″ south" — with `len` formatting a length. */
export function moveWords(d: Point, len: (v: number) => string): string {
  const parts: string[] = [];
  if (Math.round(d[0]) !== 0) parts.push(`${len(Math.abs(Math.round(d[0])))} ${d[0] > 0 ? 'east' : 'west'}`);
  if (Math.round(d[1]) !== 0) parts.push(`${len(Math.abs(Math.round(d[1])))} ${d[1] > 0 ? 'north' : 'south'}`);
  return parts.join(', ');
}
