/**
 * Where the ground opens for a sunken pool (FLR-T-15.2, FS_outdoor 2.2): the worker's renders lay
 * their ground under everything drawn but FS_outdoor's pools — a pool's floor, 5′ under the lawn, is
 * not the ground — and leave a hole in it over each pool that goes below it: the plate a headless
 * render and a plain still draw is a grid with those cells left out, and the path tracer's ground
 * plane is not hit inside one (trace.ts `ground.holes`), so the pool's coping, water and basin are seen.
 *
 * Metres, +Y up, as the scene is; a hole is a pool's outline in plan, `[x, z]`, its points' convex hull.
 */
import type { SceneNode, Vec3 } from '../export/gltf/scene.js';

export type Hole = readonly (readonly [number, number])[];

/** Whether a node is an FS_outdoor pool. */
export const isPool = (node: Pick<SceneNode, 'extension'>): boolean => node.extension?.name === 'FS_outdoor' && node.extension.collection === 'pools';

/** The convex hull of points, counter-clockwise (Andrew's monotone chain). */
export function hull(points: readonly (readonly [number, number])[]): [number, number][] {
  const p = [...points].map((q): [number, number] => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]) => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const half = (pts: [number, number][]): [number, number][] => {
    const out: [number, number][] = [];
    for (const q of pts) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, q) <= 0) out.pop();
      out.push(q);
    }
    return out;
  };
  const lower = half(p);
  const upper = half([...p].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Whether (x, z) is inside a hole (even-odd). */
export function inHole(x: number, z: number, h: Hole): boolean {
  let c = false;
  for (let i = 0, j = h.length - 1; i < h.length; j = i++) {
    const [xi, zi] = h[i]!;
    const [xj, zj] = h[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

export const inHoles = (x: number, z: number, holes: readonly Hole[]): boolean => holes.some((h) => inHole(x, z, h));

/** Gathers what is drawn: its bounds, the bounds of all but the pools, and each pool's points. */
export class GroundGatherer {
  readonly min: Vec3 = [Infinity, Infinity, Infinity];
  readonly max: Vec3 = [-Infinity, -Infinity, -Infinity];
  /** The lowest of everything but the pools. */
  restLow = Infinity;
  private readonly pools = new Map<string, { low: number; xz: [number, number][] }>();

  add(node: Pick<SceneNode, 'id' | 'extension'>, x: number, y: number, z: number): void {
    if (x < this.min[0]) this.min[0] = x;
    if (y < this.min[1]) this.min[1] = y;
    if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x;
    if (y > this.max[1]) this.max[1] = y;
    if (z > this.max[2]) this.max[2] = z;
    if (!isPool(node)) {
      if (y < this.restLow) this.restLow = y;
      return;
    }
    const p = this.pools.get(node.id) ?? { low: Infinity, xz: [] };
    p.low = Math.min(p.low, y);
    p.xz.push([x, z]);
    this.pools.set(node.id, p);
  }

  /** The ground's height: under everything but the pools (under the pools too when nothing else is drawn). */
  get ground(): number {
    return Number.isFinite(this.restLow) ? this.restLow : this.min[1];
  }

  /** The pools below the ground, as holes. */
  get holes(): Hole[] {
    const g = this.ground;
    return [...this.pools.values()].filter((p) => p.low < g - 1e-3).map((p) => hull(p.xz));
  }
}

/**
 * A ground plate at height `y`, centred on (cx, cz) and `r` each way, as triangles of corner points
 * (counter-clockwise seen from above): two, or — with holes — a grid of `cell`-metre squares round
 * the holes' bounds, the squares whose centre is inside a hole left out, and four strips beyond.
 */
export function platePoints(cx: number, cz: number, r: number, y: number, holes: readonly Hole[], cell = 0.25): Vec3[][] {
  const quad = (x0: number, z0: number, x1: number, z1: number): Vec3[][] => [
    [[x0, y, z1], [x1, y, z1], [x1, y, z0]],
    [[x0, y, z1], [x1, y, z0], [x0, y, z0]],
  ];
  if (holes.length === 0) return quad(cx - r, cz - r, cx + r, cz + r);
  const xs = holes.flatMap((h) => h.map((p) => p[0]));
  const zs = holes.flatMap((h) => h.map((p) => p[1]));
  const x0 = Math.min(...xs) - cell;
  const z0 = Math.min(...zs) - cell;
  const nx = Math.ceil((Math.max(...xs) + cell - x0) / cell);
  const nz = Math.ceil((Math.max(...zs) + cell - z0) / cell);
  const x1 = x0 + nx * cell;
  const z1 = z0 + nz * cell;
  const out: Vec3[][] = [
    ...quad(cx - r, cz - r, x0, cz + r),
    ...quad(x1, cz - r, cx + r, cz + r),
    ...quad(x0, cz - r, x1, z0),
    ...quad(x0, z1, x1, cz + r),
  ];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++) {
      const ax = x0 + i * cell;
      const az = z0 + j * cell;
      if (inHoles(ax + cell / 2, az + cell / 2, holes)) continue;
      out.push(...quad(ax, az, ax + cell, az + cell));
    }
  return out;
}
