/**
 * World-scale texture coordinates for the surfaces Core 18.3 does not define (FLR-T-13.6): a roof,
 * a slab, a gable end, a stair, the pieces of a fixture's or a counter's model. Each point's
 * coordinates `(s, t)` are in base units, so a texture laid with `tileCoordinates` repeats at its
 * real-world size there as it does on a wall or a floor, and they are the plan's own (or a slope's
 * own), so they never swim as the view moves or the house is meshed about another origin.
 *
 * - **A roof's slope** is measured along it: `s` along the eave, level, `t` up the slope from the
 *   line through the origin — true distances on the slope, not the plan's, so a standing seam's
 *   panels are their width on any pitch and its seams run straight down the slope, and slates and
 *   shingles course along the eave.
 * - **Everything else** is a box projection on the face's dominant axis, seen from outside: a top
 *   is the plan `(x, y)`, an underside `(−x, y)`, a face looking east `(y, z)`, west `(−y, z)`,
 *   north `(−x, z)`, south `(x, z)` — so a counter's top is laid in plan and its edge along its
 *   front, and a slab's top runs on from the floor beside it. This is the projection the glTF
 *   export has always given these surfaces.
 *
 * These are for drawing, not normative output (Core 0.5): doubles, from positions that arrive as
 * Float32 metres. Square roots only — no trigonometry — so every engine gives the same values.
 */
import { UNITS_PER_METRE, type MeshPart, type Vec3 } from './types.js';

/** How steep a face must be to be a roof's slope rather than its flat top or its fascia. */
const SLOPED_MIN = 0.05;
const SLOPED_MAX = 0.9995;

/** A box projection's `(s, t)` of a point (base units) on a face with unit normal `n` (z up). */
export function boxST(p: readonly [number, number, number], n: readonly [number, number, number]): [number, number] {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  if (az >= ax && az >= ay) return n[2] >= 0 ? [p[0], p[1]] : [-p[0], p[1]];
  if (ax >= ay) return n[0] >= 0 ? [p[1], p[2]] : [-p[1], p[2]];
  return n[1] >= 0 ? [-p[0], p[2]] : [p[0], p[2]];
}

/**
 * A slope's `(s, t)` of a point (base units) on a face with unit normal `n` (z up, sloped): `s`
 * along the level line of the slope, running to the right of a person looking at it from outside,
 * `t` up the slope. With `h` the normal's level part made unit, the slope's axes are
 * `a = (−h_y, h_x, 0)` and `u = (−h_x n_z, −h_y n_z, |n_xy|)`, and `a × u = n`.
 */
export function slopeST(p: readonly [number, number, number], n: readonly [number, number, number]): [number, number] {
  const m = Math.sqrt(n[0] * n[0] + n[1] * n[1]);
  const hx = n[0] / m;
  const hy = n[1] / m;
  return [-hy * p[0] + hx * p[1], -hx * n[2] * p[0] - hy * n[2] * p[1] + m * p[2]];
}

/** Whether a roof's face is a slope (laid along it) rather than a flat top, an underside or a fascia. */
export const isSlope = (n: readonly [number, number, number]): boolean => n[2] > SLOPED_MIN && n[2] < SLOPED_MAX;

/**
 * The world-scale coordinates of each vertex of unindexed triangles (nine floats a triangle, metres
 * relative to `origin` in base units, as a part's flat-shaded mesh is): two a vertex, base units.
 * A roof's slopes are laid along them; every other face by the box projection.
 */
export function worldCoordinates(kind: MeshPart['kind'], positions: Float32Array, origin: Vec3 = [0, 0, 0], unitsPerMetre: number = UNITS_PER_METRE): Float64Array {
  const k = unitsPerMetre;
  const out = new Float64Array((positions.length / 3) * 2);
  const roof = kind === 'roof';
  for (let t = 0; t < positions.length / 9; t++) {
    const o = 9 * t;
    const ux = positions[o + 3]! - positions[o]!;
    const uy = positions[o + 4]! - positions[o + 1]!;
    const uz = positions[o + 5]! - positions[o + 2]!;
    const vx = positions[o + 6]! - positions[o]!;
    const vy = positions[o + 7]! - positions[o + 1]!;
    const vz = positions[o + 8]! - positions[o + 2]!;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const n: [number, number, number] = [nx, ny, nz];
    const slope = roof && isSlope(n);
    for (let j = 0; j < 3; j++) {
      const p: [number, number, number] = [positions[o + 3 * j]! * k + origin[0], positions[o + 3 * j + 1]! * k + origin[1], positions[o + 3 * j + 2]! * k + origin[2]];
      const st = slope ? slopeST(p, n) : boxST(p, n);
      out[6 * t + 2 * j] = st[0];
      out[6 * t + 2 * j + 1] = st[1];
    }
  }
  return out;
}
