/**
 * Planarization by snap rounding (the informative note of 5.3): insert a junction wherever two edges
 * cross or an edge passes through a junction, and split the edges there, so that a level satisfies
 * the planarity invariants (5.3.1–5.3.3) exactly.
 *
 * An intersection rarely falls on a whole base unit, so it is rounded to the grid (round half to
 * even, as everywhere in Floorspec) and becomes a **hot pixel**: the set of points that round to it,
 * {p : round(p.x) = c.x and round(p.y) = c.y}. With ties to even, a pixel is the closed unit square
 * around an even coordinate and the open one around an odd coordinate, so the pixels partition the
 * plane and no segment can graze a corner shared by two of them. Every segment is routed through the
 * centre of every hot pixel it passes through, in the order it meets them. The result moves no
 * edge by more than a pixel, and is computed with exact rational arithmetic, so every
 * implementation produces the same result.
 *
 * After routing, a junction can still lie in the interior of a fragment it did not originally touch,
 * and two fragments can coincide; both are resolved exactly (split, then deduplicate), and the whole
 * procedure repeats in the rare case a proper crossing survives. The result is checked against the
 * 5.3 predicates before it is returned.
 */
import { roundHalfEvenRational } from '../exact/bigint.js';
import { collinearOverlap, eq, inSegmentInterior, properCross, sub, cross, type IPoint } from './predicates.js';

export interface PlanarizeEdge {
  readonly id: string;
  readonly start: string;
  readonly end: string;
}

export interface PlanarizeInput {
  /** Junction ID → position, in base units. */
  readonly junctions: Readonly<Record<string, readonly [number, number]>>;
  readonly edges: readonly PlanarizeEdge[];
  /** Mint the ID of a new junction at a position. Called in a deterministic order. */
  readonly mintJunction: (position: [number, number]) => string;
  /** Mint the ID of a new edge split from `source`. Called in a deterministic order. */
  readonly mintEdge: (source: string) => string;
}

export interface PlanarizeResult {
  /** Every junction of the result: the surviving input junctions and the new ones. */
  junctions: Record<string, [number, number]>;
  /** The planar edges. `source` is the input edge each one came from; the first piece of an edge keeps its ID. */
  edges: { id: string; start: string; end: string; source: string }[];
  /** Input junctions merged into another at the same position: ID → the survivor's ID. */
  mergedJunctions: Record<string, string>;
  /** Input edges with no piece left: zero length, or entirely covered by an edge whose ID sorts first. */
  removedEdges: string[];
}

// ── exact rationals for segment parameters ──────────────────────────────────────

interface Bound {
  n: bigint;
  d: bigint; // > 0
  open: boolean;
}

const cmpQ = (a: Bound, b: Bound): number => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};

/**
 * The parameter interval [lo, hi] of t ∈ [0, 1] for which A + t·(B − A) lies in the pixel of c, or
 * undefined if it never does. Coordinates are doubled so the pixel's edges are integers.
 */
function pixelInterval(A: IPoint, B: IPoint, c: IPoint): { lo: Bound; hi: Bound } | undefined {
  let lo: Bound = { n: 0n, d: 1n, open: false };
  let hi: Bound = { n: 1n, d: 1n, open: false };
  for (const axis of [0, 1] as const) {
    const a = 2n * A[axis];
    const delta = 2n * (B[axis] - A[axis]);
    const open = c[axis] % 2n !== 0n; // odd centre: open interval
    const pLo = 2n * c[axis] - 1n;
    const pHi = 2n * c[axis] + 1n;
    if (delta === 0n) {
      const inside = open ? a > pLo && a < pHi : a >= pLo && a <= pHi;
      if (!inside) return undefined;
      continue;
    }
    // t at which the coordinate reaches pLo and pHi
    let t1: Bound = { n: pLo - a, d: delta, open };
    let t2: Bound = { n: pHi - a, d: delta, open };
    if (delta < 0n) {
      t1 = { n: -t1.n, d: -t1.d, open };
      t2 = { n: -t2.n, d: -t2.d, open };
      [t1, t2] = [t2, t1];
    }
    const c1 = cmpQ(t1, lo);
    if (c1 > 0 || (c1 === 0 && t1.open)) lo = t1;
    const c2 = cmpQ(t2, hi);
    if (c2 < 0 || (c2 === 0 && t2.open)) hi = t2;
  }
  const order = cmpQ(lo, hi);
  if (order > 0 || (order === 0 && (lo.open || hi.open))) return undefined;
  return { lo, hi };
}

/** The rounded intersection point of two properly crossing segments. */
function roundedCrossing(a: IPoint, b: IPoint, c: IPoint, d: IPoint): IPoint {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  const t = cross(sub(c, a), s); // intersection at a + r · t / den
  return [roundHalfEvenRational(a[0] * den + r[0] * t, den), roundHalfEvenRational(a[1] * den + r[1] * t, den)];
}

const key = (p: IPoint): string => `${p[0]},${p[1]}`;

interface Seg {
  a: IPoint;
  b: IPoint;
  source: string;
}

/** One round of snap rounding: route every segment through every hot pixel it passes through. */
function snapRound(segs: Seg[], vertices: IPoint[]): Seg[] {
  const hot = new Map<string, IPoint>();
  for (const v of vertices) hot.set(key(v), v);
  for (const s of segs) {
    hot.set(key(s.a), s.a);
    hot.set(key(s.b), s.b);
  }
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]!;
      const t = segs[j]!;
      if (properCross(s.a, s.b, t.a, t.b)) {
        const p = roundedCrossing(s.a, s.b, t.a, t.b);
        hot.set(key(p), p);
      }
    }
  const pixels = [...hot.values()];
  const out: Seg[] = [];
  for (const s of segs) {
    const minX = s.a[0] < s.b[0] ? s.a[0] : s.b[0];
    const maxX = s.a[0] < s.b[0] ? s.b[0] : s.a[0];
    const minY = s.a[1] < s.b[1] ? s.a[1] : s.b[1];
    const maxY = s.a[1] < s.b[1] ? s.b[1] : s.a[1];
    const hits: { c: IPoint; lo: Bound; hi: Bound }[] = [];
    for (const c of pixels) {
      if (c[0] < minX - 1n || c[0] > maxX + 1n || c[1] < minY - 1n || c[1] > maxY + 1n) continue;
      const iv = pixelInterval(s.a, s.b, c);
      if (iv) hits.push({ c, ...iv });
    }
    hits.sort((x, y) => cmpQ(x.lo, y.lo) || cmpQ(x.hi, y.hi));
    for (let k = 0; k + 1 < hits.length; k++) out.push({ a: hits[k]!.c, b: hits[k + 1]!.c, source: s.source });
  }
  return out;
}

/** Split fragments at every vertex lying in their interior, until none does. */
function splitAtVertices(segs: Seg[]): Seg[] {
  const verts = new Map<string, IPoint>();
  for (const s of segs) {
    verts.set(key(s.a), s.a);
    verts.set(key(s.b), s.b);
  }
  const vs = [...verts.values()];
  const out: Seg[] = [];
  for (const s of segs) {
    const d = sub(s.b, s.a);
    const inner = vs
      .filter((v) => inSegmentInterior(v, s.a, s.b))
      .map((v) => ({ v, t: d[0] * (v[0] - s.a[0]) + d[1] * (v[1] - s.a[1]) }))
      .sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
    let prev = s.a;
    for (const { v } of inner) {
      out.push({ a: prev, b: v, source: s.source });
      prev = v;
    }
    out.push({ a: prev, b: s.b, source: s.source });
  }
  return out;
}

function planar(segs: Seg[]): boolean {
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]!;
      const t = segs[j]!;
      if (properCross(s.a, s.b, t.a, t.b) || collinearOverlap(s.a, s.b, t.a, t.b)) return false;
      if (inSegmentInterior(t.a, s.a, s.b) || inSegmentInterior(t.b, s.a, s.b)) return false;
      if (inSegmentInterior(s.a, t.a, t.b) || inSegmentInterior(s.b, t.a, t.b)) return false;
    }
  return true;
}

/** Remove zero-length fragments and duplicates; the fragment of the source that sorts first is kept. */
function dedupe(segs: Seg[]): Seg[] {
  const seen = new Set<string>();
  const out: Seg[] = [];
  const sorted = [...segs].sort((x, y) => (x.source < y.source ? -1 : x.source > y.source ? 1 : 0));
  for (const s of sorted) {
    if (eq(s.a, s.b)) continue;
    const k1 = `${key(s.a)}|${key(s.b)}`;
    const k2 = `${key(s.b)}|${key(s.a)}`;
    if (seen.has(k1) || seen.has(k2)) continue;
    seen.add(k1);
    out.push(s);
  }
  return out;
}

export function planarize(input: PlanarizeInput): PlanarizeResult {
  // Junctions: one per position; the ID that sorts first survives.
  const ids = Object.keys(input.junctions).sort();
  const atPos = new Map<string, string>();
  const mergedJunctions: Record<string, string> = {};
  const junctions: Record<string, [number, number]> = {};
  for (const id of ids) {
    const p = input.junctions[id]!;
    const k = `${p[0]},${p[1]}`;
    const survivor = atPos.get(k);
    if (survivor !== undefined) mergedJunctions[id] = survivor;
    else {
      atPos.set(k, id);
      Object.defineProperty(junctions, id, { value: [p[0], p[1]], enumerable: true, writable: true, configurable: true });
    }
  }
  const posOf = (id: string): IPoint => {
    const p = input.junctions[id];
    if (!p) throw new Error(`planarize: unknown junction ${id}`);
    return [BigInt(p[0]), BigInt(p[1])];
  };

  const edges = [...input.edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let segs: Seg[] = edges.map((e) => ({ a: posOf(e.start), b: posOf(e.end), source: e.id })).filter((s) => !eq(s.a, s.b));
  const vertices = ids.map(posOf);

  for (let round = 0; ; round++) {
    segs = dedupe(splitAtVertices(dedupe(snapRound(segs, vertices))));
    if (planar(segs)) break;
    if (round >= 16) throw new Error('planarize: did not converge');
  }

  // New junctions, minted in position order.
  const newPositions = new Map<string, IPoint>();
  for (const s of segs)
    for (const p of [s.a, s.b]) {
      const k = key(p);
      if (!atPos.has(k)) newPositions.set(k, p);
    }
  for (const p of [...newPositions.values()].sort((x, y) => (x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))) {
    const pos: [number, number] = [Number(p[0]), Number(p[1])];
    const id = input.mintJunction(pos);
    atPos.set(key(p), id);
    Object.defineProperty(junctions, id, { value: pos, enumerable: true, writable: true, configurable: true });
  }

  // Edges: pieces in source order, then along each source from its start; the first keeps the ID.
  const order = new Map(edges.map((e, i) => [e.id, i]));
  const startOf = new Map(edges.map((e) => [e.id, posOf(e.start)]));
  const endOf = new Map(edges.map((e) => [e.id, posOf(e.end)]));
  const along = (s: Seg): bigint => {
    const A = startOf.get(s.source)!;
    const d = sub(endOf.get(s.source)!, A);
    const m = (p: IPoint): bigint => d[0] * (p[0] - A[0]) + d[1] * (p[1] - A[1]);
    const ta = m(s.a);
    const tb = m(s.b);
    return ta < tb ? ta : tb;
  };
  segs.sort((x, y) => order.get(x.source)! - order.get(y.source)! || (along(x) < along(y) ? -1 : along(x) > along(y) ? 1 : 0));
  const used = new Set<string>();
  const out: PlanarizeResult['edges'] = [];
  for (const s of segs) {
    // Orient each piece the way its source runs.
    const A = startOf.get(s.source)!;
    const d = sub(endOf.get(s.source)!, A);
    const forward = d[0] * (s.b[0] - s.a[0]) + d[1] * (s.b[1] - s.a[1]) >= 0n;
    const [a, b] = forward ? [s.a, s.b] : [s.b, s.a];
    const id = used.has(s.source) ? input.mintEdge(s.source) : s.source;
    used.add(s.source);
    out.push({ id, start: atPos.get(key(a))!, end: atPos.get(key(b))!, source: s.source });
  }
  const removedEdges = edges.map((e) => e.id).filter((id) => !used.has(id));
  return { junctions, edges: out, mergedJunctions, removedEdges };
}
