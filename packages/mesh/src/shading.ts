/**
 * Flat shading for a view: an indexed part mesh shares each vertex between the faces that meet at
 * it (that is what makes it watertight), so averaged vertex normals would round every corner of a
 * wall. A view that wants crisp faces draws this unindexed copy, one normal per triangle.
 */
import type { PartMesh } from './types.js';

export function flatShaded(mesh: PartMesh): { positions: Float32Array; normals: Float32Array } {
  const { positions: P, indices } = mesh;
  const positions = new Float32Array(indices.length * 3);
  const normals = new Float32Array(indices.length * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    const ux = P[3 * b]! - P[3 * a]!;
    const uy = P[3 * b + 1]! - P[3 * a + 1]!;
    const uz = P[3 * b + 2]! - P[3 * a + 2]!;
    const vx = P[3 * c]! - P[3 * a]!;
    const vy = P[3 * c + 1]! - P[3 * a + 1]!;
    const vz = P[3 * c + 2]! - P[3 * a + 2]!;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const [k, i] of [a, b, c].entries()) {
      const o = 3 * (t + k);
      positions[o] = P[3 * i]!;
      positions[o + 1] = P[3 * i + 1]!;
      positions[o + 2] = P[3 * i + 2]!;
      normals[o] = nx;
      normals[o + 1] = ny;
      normals[o + 2] = nz;
    }
  }
  return { positions, normals };
}
