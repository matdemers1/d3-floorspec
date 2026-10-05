/**
 * A level's exterior outline: the outside faces of its walls, as Core derives them — the rings of
 * the unbounded face's boundary (6.1, 6.2) — for every group of walls that encloses a face. Not a
 * value Core defines: the editor starts a roof's footprint from it ("roof over this level"), and
 * the Z765 measure measures to it.
 */
import { area2, cross, type IPoint } from '../geometry/predicates.js';
import { toSafeNumber } from '../exact/bigint.js';
import type { LevelGeometry } from './level.js';
import { evaluate, type ValidateOptions } from '../validate/validate.js';

/** Remove each vertex where the ring runs straight on (and repeats): a roof's footprint has none (Core 16.2.3). */
export function withoutCollinear(ring: readonly IPoint[]): IPoint[] {
  let pts = [...ring];
  for (let changed = true; changed && pts.length > 3; ) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length]!;
      const p = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      if ((p[0] === a[0] && p[1] === a[1]) || cross([p[0] - a[0], p[1] - a[1]], [b[0] - p[0], b[1] - p[1]]) === 0n) {
        pts = [...pts.slice(0, i), ...pts.slice(i + 1)];
        changed = true;
        i--;
      }
    }
  }
  return pts;
}

/** The exterior rings of a level's geometry, each counter-clockwise, as they are (straight-on vertices kept). */
export function exteriorRings(g: LevelGeometry): IPoint[][] {
  const enclosing = new Set(g.faces.map((f) => f.outer.component));
  const out: IPoint[][] = [];
  for (const c of g.graph.unbounded) {
    if (!enclosing.has(c.component)) continue;
    const ring = g.ring(c);
    out.push(area2(ring) < 0n ? [...ring].reverse() : ring);
  }
  return out;
}

/**
 * The exterior outline of one level of a valid document: each ring counter-clockwise without
 * straight-on vertices, the largest first. Throws when the document is not valid.
 */
export function exteriorOutline(input: string | Uint8Array | object, level: string, options: ValidateOptions = {}): [number, number][][] {
  const ev = evaluate(input, options);
  if (!ev.valid || !ev.analysis) throw new Error('exteriorOutline: the document is not valid');
  const g = ev.analysis.levels.get(level)?.geometry;
  if (!g) return [];
  return exteriorRings(g)
    .map(withoutCollinear)
    .sort((a, b) => (area2(b) > area2(a) ? 1 : area2(b) < area2(a) ? -1 : 0))
    .map((r) => r.map((p): [number, number] => [toSafeNumber(p[0]), toSafeNumber(p[1])]));
}
