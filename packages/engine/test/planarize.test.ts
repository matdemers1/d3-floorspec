/**
 * Planarization (5.3 note) and the half-edge structure (6.1): property tests on random wall sets.
 * The output must be planar by the exact 5.3 predicates, satisfy Euler's formula, stay within a
 * pixel of its source, and not depend on input order.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HalfEdgeGraph } from '../src/geometry/halfedge.js';
import { planarize, type PlanarizeInput, type PlanarizeResult } from '../src/geometry/planarize.js';
import { collinearOverlap, inSegmentInterior, properCross, type IPoint } from '../src/geometry/predicates.js';

type Seg = [[number, number], [number, number]];

function input(segs: Seg[], order: number[] = segs.map((_, i) => i)): PlanarizeInput {
  const junctions: Record<string, [number, number]> = {};
  const edges: { id: string; start: string; end: string }[] = [];
  let nj = 0;
  const jid = (p: [number, number]): string => {
    const id = `J${String(nj++).padStart(3, '0')}`;
    junctions[id] = p;
    return id;
  };
  for (const i of order) {
    const [a, b] = segs[i]!;
    edges.push({ id: `W${String(i).padStart(3, '0')}`, start: jid(a), end: jid(b) });
  }
  let mj = 0;
  let me = 0;
  return { junctions, edges, mintJunction: () => `N${mj++}`, mintEdge: (s) => `${s}.${me++}` };
}

/** Every 5.3 condition, exactly; returns the violations found. */
function violations(r: PlanarizeResult): string[] {
  const out: string[] = [];
  const pos = new Map(Object.entries(r.junctions).map(([id, p]) => [id, [BigInt(p[0]), BigInt(p[1])] as IPoint]));
  const seen = new Map<string, string>();
  for (const [id, p] of pos) {
    const k = `${p[0]},${p[1]}`;
    if (seen.has(k)) out.push(`101 ${seen.get(k)} ${id}`);
    seen.set(k, id);
  }
  const pairs = new Set<string>();
  for (const e of r.edges) {
    if (e.start === e.end) out.push(`102 ${e.id}`);
    const k = [e.start, e.end].sort().join('|');
    if (pairs.has(k)) out.push(`103 ${e.id}`);
    pairs.add(k);
  }
  for (let i = 0; i < r.edges.length; i++) {
    const e = r.edges[i]!;
    const a = pos.get(e.start)!;
    const b = pos.get(e.end)!;
    for (const [jid, p] of pos) if (jid !== e.start && jid !== e.end && inSegmentInterior(p, a, b)) out.push(`105 ${jid} ${e.id}`);
    for (let k = i + 1; k < r.edges.length; k++) {
      const f = r.edges[k]!;
      const c = pos.get(f.start)!;
      const d = pos.get(f.end)!;
      if (properCross(a, b, c, d)) out.push(`104 ${e.id} ${f.id}`);
      if (collinearOverlap(a, b, c, d)) out.push(`106 ${e.id} ${f.id}`);
    }
  }
  return out;
}

/** Squared distance from a point to a segment, as a float — a test-only tolerance check. */
function dist2(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return x * x + y * y;
}

const coord = (range: number) => fc.integer({ min: -range, max: range });
const segment = (range: number) => fc.tuple(fc.tuple(coord(range), coord(range)), fc.tuple(coord(range), coord(range))) as fc.Arbitrary<Seg>;

describe('planarize (5.3)', () => {
  it('splits a crossing at its exact intersection', () => {
    const r = planarize(input([[[0, 0], [10, 0]], [[5, -5], [5, 5]]]));
    expect(violations(r)).toEqual([]);
    expect(r.junctions.N0).toEqual([5, 0]);
    expect(r.edges.map((e) => `${e.id}:${e.start}-${e.end}`)).toEqual(['W000:J000-N0', 'W000.0:N0-J001', 'W001:J002-N0', 'W001.1:N0-J003']);
  });

  it('snaps an intersection off the grid to the nearest point, ties to even', () => {
    // y = x/2 crosses x = 1 at (1, 0.5): rounds to (1, 0).
    const r = planarize(input([[[0, 0], [4, 2]], [[1, -3], [1, 3]]]));
    expect(violations(r)).toEqual([]);
    expect(Object.values(r.junctions)).toContainEqual([1, 0]);
  });

  it('splits a T-touch and merges a collinear overlap', () => {
    const r = planarize(input([[[0, 0], [10, 0]], [[5, 0], [5, 5]], [[2, 0], [20, 0]]]));
    expect(violations(r)).toEqual([]);
  });

  it('random wall sets on a small grid stay planar (property)', () => {
    fc.assert(
      fc.property(fc.array(segment(12), { minLength: 1, maxLength: 14 }), (segs) => {
        const r = planarize(input(segs));
        expect(violations(r)).toEqual([]);
        // Every fragment's ends lie within a pixel of its source segment.
        const src = new Map(segs.map((s, i) => [`W${String(i).padStart(3, '0')}`, s]));
        for (const e of r.edges) {
          const [a, b] = src.get(e.source)!;
          expect(dist2(r.junctions[e.start]!, a, b)).toBeLessThanOrEqual(1);
          expect(dist2(r.junctions[e.end]!, a, b)).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 400, seed: 20261004 },
    );
  });

  it('random wall sets at building scale stay planar (property)', () => {
    fc.assert(
      fc.property(fc.array(segment(5_000_000), { minLength: 1, maxLength: 12 }), (segs) => {
        expect(violations(planarize(input(segs)))).toEqual([]);
      }),
      { numRuns: 200, seed: 42 },
    );
  });

  it('does not depend on input order (property)', () => {
    fc.assert(
      fc.property(
        fc.array(segment(8), { minLength: 2, maxLength: 8 }).chain((segs) => fc.tuple(fc.constant(segs), fc.shuffledSubarray(segs.map((_, i) => i), { minLength: segs.length }))),
        ([segs, order]) => {
          const norm = (r: PlanarizeResult) =>
            r.edges
              .map((e) => [r.junctions[e.start]!, r.junctions[e.end]!].map((p) => p.join(',')).sort().join(' '))
              .sort();
          expect(norm(planarize(input(segs, order)))).toEqual(norm(planarize(input(segs))));
        },
      ),
      { numRuns: 200, seed: 9 },
    );
  });

  it('the half-edge structure of a planar result satisfies Euler’s formula (property)', () => {
    fc.assert(
      fc.property(fc.array(segment(10), { minLength: 1, maxLength: 12 }), (segs) => {
        const r = planarize(input(segs));
        const used = new Set(r.edges.flatMap((e) => [e.start, e.end]));
        const positions = new Map([...used].map((id) => [id, [BigInt(r.junctions[id]![0]), BigInt(r.junctions[id]![1])] as IPoint]));
        const g = new HalfEdgeGraph(positions, r.edges);
        const components = new Set(g.cycles.map((c) => c.component)).size;
        // V − E + F = 1 + C, counting the unbounded face once
        expect(positions.size - r.edges.length + g.faces.length + 1).toBe(1 + components);
        // each component has exactly one cycle of non-positive area: its outside
        expect(g.cycles.filter((c) => c.area2 <= 0n).length).toBe(components);
      }),
      { numRuns: 300, seed: 5 },
    );
  });
});
