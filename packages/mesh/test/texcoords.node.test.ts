import { beforeAll, describe, expect, it } from 'vitest';
import { flatShaded, loadMesher, worldCoordinates, slopeST, boxST, isSlope, type HouseMesh, type MeshPart } from '../src/index.js';
import { ranch } from './houses.js';

/**
 * FLR-T-13.6: world-scale texture coordinates where Core 18.3 defines none — a roof laid along its
 * slopes, everything else by a box projection — are an isometry of each face: a texture laid with
 * them is its real-world size on any pitch, on a counter's top and on its edge.
 */

const M = 1_280_000;
let house: HouseMesh;

beforeAll(async () => {
  const mesher = await loadMesher();
  house = mesher.meshDocument(ranch());
});

/** Every triangle's edges, in metres in 3D and in (s, t). */
function edges(part: MeshPart, origin: HouseMesh['origin']): { d3: number; dst: number; slope: boolean }[] {
  const { positions } = flatShaded(part.mesh);
  const st = worldCoordinates(part.kind, positions, origin, M);
  const out: { d3: number; dst: number; slope: boolean }[] = [];
  for (let t = 0; t < positions.length / 9; t++) {
    const p = (j: number) => [positions[9 * t + 3 * j]!, positions[9 * t + 3 * j + 1]!, positions[9 * t + 3 * j + 2]!] as const;
    const q = (j: number) => [st[6 * t + 2 * j]! / M, st[6 * t + 2 * j + 1]! / M] as const;
    const n = (() => {
      const [a, b, c] = [p(0), p(1), p(2)];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const x = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const l = Math.hypot(...x);
      return [x[0]! / l, x[1]! / l, x[2]! / l] as const;
    })();
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
      const a = p(i), b = p(j), c = q(i), d = q(j);
      out.push({ d3: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), dst: Math.hypot(d[0] - c[0], d[1] - c[1]), slope: part.kind === 'roof' && isSlope(n) });
    }
  }
  return out;
}

describe('world-scale coordinates', () => {
  it('measure a slope along it: a metre up a 6-in-12 roof is a metre of t, a metre along its eave a metre of s', () => {
    const r = Math.sqrt(1 + 0.25);
    const n = [0, -0.5 / r, 1 / r] as const; // a slope facing south, rising north
    const a = slopeST([0, 0, 0], n);
    const up = slopeST([0, M / r, (0.5 * M) / r], n);
    const along = slopeST([M, 0, 0], n);
    expect(up[1] - a[1]).toBeCloseTo(M, 3);
    expect(up[0] - a[0]).toBeCloseTo(0, 3);
    expect(along[0] - a[0]).toBeCloseTo(M, 3);
    expect(along[1] - a[1]).toBeCloseTo(0, 3);
  });

  it('project a box\'s faces from outside, unmirrored: a top in plan, an east face along y', () => {
    expect(boxST([1, 2, 3], [0, 0, 1])).toEqual([1, 2]);
    expect(boxST([1, 2, 3], [1, 0, 0])).toEqual([2, 3]);
    expect(boxST([1, 2, 3], [0, -1, 0])).toEqual([1, 3]);
  });

  it('are an isometry of every slope of the ranch\'s hip roof and of every axis-aligned face', () => {
    let slopes = 0;
    for (const part of house.parts) {
      if (part.kind !== 'roof' && part.kind !== 'slab' && part.kind !== 'extension') continue;
      for (const e of edges(part, house.origin)) {
        if (e.slope) {
          slopes++;
          expect(e.dst).toBeCloseTo(e.d3, 4);
        }
      }
    }
    expect(slopes).toBeGreaterThan(0);
  });

  it('do not move with the mesh\'s origin', () => {
    const roof = house.parts.find((p) => p.kind === 'roof')!;
    const { positions } = flatShaded(roof.mesh);
    const a = worldCoordinates('roof', positions, house.origin, M);
    const shift: [number, number, number] = [M, 2 * M, 0];
    const moved = Float32Array.from(positions, (v, i) => v - shift[i % 3]! / M);
    const b = worldCoordinates('roof', moved, [house.origin[0] + shift[0], house.origin[1] + shift[1], house.origin[2]], M);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(64);
  });
});
