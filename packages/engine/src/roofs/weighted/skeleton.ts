/**
 * The weighted straight skeleton of a roof (Core 0.4, 16.4.3 to 16.4.6), ported from the oracle
 * (tools/oracle/skeleton.py) step for step.
 *
 * Every quantity is an exact rational (Q on BigInt): nothing is a float and nothing is rounded here.
 * Elevation is measured from the eave, t = z − eave. Sloped edge e of the counter-clockwise eave
 * outline, from A with direction d, inward normal n = (−d.y, d.x) and integer length L = |n| (16.4.3),
 * at pitch rise : run, lies at elevation t on the line n · P = n · A + w t, w = L · run / rise; a
 * gable has w = 0 and stands still.
 *
 * The wavefront is a set of simple counter-clockwise polygons, each a cycle of wavefront edges
 * carrying the eave edges whose plane they lie in. Between event elevations each moving wavefront
 * edge sweeps a quadrilateral of its plane; at an event elevation every event is resolved at once
 * (16.4.4) — the pieces of the wavefront's position there, those covered once each way dropped, are
 * traced into cycles with the left-most turn, and every run of consecutive collinear wavefront edges
 * facing the same way is replaced by its fastest edges. The faces are the swept pieces united by
 * plane, a plane shared by collinear edges divided by the least distance along their line (16.4.5).
 * A roof the wavefront takes into a state of 16.4.6 throws Unsupported.
 */
import { exactSqrt, gcd } from '../../exact/bigint.js';
import { Q } from '../../exact/rational.js';
import type { IPoint } from '../../geometry/predicates.js';

/** The roof's surface is not derived (16.4.6). */
export class Unsupported extends Error {}

export type QP = readonly [Q, Q];
type BV = readonly [bigint, bigint];

const qp = (p: IPoint): QP => [Q.of(p[0]), Q.of(p[1])];
export const qkey = (p: QP): string => `${p[0].n}/${p[0].d},${p[1].n}/${p[1].d}`;
const qeq = (a: QP, b: QP): boolean => a[0].eq(b[0]) && a[1].eq(b[1]);
const qsub = (a: QP, b: QP): QP => [a[0].sub(b[0]), a[1].sub(b[1])];
const qcross = (a: QP, b: QP): Q => a[0].mul(b[1]).sub(a[1].mul(b[0]));
const qdot = (a: QP, b: QP): Q => a[0].mul(b[0]).add(a[1].mul(b[1]));
const bdot = (n: BV, p: QP): Q => p[0].mul(n[0]).add(p[1].mul(n[1]));
const qcmp = (a: QP, b: QP): number => a[0].cmp(b[0]) || a[1].cmp(b[1]);
const dirOf = (a: QP, b: QP): QP => qsub(b, a);

function onClosed(p: QP, a: QP, b: QP): boolean {
  if (qcross(qsub(b, a), qsub(p, a)).sign() !== 0) return false;
  const inRange = (i: 0 | 1): boolean => {
    const lo = a[i].cmp(b[i]) <= 0 ? a[i] : b[i];
    const hi = a[i].cmp(b[i]) <= 0 ? b[i] : a[i];
    return p[i].cmp(lo) >= 0 && p[i].cmp(hi) <= 0;
  };
  return inRange(0) && inRange(1);
}

const inOpen = (p: QP, a: QP, b: QP): boolean => !qeq(a, b) && !qeq(p, a) && !qeq(p, b) && onClosed(p, a, b);

function area2(ring: readonly QP[]): Q {
  let s = Q.ZERO;
  for (let i = 0; i < ring.length; i++) s = s.add(qcross(ring[i]!, ring[(i + 1) % ring.length]!));
  return s;
}

function dedupeCyclic(pts: readonly QP[]): QP[] {
  const out: QP[] = [];
  for (const p of pts) if (out.length === 0 || !qeq(out[out.length - 1]!, p)) out.push(p);
  while (out.length > 1 && qeq(out[0]!, out[out.length - 1]!)) out.pop();
  return out;
}

/** A wavefront edge: its line at elevation t is n · P = c + w t; `labels` the eave edges (ring indices) whose plane it lies in; s its speed in plan, run / rise, or 0. */
interface WEdge {
  readonly labels: readonly number[];
  readonly n: BV;
  readonly c: bigint;
  readonly w: Q;
  readonly s: Q;
}

const dOf = (e: WEdge): BV => [e.n[1], -e.n[0]];
const det = (a: WEdge, b: WEdge): bigint => a.n[0] * b.n[1] - a.n[1] * b.n[0];

function meet(a: WEdge, b: WEdge, t: Q): QP {
  const D = det(a, b);
  const ca = a.w.mul(t).add(a.c);
  const cb = b.w.mul(t).add(b.c);
  return [ca.mul(b.n[1]).sub(cb.mul(a.n[1])).div(D), cb.mul(a.n[0]).sub(ca.mul(b.n[0])).div(D)];
}

function velocity(a: WEdge, b: WEdge): QP {
  const D = det(a, b);
  return [a.w.mul(b.n[1]).sub(b.w.mul(a.n[1])).div(D), b.w.mul(a.n[0]).sub(a.w.mul(b.n[0])).div(D)];
}

const verts = (poly: readonly WEdge[], t: Q): QP[] => poly.map((e, i) => meet(poly[(i - 1 + poly.length) % poly.length]!, e, t));
const vels = (poly: readonly WEdge[]): QP[] => poly.map((e, i) => velocity(poly[(i - 1 + poly.length) % poly.length]!, e));
const at = (V: QP, U: QP, dt: Q): QP => [V[0].add(U[0].mul(dt)), V[1].add(U[1].mul(dt))];

// ── the eave edges (16.4.3) ─────────────────────────────────────────────────────

export type Kind = 'gable' | 'sloped' | 'level';
export type Pitch = readonly [bigint, bigint]; // [rise, run]

/** One wavefront edge per edge of the counter-clockwise outline; a sloped edge of irrational length is not derived. */
function eaveEdges(ring: readonly IPoint[], kinds: readonly Kind[], pitches: readonly (Pitch | undefined)[]): WEdge[] {
  return ring.map((a, j) => {
    const b = ring[(j + 1) % ring.length]!;
    const n: BV = [-(b[1] - a[1]), b[0] - a[0]];
    const c = n[0] * a[0] + n[1] * a[1];
    if (kinds[j] !== 'sloped') return { labels: [j], n, c, w: Q.ZERO, s: Q.ZERO };
    const L = exactSqrt(n[0] * n[0] + n[1] * n[1]);
    if (L === undefined) throw new Unsupported('a sloped edge whose length is irrational');
    const [rise, run] = pitches[j]!;
    return { labels: [j], n, c, w: Q.of(L * run, rise), s: Q.of(run, rise) };
  });
}

// ── the propagation (16.4.4) ────────────────────────────────────────────────────

/** 16.4.6: no wavefront polygon without a moving edge, and no end of a gable's wavefront edge that moves away from its other end. */
function check(polys: readonly (readonly WEdge[])[]): void {
  for (const poly of polys) {
    if (poly.every((e) => e.w.sign() === 0)) throw new Unsupported('a part of the outline enclosed by gables');
    const U = vels(poly);
    poly.forEach((e, i) => {
      if (e.w.sign() !== 0) return;
      const d = dOf(e);
      if (bdot(d, U[i]!).sign() < 0 || bdot(d, U[(i + 1) % poly.length]!).sign() > 0)
        throw new Unsupported('a gable whose wavefront edge would grow');
    });
  }
}

/** The least elevation after t at which a wavefront edge reaches no length or a vertex reaches a wavefront edge of its polygon that does not end at it. */
function nextEvent(polys: readonly (readonly WEdge[])[], t: Q): Q | undefined {
  let best: Q | undefined;
  const offer = (x: Q): void => {
    if (x.cmp(t) > 0 && (best === undefined || x.cmp(best) < 0)) best = x;
  };
  for (const poly of polys) {
    const m = poly.length;
    const V = verts(poly, t);
    const U = vels(poly);
    poly.forEach((e, i) => {
      const d = dOf(e);
      const i1 = (i + 1) % m;
      const l0 = bdot(d, qsub(V[i1]!, V[i]!));
      const ld = bdot(d, qsub(U[i1]!, U[i]!));
      if (ld.sign() < 0) offer(t.add(l0.div(ld.neg())));
      for (let j = 0; j < m; j++) {
        if (j === i || j === i1) continue;
        const f0 = bdot(e.n, V[j]!).sub(e.w.mul(t).add(e.c));
        const fd = bdot(e.n, U[j]!).sub(e.w);
        if (f0.sign() === 0 || fd.sign() === 0 || f0.sign() === fd.sign()) continue;
        const dt = f0.div(fd.neg());
        if (onClosed(at(V[j]!, U[j]!, dt), at(V[i]!, U[i]!, dt), at(V[i1]!, U[i1]!, dt))) offer(t.add(dt));
      }
    });
  }
  return best;
}

/** Orders outgoing directions so that the greatest is the left-most turn from din. */
function turnCmp(din: QP, a: QP, b: QP): number {
  const g = (v: QP): number => {
    const c = qcross(din, v).sign();
    const d = qdot(din, v).sign();
    return c > 0 || (c === 0 && d < 0) ? 1 : c === 0 ? 0 : -1;
  };
  const ga = g(a);
  const gb = g(b);
  if (ga !== gb) return ga - gb;
  const c = qcross(a, b).sign();
  return c > 0 ? -1 : c < 0 ? 1 : 0;
}

interface Piece<T> {
  readonly a: QP;
  readonly b: QP;
  readonly v: T;
}

/** Directed pieces, interior on their left, as boundary cycles: each arriving piece continues along the left-most turn (the standard resolution). */
export function trace<T>(segs: readonly Piece<T>[]): Piece<T>[][] {
  const outs = new Map<string, Piece<T>[]>();
  for (const s of segs) {
    const k = qkey(s.a);
    if (!outs.has(k)) outs.set(k, []);
    outs.get(k)!.push(s);
  }
  const succ = new Map<Piece<T>, Piece<T>>();
  for (const s of segs) {
    const din = dirOf(s.a, s.b);
    const cands = outs.get(qkey(s.b)) ?? [];
    let best = cands[0]!;
    for (const c of cands.slice(1)) if (turnCmp(din, dirOf(c.a, c.b), dirOf(best.a, best.b)) > 0) best = c;
    succ.set(s, best);
  }
  if (new Set(succ.values()).size !== segs.length) throw new Error('the boundary does not trace');
  const seen = new Set<Piece<T>>();
  const cycles: Piece<T>[][] = [];
  for (const s of [...segs].sort((p, q) => qcmp(p.a, q.a) || qcmp(p.b, q.b))) {
    if (seen.has(s)) continue;
    const cyc: Piece<T>[] = [];
    let cur = s;
    while (!seen.has(cur)) {
      seen.add(cur);
      cyc.push(cur);
      cur = succ.get(cur)!;
    }
    cycles.push(cyc);
  }
  return cycles;
}

/** 16.4.4: every event of one wavefront polygon at elevation t, at once. */
function resolve(poly: readonly WEdge[], t: Q): WEdge[][] {
  const m = poly.length;
  const V = verts(poly, t);
  const fwd = new Map<string, { a: QP; b: QP; es: WEdge[] }>();
  for (let i = 0; i < m; i++) {
    const a = V[i]!;
    const b = V[(i + 1) % m]!;
    if (qeq(a, b)) continue;
    const d = dirOf(a, b);
    const inner = V.filter((p, k) => inOpen(p, a, b) && V.findIndex((q) => qeq(q, p)) === k);
    inner.sort((p, q) => qdot(qsub(p, a), d).cmp(qdot(qsub(q, a), d)));
    const chain = [a, ...inner, b];
    for (let k = 0; k + 1 < chain.length; k++) {
      const key = `${qkey(chain[k]!)}>${qkey(chain[k + 1]!)}`;
      if (!fwd.has(key)) fwd.set(key, { a: chain[k]!, b: chain[k + 1]!, es: [] });
      fwd.get(key)!.es.push(poly[i]!);
    }
  }
  const segs: Piece<WEdge>[] = [];
  for (const { a, b, es } of fwd.values()) {
    const back = fwd.get(`${qkey(b)}>${qkey(a)}`)?.es ?? [];
    if (es.length !== 1 || back.length > 1) throw new Error('the wavefront covers a segment more than once each way');
    if (back.length === 0) segs.push({ a, b, v: es[0]! });
  }
  const out: WEdge[][] = [];
  for (const cyc of trace(segs)) {
    const es = cycleEdges(cyc, t);
    if (es) out.push(es);
  }
  return out;
}

const sameWay = (a: WEdge, b: WEdge): boolean => a.n[0] * b.n[1] - a.n[1] * b.n[0] === 0n && a.n[0] * b.n[0] + a.n[1] * b.n[1] > 0n;

/** A traced cycle as wavefront edges: pieces of one edge joined, and every run of consecutive collinear edges facing the same way replaced by its fastest edges (16.4.4). */
function cycleEdges(cyc: readonly Piece<WEdge>[], t: Q): WEdge[] | undefined {
  const k = cyc.length;
  const s = cyc.findIndex((p, i) => p.v !== cyc[(i - 1 + k) % k]!.v);
  if (s < 0) return undefined;
  const rot = [...cyc.slice(s), ...cyc.slice(0, s)];
  let es: WEdge[] = [];
  for (const p of rot) if (es.length === 0 || es[es.length - 1] !== p.v) es.push(p.v);
  if (es.length > 1 && es[0] === es[es.length - 1]) es.pop();
  const n = es.length;
  const s2 = es.findIndex((e, i) => !sameWay(es[(i - 1 + n) % n]!, e));
  if (s2 < 0) return undefined;
  es = [...es.slice(s2), ...es.slice(0, s2)];
  const runs: WEdge[][] = [[es[0]!]];
  for (const e of es.slice(1)) {
    const last = runs[runs.length - 1]!;
    if (sameWay(last[last.length - 1]!, e)) last.push(e);
    else runs.push([e]);
  }
  const out: WEdge[] = runs.map((r) => {
    if (r.length === 1) return r[0]!;
    let top = r[0]!.s;
    for (const e of r) if (e.s.cmp(top) > 0) top = e.s;
    const fast = r.filter((e) => e.s.eq(top));
    const rep = fast.reduce((x, y) => (Math.min(...y.labels) < Math.min(...x.labels) ? y : x));
    const labels = [...new Set(fast.flatMap((e) => e.labels))].sort((a, b) => a - b);
    return { labels, n: rep.n, c: rep.c, w: rep.w, s: rep.s };
  });
  if (out.length < 3) return undefined;
  const pts = new Set(rot.map((p) => qkey(p.a)));
  out.forEach((e, i) => {
    if (!pts.has(qkey(meet(out[(i - 1 + out.length) % out.length]!, e, t)))) throw new Error('a resolved vertex off the traced boundary');
  });
  return out;
}

/** 16.4.4 from t = 0: the pieces the moving wavefront edges sweep, as (labels, counter-clockwise ring). */
function propagate(edges: readonly WEdge[]): { labels: readonly number[]; q: QP[] }[] {
  let polys: WEdge[][] = [[...edges]];
  let t = Q.ZERO;
  const traps: { labels: readonly number[]; q: QP[] }[] = [];
  for (let guard = 0; polys.length > 0; guard++) {
    if (guard > 100000) throw new Error('the propagation does not end');
    check(polys);
    const nt = nextEvent(polys, t);
    if (nt === undefined) throw new Error('a wavefront with no next event');
    for (const poly of polys) {
      const A = verts(poly, t);
      const B = verts(poly, nt);
      const m = poly.length;
      poly.forEach((e, i) => {
        if (e.w.sign() === 0) return;
        const q = dedupeCyclic([A[i]!, A[(i + 1) % m]!, B[(i + 1) % m]!, B[i]!]);
        if (q.length < 3) return;
        const a2 = area2(q).sign();
        if (a2 < 0) throw new Error('a piece swept backwards');
        if (a2 > 0) traps.push({ labels: e.labels, q });
      });
    }
    polys = polys.flatMap((p) => resolve(p, nt));
    t = nt;
  }
  return traps;
}

// ── faces (16.4.5) ──────────────────────────────────────────────────────────────

function prim(v: BV): BV {
  const g = gcd(v[0], v[1]);
  return [v[0] / g, v[1] / g];
}

/** Sloped edges share a plane when they lie on one line, face the same way and have one pitch. */
export function planeKey(ring: readonly IPoint[], j: number, p: Pitch): string {
  const a = ring[j]!;
  const b = ring[(j + 1) % ring.length]!;
  const n = prim([-(b[1] - a[1]), b[0] - a[0]]);
  const pr = Q.of(p[0], p[1]);
  return `${n[0]},${n[1]};${n[0] * a[0] + n[1] * a[1]};${pr.n}/${pr.d}`;
}

/** A convex polygon cut to lo ≤ d · P ≤ hi, exactly. */
function clip(poly: readonly QP[], d: BV, lo: Q | undefined, hi: Q | undefined): QP[] | undefined {
  const cut = (pts: readonly QP[], f: (p: QP) => Q): QP[] => {
    const out: QP[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[(i + 1) % pts.length]!;
      const fp = f(p);
      const fq = f(q);
      if (fp.sign() >= 0) out.push(p);
      if (fp.sign() * fq.sign() < 0) {
        const r = fp.div(fp.sub(fq));
        out.push([p[0].add(q[0].sub(p[0]).mul(r)), p[1].add(q[1].sub(p[1]).mul(r))]);
      }
    }
    return out;
  };
  let pts: QP[] = [...poly];
  if (lo !== undefined) pts = cut(pts, (p) => bdot(d, p).sub(lo));
  if (hi !== undefined && pts.length > 0) pts = cut(pts, (p) => hi.sub(bdot(d, p)));
  pts = dedupeCyclic(pts);
  return pts.length >= 3 && area2(pts).sign() > 0 ? pts : undefined;
}

/** Points, found by the line a segment lies on. */
class PointIndex {
  private readonly pts: QP[];
  private readonly by = new Map<string, Map<string, QP[]>>();
  constructor(points: Iterable<QP>) {
    const seen = new Map<string, QP>();
    for (const p of points) seen.set(qkey(p), p);
    this.pts = [...seen.values()];
  }
  inside(a: QP, b: QP): QP[] {
    const d = dirOf(a, b);
    const l = (d[0].d * d[1].d) / gcd(d[0].d, d[1].d);
    let di = prim([d[0].n * (l / d[0].d), d[1].n * (l / d[1].d)]);
    if (di[0] < 0n || (di[0] === 0n && di[1] < 0n)) di = [-di[0], -di[1]];
    const dk = `${di[0]},${di[1]}`;
    let tab = this.by.get(dk);
    if (!tab) {
      tab = new Map();
      for (const p of this.pts) {
        const c = bdot([di[1], -di[0]], p);
        const k = `${c.n}/${c.d}`;
        if (!tab.has(k)) tab.set(k, []);
        tab.get(k)!.push(p);
      }
      this.by.set(dk, tab);
    }
    const ca = bdot([di[1], -di[0]], a);
    const on = (tab.get(`${ca.n}/${ca.d}`) ?? []).filter((p) => inOpen(p, a, b));
    return on.sort((p, q) => qdot(qsub(p, a), d).cmp(qdot(qsub(q, a), d)));
  }
}

function union(polys: readonly QP[][], index: PointIndex): QP[][] {
  const count = new Map<string, { a: QP; b: QP; k: number }>();
  for (const q of polys)
    for (let i = 0; i < q.length; i++) {
      const a = q[i]!;
      const b = q[(i + 1) % q.length]!;
      const chain = [a, ...index.inside(a, b), b];
      for (let k = 0; k + 1 < chain.length; k++) {
        const key = `${qkey(chain[k]!)}>${qkey(chain[k + 1]!)}`;
        const e = count.get(key);
        if (e) e.k += 1;
        else count.set(key, { a: chain[k]!, b: chain[k + 1]!, k: 1 });
      }
    }
  const segs: Piece<null>[] = [];
  for (const { a, b, k } of count.values()) {
    const net = k - (count.get(`${qkey(b)}>${qkey(a)}`)?.k ?? 0);
    if (net > 1) throw new Error('faces overlap');
    if (net === 1) segs.push({ a, b, v: null });
  }
  return trace(segs).map((cyc) => {
    const ring = cyc.map((p) => p.a);
    if (area2(ring).sign() <= 0) throw new Error('a face with a hole');
    return ring;
  });
}

/** The faces of the weighted straight skeleton: ring edge → rings of exact points, counter-clockwise; or Unsupported (16.4.6). */
export function weightedSkeleton(ring: readonly IPoint[], kinds: readonly Kind[], pitches: readonly (Pitch | undefined)[]): Map<number, QP[][]> {
  const traps = propagate(eaveEdges(ring, kinds, pitches));
  let total = Q.ZERO;
  for (const { q } of traps) total = total.add(area2(q));
  if (!total.eq(area2(ring.map(qp)))) throw new Error('the faces do not cover the outline');
  const sloped = kinds.flatMap((k, j) => (k === 'sloped' ? [j] : []));
  const key = new Map(sloped.map((j) => [j, planeKey(ring, j, pitches[j]!)]));
  const classes = new Map<string, number[]>();
  for (const j of sloped) {
    const k = key.get(j)!;
    if (!classes.has(k)) classes.set(k, []);
    classes.get(k)!.push(j);
  }
  const pieces = new Map<number, QP[][]>();
  const add = (j: number, q: QP[]): void => {
    if (!pieces.has(j)) pieces.set(j, []);
    pieces.get(j)!.push(q);
  };
  for (const { labels, q } of traps) {
    const j0 = Math.min(...labels);
    const members = classes.get(key.get(j0)!)!;
    if (members.length === 1) {
      add(members[0]!, q);
      continue;
    }
    const a0 = ring[j0]!;
    const b0 = ring[(j0 + 1) % ring.length]!;
    const nn = prim([-(b0[1] - a0[1]), b0[0] - a0[0]]);
    const d: BV = [nn[1], -nn[0]];
    const span = new Map(members.map((j): [number, [bigint, bigint]] => {
      const a = ring[j]!;
      const b = ring[(j + 1) % ring.length]!;
      const u = d[0] * a[0] + d[1] * a[1];
      const v = d[0] * b[0] + d[1] * b[1];
      return [j, u < v ? [u, v] : [v, u]];
    }));
    const sorted = [...members].sort((x, y) => (span.get(x)![0] < span.get(y)![0] ? -1 : 1));
    const seams = sorted.slice(1).map((y, i) => Q.of(span.get(sorted[i]!)![1] + span.get(y)![0], 2n));
    sorted.forEach((j, i) => {
      const c = clip(q, d, i > 0 ? seams[i - 1] : undefined, i < seams.length ? seams[i] : undefined);
      if (c) add(j, c);
    });
  }
  const index = new PointIndex([...pieces.values()].flat(2));
  const out = new Map<number, QP[][]>();
  for (const [j, qs] of pieces) out.set(j, union(qs, index));
  return out;
}

export { qcmp, qdot, qsub, onClosed, dirOf, qcross };
