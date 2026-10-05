/**
 * 16.5 for a skeleton roof as Core 0.4 derives it (16.4.3 to 16.4.6), from the weighted straight
 * skeleton's exact faces: nodes, face polygons, gable ends and lines — ridges, breaks, hips and
 * valleys — every coordinate rounded once at the end. A port of the oracle's `_weighted_surface`
 * and `_weighted_lines` (tools/oracle/roofs.py).
 */
import { exactSqrt } from '../../exact/bigint.js';
import { Q } from '../../exact/rational.js';
import type { IPoint } from '../../geometry/predicates.js';
import { Unsupported, dirOf, onClosed, planeKey, qcmp, qcross, qdot, qkey, qsub, weightedSkeleton, type Kind, type Pitch, type QP } from './skeleton.js';

export type B3 = readonly [bigint, bigint, bigint];

/** The counter-clockwise eave outline, each edge with its kind and its index in the footprint. */
export interface CcwOutline {
  readonly ring: readonly IPoint[];
  readonly index: readonly number[];
  readonly kind: readonly Kind[];
}

export interface WeightedSurface {
  high: bigint;
  faces: { edge: number; poly: B3[] }[];
  gables: { edge: number; poly: B3[] }[];
  lines: { kind: 'ridge' | 'break' | 'hip' | 'valley'; from: B3; to: B3 }[];
}

const CACHE = new Map<string, Map<number, QP[][]> | string>();

function lookup(o: CcwOutline, pitches: readonly (Pitch | undefined)[]): Map<number, QP[][]> | string {
  const key = JSON.stringify([o.ring.map((p) => [`${p[0]}`, `${p[1]}`]), o.kind, pitches.map((p) => (p ? [`${p[0]}`, `${p[1]}`] : null))]);
  let v = CACHE.get(key);
  if (v === undefined) {
    if (CACHE.size > 256) CACHE.clear();
    try {
      v = weightedSkeleton(o.ring, o.kind, pitches);
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      v = e.message;
    }
    CACHE.set(key, v);
  }
  return v;
}

/** The weighted skeleton's faces, or undefined when the roof's surface is not derived (16.4.6). */
export function weightedFaces(o: CcwOutline, pitches: readonly (Pitch | undefined)[]): Map<number, QP[][]> | undefined {
  const v = lookup(o, pitches);
  return typeof v === 'string' ? undefined : v;
}

/** Why the roof's surface is not derived (16.4.6), or undefined when it is. */
export function weightedReason(o: CcwOutline, pitches: readonly (Pitch | undefined)[]): string | undefined {
  const v = lookup(o, pitches);
  return typeof v === 'string' ? v : undefined;
}

const cmp3 = (a: B3, b: B3): number => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
};

function dedupe3(pts: readonly B3[]): B3[] {
  const out: B3[] = [];
  for (const p of pts) if (out.length === 0 || cmp3(out[out.length - 1]!, p) !== 0) out.push(p);
  while (out.length > 1 && cmp3(out[0]!, out[out.length - 1]!) === 0) out.pop();
  return out;
}

const turns = (a: QP, p: QP, b: QP): boolean => qcross(qsub(p, a), qsub(b, p)).sign() !== 0;

/** 16.5 of a skeleton roof whose faces are derived; `pitches` by ring edge. */
export function weightedSurface(o: CcwOutline, pitches: readonly (Pitch | undefined)[], e: bigint): WeightedSurface {
  const rings = weightedFaces(o, pitches)!;
  const geo = new Map<number, { n: readonly [bigint, bigint]; c: bigint; L: bigint; k: Q }>();
  for (const j of rings.keys()) {
    const a = o.ring[j]!;
    const b = o.ring[(j + 1) % o.ring.length]!;
    const n = [-(b[1] - a[1]), b[0] - a[0]] as const;
    const [rise, run] = pitches[j]!;
    geo.set(j, { n, c: n[0] * a[0] + n[1] * a[1], L: exactSqrt(n[0] * n[0] + n[1] * n[1])!, k: Q.of(rise, run) });
  }
  const planeZ = (j: number, p: QP): Q => {
    const g = geo.get(j)!;
    return g.k.mul(p[0].mul(g.n[0]).add(p[1].mul(g.n[1])).sub(g.c)).div(g.L).add(e);
  };
  const zx = new Map<string, Q>();
  const pts = new Map<string, QP>();
  for (const [j, rs] of rings)
    for (const rg of rs)
      for (const p of rg) {
        const k = qkey(p);
        const z = planeZ(j, p);
        const prior = zx.get(k);
        if (prior !== undefined && !prior.eq(z)) throw new Error('faces disagree on an elevation');
        zx.set(k, z);
        pts.set(k, p);
      }
  const rd = (p: QP): B3 => [p[0].round(), p[1].round(), zx.get(qkey(p))!.round()];
  const nodes = new Set(o.ring.map((p) => qkey([Q.of(p[0]), Q.of(p[1])])));
  for (const rs of rings.values())
    for (const rg of rs)
      rg.forEach((p, i) => {
        if (turns(rg[(i - 1 + rg.length) % rg.length]!, p, rg[(i + 1) % rg.length]!)) nodes.add(qkey(p));
      });
  const faces: { edge: number; poly: B3[] }[] = [];
  for (const j of [...rings.keys()].sort((a, b) => o.index[a]! - o.index[b]!))
    for (const rg of rings.get(j)!) {
      const poly = dedupe3(rg.filter((p) => nodes.has(qkey(p))).map(rd));
      if (poly.length >= 3) faces.push({ edge: o.index[j]!, poly });
    }
  const gables: { edge: number; poly: B3[] }[] = [];
  for (let g = 0; g < o.kind.length; g++) {
    if (o.kind[g] !== 'gable') continue;
    const ga = o.ring[g]!;
    const gb = o.ring[(g + 1) % o.ring.length]!;
    const A: QP = [Q.of(ga[0]), Q.of(ga[1])];
    const B: QP = [Q.of(gb[0]), Q.of(gb[1])];
    const d = dirOf(A, B);
    const on = [...pts.entries()].filter(([k, p]) => nodes.has(k) && onClosed(p, A, B)).map(([, p]) => p);
    on.sort((p, q) => qdot(qsub(q, A), d).cmp(qdot(qsub(p, A), d)));
    gables.push({ edge: o.index[g]!, poly: dedupe3([[ga[0], ga[1], e], [gb[0], gb[1], e], ...on.map(rd)]) });
  }
  let high: Q | undefined;
  for (const z of zx.values()) if (high === undefined || z.cmp(high) > 0) high = z;
  return { high: high!.round(), faces, gables, lines: linesOf(o, pitches, rings, zx, rd, geo) };
}

/** 16.5 with 16.4.5: every boundary between the faces of two sloped edges that do not share a plane, merged where it runs straight. */
function linesOf(
  o: CcwOutline,
  pitches: readonly (Pitch | undefined)[],
  rings: Map<number, QP[][]>,
  zx: Map<string, Q>,
  rd: (p: QP) => B3,
  geo: Map<number, { n: readonly [bigint, bigint]; L: bigint; k: Q }>,
): WeightedSurface['lines'] {
  const key = new Map([...rings.keys()].map((j) => [j, planeKey(o.ring, j, pitches[j]!)]));
  const owner = new Map<string, { a: QP; b: QP; j: number }>();
  for (const [j, rs] of rings)
    for (const rg of rs)
      rg.forEach((a, i) => {
        const b = rg[(i + 1) % rg.length]!;
        owner.set(`${qkey(a)}>${qkey(b)}`, { a, b, j });
      });
  const pairs = new Map<string, { j: number; f: number; es: [QP, QP][] }>();
  for (const { a, b, j } of owner.values()) {
    const f = owner.get(`${qkey(b)}>${qkey(a)}`)?.j;
    if (f === undefined || f === j || key.get(f) === key.get(j) || j > f) continue;
    const k = `${j},${f}`;
    if (!pairs.has(k)) pairs.set(k, { j, f, es: [] });
    pairs.get(k)!.es.push([a, b]);
  }
  const out: WeightedSurface['lines'] = [];
  for (const { j, f, es } of pairs.values()) {
    const gj = geo.get(j)!;
    const gf = geo.get(f)!;
    for (const [a, b] of merge(es)) {
      const d = dirOf(a, b);
      const w: QP = [d[1].neg(), d[0]];
      let kind: 'ridge' | 'break' | 'hip' | 'valley';
      if (zx.get(qkey(a))!.eq(zx.get(qkey(b))!)) kind = gj.n[0] * gf.n[0] + gj.n[1] * gf.n[1] < 0n ? 'ridge' : 'break';
      else {
        const grad = (g: typeof gj): QP => [g.k.mul(g.n[0]).div(g.L), g.k.mul(g.n[1]).div(g.L)];
        kind = qdot(qsub(grad(gf), grad(gj)), w).sign() > 0 ? 'hip' : 'valley';
      }
      const p = rd(a);
      const q = rd(b);
      const [from, to] = cmp3(p, q) <= 0 ? [p, q] : [q, p];
      out.push({ kind, from, to });
    }
  }
  return out.sort((x, y) => cmp3(x.from, y.from) || cmp3(x.to, y.to) || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0));
}

/** Join atomic segments that continue one another in a straight line. */
function merge(es: readonly [QP, QP][]): [QP, QP][] {
  const nxt = new Map<string, QP>();
  const starts = new Map<string, QP>();
  for (const [a, b] of es) {
    nxt.set(qkey(a), b);
    starts.set(qkey(a), a);
  }
  const ends = new Set(es.map(([, b]) => qkey(b)));
  const out: [QP, QP][] = [];
  for (const [ka, a] of [...starts.entries()].sort((x, y) => qcmp(x[1], y[1]))) {
    if (ends.has(ka)) continue;
    const path: QP[] = [a];
    while (nxt.has(qkey(path[path.length - 1]!))) path.push(nxt.get(qkey(path[path.length - 1]!))!);
    let start = path[0]!;
    for (let i = 1; i + 1 < path.length; i++)
      if (turns(path[i - 1]!, path[i]!, path[i + 1]!)) {
        out.push([start, path[i]!]);
        start = path[i]!;
      }
    out.push([start, path[path.length - 1]!]);
  }
  return out;
}
