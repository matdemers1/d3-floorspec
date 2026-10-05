/**
 * An exact triangle mesh: vertices are points in base units — integers wherever the document's
 * geometry is (every value the engine derives is rounded once to an integer) — deduplicated by
 * value, so faces that share a point share a vertex and a closed set of faces is watertight by
 * construction. Planar faces are triangulated by manifold-3d's polygon triangulator, which only
 * returns indices: no vertex is moved or created.
 */
import type { Kernel } from './kernel.js';
import type { Vec3 } from './types.js';

export type P3 = readonly [number, number, number];
export type P2 = readonly [number, number];

export class MeshBuilder {
  readonly verts: number[] = [];
  readonly tris: number[] = [];
  private readonly index = new Map<string, number>();
  private readonly kernel: Kernel;

  constructor(kernel: Kernel) {
    this.kernel = kernel;
  }

  vertex(p: P3): number {
    const key = `${p[0]},${p[1]},${p[2]}`;
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.verts.length / 3;
      this.verts.push(p[0], p[1], p[2]);
      this.index.set(key, i);
    }
    return i;
  }

  point(i: number): Vec3 {
    return [this.verts[3 * i]!, this.verts[3 * i + 1]!, this.verts[3 * i + 2]!];
  }

  tri(a: number, b: number, c: number): void {
    if (a === b || b === c || c === a) return;
    this.tris.push(a, b, c);
  }

  /** A planar quad a → b → c → d (counter-clockwise from outside) as two triangles; a degenerate one as what remains. */
  quad(a: P3, b: P3, c: P3, d: P3): void {
    const ids = dedupe([a, b, c, d].map((p) => [this.vertex(p)] as const)).map((x) => x[0]);
    if (ids.length >= 3) this.tri(ids[0]!, ids[1]!, ids[2]!);
    if (ids.length === 4) this.tri(ids[0]!, ids[2]!, ids[3]!);
  }

  /**
   * A planar face: an outer ring and holes, the outer ring counter-clockwise seen from the side the
   * face faces and every hole clockwise. Triangulated in the coordinate plane its normal is closest
   * to. Returns false, adding nothing, for a face with no area.
   */
  face(rings: readonly (readonly P3[])[]): boolean {
    const outer = rings[0];
    if (!outer || outer.length < 3) return false;
    const N = newell(outer);
    const ax = Math.abs(N[0]) >= Math.abs(N[1]) && Math.abs(N[0]) >= Math.abs(N[2]) ? 0 : Math.abs(N[1]) >= Math.abs(N[2]) ? 1 : 2;
    if (N[ax] === 0) return false;
    // Drop the dominant axis, keeping a right-handed pair: (y, z) for x, (z, x) for y, (x, y) for z.
    const [u, v] = (ax === 0 ? [1, 2] : ax === 1 ? [2, 0] : [0, 1]) as [0 | 1 | 2, 0 | 1 | 2];
    const flip = N[ax] < 0;
    const o = outer[0]!;
    const all: P3[] = [];
    const polys: [number, number][][] = [];
    for (const ring of rings) {
      const r = flip ? [...ring].reverse() : ring;
      polys.push(r.map((p) => [p[u] - o[u], p[v] - o[v]]));
      all.push(...r);
    }
    const tris = this.kernel.triangulate(polys);
    const ids = all.map((p) => this.vertex(p));
    for (const [a, b, c] of tris) {
      if (flip) this.tri(ids[a]!, ids[c]!, ids[b]!);
      else this.tri(ids[a]!, ids[b]!, ids[c]!);
    }
    return true;
  }

  /**
   * A prism: a plan polygon (outer ring counter-clockwise, holes clockwise) from z0 up to z1, closed:
   * its top facing up, its bottom down and a quad on every edge of every ring.
   */
  prism(rings: readonly (readonly P2[])[], z0: number, z1: number): void {
    const at = (z: number) => (p: P2): P3 => [p[0], p[1], z];
    this.face(rings.map((r) => r.map(at(z1))));
    this.face(rings.map((r) => [...r].reverse().map(at(z0))));
    for (const r of rings)
      for (let i = 0; i < r.length; i++) {
        const p = r[i]!;
        const q = r[(i + 1) % r.length]!;
        this.quad([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1]);
      }
  }

  /** A surface: a plan polygon at elevation z, facing up or down. */
  sheet(rings: readonly (readonly P2[])[], z: number, facing: 'up' | 'down'): void {
    this.face(rings.map((r) => (facing === 'up' ? r : [...r].reverse()).map((p): P3 => [p[0], p[1], z])));
  }

  /** The least and greatest coordinates of the vertices used by a triangle. */
  box(): { min: Vec3; max: Vec3 } | undefined {
    if (!this.tris.length) return undefined;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const i of this.tris)
      for (let k = 0; k < 3; k++) {
        const c = this.verts[3 * i + k]!;
        if (c < min[k]!) min[k] = c;
        if (c > max[k]!) max[k] = c;
      }
    return { min, max };
  }

  /**
   * Six times the signed volume, exactly, when every coordinate is an integer: the sum over the
   * triangles of det(a, b, c), the divergence theorem with the origin as apex.
   */
  volume6(): bigint {
    let s = 0n;
    const B = (i: number): [bigint, bigint, bigint] => [BigInt(this.verts[3 * i]!), BigInt(this.verts[3 * i + 1]!), BigInt(this.verts[3 * i + 2]!)];
    for (let t = 0; t < this.tris.length; t += 3) {
      const [a, b, c] = [B(this.tris[t]!), B(this.tris[t + 1]!), B(this.tris[t + 2]!)];
      s += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    return s;
  }

  /** Is every coordinate of a vertex an integer (so `volume6` is exact)? */
  integral(): boolean {
    return this.verts.every(Number.isSafeInteger);
  }
}

/** Newell's normal of a ring: its direction is the face's, its length twice the area. */
export function newell(ring: readonly P3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  const o = ring[0]!;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    const [px, py, pz] = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const [qx, qy, qz] = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
    x += (py - qy) * (pz + qz);
    y += (pz - qz) * (px + qx);
    z += (px - qx) * (py + qy);
  }
  return [x, y, z];
}

/** A ring with every vertex equal to the one before it removed (the first counts as following the last). */
export function dedupe<T extends readonly number[]>(ring: readonly T[]): T[] {
  const out: T[] = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || p.some((c, i) => c !== q[i])) out.push(p);
  }
  while (out.length > 1 && out[0]!.every((c, i) => c === out[out.length - 1]![i])) out.pop();
  return out;
}
