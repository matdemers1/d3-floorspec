/**
 * Roofs (Core 0.3, chapter 16), from their derived faces, gable ends and eave outline (16.5) —
 * "what a mesh of the roof is made from". Every point is one the engine derived, rounded once, so
 * faces that meet share their points exactly.
 *
 * - With a `thickness`, the roof is its surface thickened straight down by it: the faces on top,
 *   the same faces `thickness` lower underneath, and a vertical band round the surface's edge. Its
 *   box is the derived box, from eave − thickness to the surface's high. Its gable ends are not part
 *   of that solid and are emitted as `roofGable` surfaces.
 * - Without one, the roof is the closed shell its faces, its gable ends and a soffit at the eave
 *   bound: the attic volume. Its box is the derived box.
 * - A flat roof is a slab of its thickness under the eave outline, or a surface facing up without one.
 * - A roof whose surface this draft does not derive (16.4.4) is a placeholder surface: its eave
 *   outline at the eave.
 *
 * Where a face's boundary runs straight through a point another face turns at, the point is put on
 * both, so no edge of the shell has a T-junction.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { get } from './own.js';
import { dedupe, MeshBuilder, newell, type P2, type P3 } from './builder.js';
import type { Kernel } from './kernel.js';
import type { RawPart } from './part.js';

const key = (p: P3): string => `${p[0]},${p[1]},${p[2]}`;

/** Is p strictly inside the segment a–b? Exact, in BigInt. */
function between(a: P3, b: P3, p: P3): boolean {
  const A = a.map(BigInt);
  const d = [BigInt(b[0]) - A[0]!, BigInt(b[1]) - A[1]!, BigInt(b[2]) - A[2]!];
  const v = [BigInt(p[0]) - A[0]!, BigInt(p[1]) - A[1]!, BigInt(p[2]) - A[2]!];
  if (d[1]! * v[2]! - d[2]! * v[1]! !== 0n || d[2]! * v[0]! - d[0]! * v[2]! !== 0n || d[0]! * v[1]! - d[1]! * v[0]! !== 0n) return false;
  const t = d[0]! * v[0]! + d[1]! * v[1]! + d[2]! * v[2]!;
  return t > 0n && t < d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!;
}

/** Every ring with each point of any ring that lies inside one of its edges inserted there, in order. */
function split(rings: readonly (readonly P3[])[]): P3[][] {
  const seen = new Map<string, P3>();
  for (const r of rings) for (const p of r) seen.set(key(p), p);
  const all = [...seen.values()];
  return rings.map((r) => {
    const out: P3[] = [];
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      out.push(a);
      const on = all.filter((p) => between(a, b, p));
      const len = (p: P3): number => (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2 + (p[2] - a[2]) ** 2;
      out.push(...on.sort((p, q) => len(p) - len(q)));
    }
    return out;
  });
}

/** A gable end turned to face out of the roof: to the right of its eave edge A → B on the counter-clockwise outline. */
function outward(poly: readonly P3[]): P3[] {
  const [A, B] = [poly[0]!, poly[1]!];
  const N = newell(poly);
  return N[0] * (B[1] - A[1]) - N[1] * (B[0] - A[0]) >= 0 ? [...poly] : [...poly].reverse();
}

/** The directed edges of a builder's triangles that no triangle runs the other way. */
function boundary(tris: readonly number[]): [number, number][] {
  const edges = new Set<string>();
  for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) edges.add(`${tris[t + k]}>${tris[t + ((k + 1) % 3)]}`);
  const out: [number, number][] = [];
  for (let t = 0; t < tris.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = tris[t + k]!;
      const b = tris[t + ((k + 1) % 3)]!;
      if (!edges.has(`${b}>${a}`)) out.push([a, b]);
    }
  return out;
}

export function roofParts(kernel: Kernel, doc: FloorspecDocument, derived: Derived, want: (kind: RawPart['kind']) => boolean): RawPart[] {
  const out: RawPart[] = [];
  for (const id of Object.keys(derived.roofs ?? {}).sort()) {
    const r = derived.roofs![id]!;
    const roof = get(doc.roofs, id)!;
    const t = roof.thickness ?? 0;
    const common = { id, level: roof.level, ...(roof.material !== undefined && { material: roof.material }) };
    const outline = r.outline as P2[];
    const surface = r.surface;
    if (!want('roof') && !(want('roofGable') && surface && t > 0)) continue;
    const b = new MeshBuilder(kernel);
    if (!surface || r.kind === 'flat') {
      if (!want('roof')) continue;
      if (surface && t > 0) {
        b.prism([outline], r.eave - t, r.eave);
        out.push({ ...common, kind: 'roof', closed: true, exact: b });
      } else {
        b.sheet([outline], r.eave, 'up');
        out.push({ ...common, kind: 'roof', closed: false, facing: 'up', ...(!surface && { placeholder: true as const }), exact: b });
      }
      continue;
    }
    const faces = surface.faces.map((f) => dedupe(f.polygon as P3[]));
    const gables = surface.gables.map((g) => outward(dedupe(g.polygon as P3[])));
    if (t > 0) {
      if (want('roof')) {
        for (const f of split(faces)) b.face([f]);
        const top = [...b.tris];
        const low = (i: number): number => {
          const p = b.point(i);
          return b.vertex([p[0], p[1], p[2] - t]);
        };
        for (let k = 0; k < top.length; k += 3) b.tri(low(top[k + 2]!), low(top[k + 1]!), low(top[k]!));
        for (const [a, c] of boundary(top)) {
          const [la, lc] = [low(a), low(c)];
          b.tri(la, lc, c);
          b.tri(la, c, a);
        }
        out.push({ ...common, kind: 'roof', closed: true, exact: b });
      }
      if (want('roofGable'))
        surface.gables.forEach((g, i) => {
          const gb = new MeshBuilder(kernel);
          if (gb.face([gables[i]!])) out.push({ ...common, kind: 'roofGable', piece: `gable${g.edge}`, closed: false, facing: 'side', exact: gb });
        });
      continue;
    }
    const soffit = [...outline].reverse().map((p): P3 => [p[0], p[1], r.eave]);
    for (const f of split([...faces, ...gables, soffit])) b.face([f]);
    out.push({ ...common, kind: 'roof', closed: true, exact: b });
  }
  return out;
}
