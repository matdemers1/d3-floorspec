/**
 * Roofs (Core 0.3, chapter 16), from their derived faces, gable ends and eave outline (16.5) —
 * "what a mesh of the roof is made from". Every point is one the engine derived, rounded once, so
 * faces that meet share their points exactly.
 *
 * - With a `thickness`, the roof is its surface thickened straight down by it: the faces on top,
 *   the same faces `thickness` lower underneath, and a vertical band round the surface's edge. Its
 *   box is the derived box, from eave − thickness to the surface's high. Its gable ends are not part
 *   of that solid and are emitted as `roofGable` surfaces. A Core 0.4 gable end stands on its wall,
 *   the gable's edge of the footprint, and the solid rakes past it by the gable's overhang, its
 *   underside showing over the rake (FLR-T-12.36); each gable end is drawn only where it is below
 *   the solid — up to the roof's underside over the wall — so that none of it lies inside the
 *   solid, and so that where nothing overhangs, the band standing in the gable end's own plane, no
 *   two coplanar faces fight for depth (FLR-T-12.35). A gable end is clad as the wall it stands
 *   on (FLR-T-12.38, cladding.ts), so it carries no roof material.
 * - Without one, the roof is the volume between its eave and its surface over the whole eave
 *   outline — the attic and its overhangs, boxed — closed by a soffit at the eave and, along each
 *   gable's edge of the outline, the surface's edge dropped to the eave. Its box is the derived box.
 *   Its gable ends, on the walls, lie inside it.
 * - A flat roof is a slab of its thickness under the eave outline, or a surface facing up without one.
 * - A roof whose surface this draft does not derive (16.4.4) is a placeholder surface: its eave
 *   outline at the eave.
 *
 * Where a face's boundary runs straight through a point another face turns at, the point is put on
 * both, so no edge of the shell has a T-junction.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { gableCladding } from './cladding.js';
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

/** round(n / d) for d > 0, halves away from −∞. */
function rdiv(n: bigint, d: bigint): bigint {
  const q = 2n * n + d;
  const m = 2n * d;
  return q >= 0n ? q / m : -((-q + m - 1n) / m);
}

/**
 * The part of a gable end below a thick roof's solid (FLR-T-12.35). A gable end (16.5) is A and B at
 * the eave and then the surface back from B to A, so it is everything between the eave and the
 * surface along its edge; the solid's band on that edge is everything between the surface and
 * `t` below it, in the same plane. What is left is the gable end with its top lowered by `t` and
 * cut at the eave: none where the surface is less than `t` above the eave, and one piece for each
 * run of the edge where it is more. Each piece is A-side and B-side at the eave and then its top
 * back from B to A, as a gable end is; a point where the lowered top crosses the eave is rounded
 * once, and every other point is the derived one moved down by `t`, an integer.
 */
export function belowSolid(gable: readonly P3[], eave: number, t: number): P3[][] {
  const [A, B] = [gable[0]!, gable[1]!];
  const top = gable.slice(2);
  const at = (p: P3, q: P3): boolean => p[0] === q[0] && p[1] === q[1];
  // The surface's ends on the edge were dropped from the polygon where they are at the eave.
  if (!top.length || !at(top[0]!, B)) top.unshift(B);
  if (!at(top[top.length - 1]!, A)) top.push(A);
  const low = top.map((p): P3 => [p[0], p[1], p[2] - t]);
  const e = eave;
  /** Where the lowered top crosses the eave between p, above it, and q, at or below it. */
  const cross = (p: P3, q: P3): P3 => {
    const n = BigInt(p[2] - e);
    const d = BigInt(p[2] - q[2]);
    const along = (k: 0 | 1): number => Number(BigInt(p[k]) + rdiv((BigInt(q[k]) - BigInt(p[k])) * n, d));
    return [along(0), along(1), e];
  };
  const pieces: P3[][] = [];
  let run: P3[] | null = null;
  for (let i = 0; i < low.length; i++) {
    const p = low[i]!;
    if (p[2] > e) {
      if (!run) run = [i === 0 ? [p[0], p[1], e] : cross(p, low[i - 1]!)];
      run.push(p);
      const q = low[i + 1];
      if (q === undefined) run.push([p[0], p[1], e]);
      else if (q[2] <= e) run.push(cross(p, q));
      else continue;
      const piece = dedupe([run[run.length - 1]!, run[0]!, ...run.slice(1, -1)]);
      if (piece.length >= 3) pieces.push(piece);
      run = null;
    }
  }
  return pieces;
}

/** A gable end turned to face out of the roof: to the right of its eave edge A → B on the counter-clockwise outline. */
function outward(poly: readonly P3[]): P3[] {
  const [A, B] = [poly[0]!, poly[1]!];
  const N = newell(poly);
  return N[0] * (B[1] - A[1]) - N[1] * (B[0] - A[0]) >= 0 ? [...poly] : [...poly].reverse();
}

const k2 = (p: readonly number[]): string => `${p[0]},${p[1]}`;

/**
 * A thin roof's ends along its gables (FLR-T-12.36): for each edge A → B of the counter-clockwise
 * eave outline over which the surface's rim rises above the eave, the rim from A to B dropped to the
 * eave — A and B at the eave, then the rim back from B to A — the vertical polygon that closes the
 * volume between the eave and the surface there. The rim is the faces' boundary, walked from their
 * edges that no face runs the other way, so it has every point the faces have on the outline.
 */
function rakeEnds(faces: readonly (readonly P3[])[], outline: readonly P2[], eave: number): P3[][] {
  const edges = new Map<string, [P3, P3]>();
  for (const f of faces) for (let i = 0; i < f.length; i++) edges.set(`${key(f[i]!)}>${key(f[(i + 1) % f.length]!)}`, [f[i]!, f[(i + 1) % f.length]!]);
  const next = new Map<string, P3>();
  const at = new Map<string, P3>();
  for (const [a, b] of edges.values()) {
    if (edges.has(`${key(b)}>${key(a)}`)) continue;
    next.set(key(a), b);
    at.set(k2(a), a);
  }
  const out: P3[][] = [];
  for (let i = 0; i < outline.length; i++) {
    const A = outline[i]!;
    const B = outline[(i + 1) % outline.length]!;
    let p = at.get(k2(A));
    if (!p) continue;
    const rim: P3[] = [p];
    while (k2(p) !== k2(B) && rim.length <= next.size) {
      const q = next.get(key(p));
      if (!q) break;
      rim.push((p = q));
    }
    if (k2(p) !== k2(B) || rim.every((q) => q[2] === eave)) continue;
    out.push(dedupe([[A[0], A[1], eave], [B[0], B[1], eave], ...rim.reverse()]));
  }
  return out;
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
        for (const g of surface.gables) {
          const gb = new MeshBuilder(kernel);
          let made = false;
          for (const piece of belowSolid(dedupe(g.polygon as P3[]), r.eave, t)) made = gb.face([outward(piece)]) || made;
          if (!made) continue;
          // Clad as the wall it stands on (FLR-T-12.38), not in the roof's material.
          const cladding = gableCladding(doc, derived, id, g.edge);
          out.push({ id, level: roof.level, kind: 'roofGable', piece: `gable${g.edge}`, closed: false, facing: 'side', ...(cladding && { cladding }), exact: gb });
        }
      continue;
    }
    const ends = rakeEnds(split(faces), outline, r.eave).map(outward);
    const soffit = [...outline].reverse().map((p): P3 => [p[0], p[1], r.eave]);
    for (const f of split([...faces, ...ends, soffit])) b.face([f]);
    out.push({ ...common, kind: 'roof', closed: true, exact: b });
  }
  return out;
}
