import type { Vec3 } from '@floorspec/mesh';
import { prettyLen, type UnitSystem } from '../../units';

/**
 * The tape measure in 3D (FLR-T-14.8, the board's frame "14.8 · Edit in 3D — a window slid along its
 * wall, the tape measure, undo"): click a point on the house, then another — each snapping to a
 * corner, then to an edge, then to the face under the pointer — and the length between them shows
 * with its Δx, Δy and Δz in the project's units; each further click chains on from the last.
 */

/** A point of a triangle: where it is (metres, the mesh's frame) and where it is on screen (CSS pixels). */
export interface Corner {
  world: Vec3;
  screen: readonly [number, number];
}

export type SnapKind = 'vertex' | 'edge' | 'face';

export interface TapePoint {
  /** Metres, the mesh's frame. */
  at: Vec3;
  kind: SnapKind;
}

/** How near on screen a corner pulls the point to it, and an edge. */
export const VERTEX_PX = 10;
export const EDGE_PX = 6;

/**
 * Whether an edge is one a person sees: along x, y or z. A house's faces are triangulated, and a
 * quad's diagonal is an edge of its triangles that is not one of the house's — the tape snaps only
 * to edges that run square with the house's axes, which every diagonal of a wall or an opening does not.
 */
export function squareEdge(a: Vec3, b: Vec3): boolean {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  if (l < 1e-6) return false;
  return Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])) / l > 0.9998;
}

/**
 * Where a click on a triangle lands: its nearest corner within VERTEX_PX on screen, else the nearest
 * point of an edge within EDGE_PX, else the point under the pointer.
 */
export function snapOnTriangle(hit: Vec3, pointer: readonly [number, number], tri: readonly [Corner, Corner, Corner]): TapePoint {
  let best: { d: number; at: Vec3 } | null = null;
  for (const c of tri) {
    const d = Math.hypot(c.screen[0] - pointer[0], c.screen[1] - pointer[1]);
    if (d <= VERTEX_PX && (best === null || d < best.d)) best = { d, at: c.world };
  }
  if (best !== null) return { at: [...best.at], kind: 'vertex' };
  let edge: { d: number; at: Vec3 } | null = null;
  for (let i = 0; i < 3; i++) {
    const a = tri[i] as Corner;
    const b = tri[(i + 1) % 3] as Corner;
    if (!squareEdge(a.world, b.world)) continue;
    const ex = b.screen[0] - a.screen[0];
    const ey = b.screen[1] - a.screen[1];
    const l2 = ex * ex + ey * ey;
    if (l2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((pointer[0] - a.screen[0]) * ex + (pointer[1] - a.screen[1]) * ey) / l2));
    const d = Math.hypot(a.screen[0] + t * ex - pointer[0], a.screen[1] + t * ey - pointer[1]);
    if (d > EDGE_PX || (edge !== null && d >= edge.d)) continue;
    // The same share of the way along in 3D: exact for an orthographic camera, near enough for a short edge in perspective.
    edge = { d, at: [a.world[0] + t * (b.world[0] - a.world[0]), a.world[1] + t * (b.world[1] - a.world[1]), a.world[2] + t * (b.world[2] - a.world[2])] };
  }
  if (edge !== null) return { at: edge.at, kind: 'edge' };
  return { at: [...hit], kind: 'face' };
}

/** A measurement as read: its length, and how far it runs along x, y and z, each in base units. */
export interface Reading {
  length: number;
  dx: number;
  dy: number;
  dz: number;
}

const UNITS = 1_280_000;

/** From `a` to `b` (metres), in base units, to the base unit. */
export function readingOf(a: Vec3, b: Vec3): Reading {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]].map((v) => v * UNITS) as [number, number, number];
  return { length: Math.round(Math.hypot(d[0], d[1], d[2])), dx: Math.round(Math.abs(d[0])), dy: Math.round(Math.abs(d[1])), dz: Math.round(Math.abs(d[2])) };
}

/** A reading as the tape's card says it: "12′-4½″" over "Δx 10′-2″ · Δy 7′-0″ · Δz 0″". */
export function readout(r: Reading, units: UnitSystem): { length: string; deltas: string } {
  const len = (v: number) => tidy(prettyLen(v, units));
  return { length: len(r.length), deltas: `Δx ${len(r.dx)} · Δy ${len(r.dy)} · Δz ${len(r.dz)}` };
}

/** Feet and inches with the typographic primes the board writes; millimetres as they are. */
function tidy(s: string): string {
  return s.replace(/'/g, '′').replace(/"/g, '″');
}

/** The chain's whole length, base units. */
export function chainLength(points: readonly Vec3[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += readingOf(points[i - 1] as Vec3, points[i] as Vec3).length;
  return n;
}
