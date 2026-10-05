/**
 * Roofs (Core 0.3, chapter 16): a roof's edges (16.1, 16.2), its eave outline (16.3), the roof
 * invariants FS-INV-801 to FS-INV-805, the class of roofs whose surface this draft derives and the
 * lint FS-LINT-015 for the others (16.4), and the derived `roofs` (16.5).
 *
 * Everything is exact and rounded once (2.2). The eave outline is the footprint with every edge
 * moved out by its overhang — each vertex the intersection of its two edges' moved lines, of the form
 * of a corner point (5.5), rounded once; on a rectilinear footprint it is exact. Everything after it
 * is computed from the rounded outline.
 *
 * A flat roof is the outline at its eave. A shed roof is one plane through its sloped edge,
 * z(P) = eave + (rise / run) · n·(P − A) / |n|, one radicand. An equal-pitch roof on a rectilinear
 * outline (16.4.3) rises with its rise distance h(P) — the least Chebyshev distance from P to a
 * sloped edge — and z(P) = eave + (rise / run) · h(P): the straight-skeleton roof, whose every node
 * has coordinates that are multiples of one half.
 *
 * Its faces are found as the oracle finds them (tools/oracle/roofs.py), by sweeping the wavefront:
 * for each interval between the times at which two of the lines x = xᵢ, x = xᵢ ± t, the seams, and
 * their y counterparts cross, the wavefront {P : h(P) ≥ t + ε} is the union of the cells of the grid
 * those lines cut whose centres it contains, with t + ε symbolic (a pair a + b·ε, compared
 * lexicographically); every side of it on a sloped edge's moving line sweeps a trapezoid of that
 * edge's face until the next time. The trapezoids of a face are united by cancelling opposite atomic
 * edges. Every quantity in the sweep is a multiple of one quarter, so it is held as an integer times
 * four: no rational arithmetic and no float.
 */
import { Surd } from '../exact/surd.js';
import { roundHalfEvenRational, toSafeNumber } from '../exact/bigint.js';
import { intersect, roundPoint, type Line } from '../geometry/exact-point.js';
import { area2, cross, dot, isSimple, onSegment, type IPoint } from '../geometry/predicates.js';
import { entries, get, type FloorspecDocument, type Roof } from '../model/document.js';
import { weightedFaces, weightedReason, weightedSurface } from './weighted/surface.js';

type EdgeKind = 'gable' | 'sloped' | 'level';
export type RoofKind = 'flat' | 'shed' | 'gable' | 'hip';

// ── members (16.1, 16.2) ────────────────────────────────────────────────────────

const footprintOf = (roof: Roof): IPoint[] => roof.footprint.map((p) => [BigInt(p[0]), BigInt(p[1])] as const);

const edgeOf = (roof: Roof, i: number): { gable?: boolean; pitch?: { rise: number; run: number }; overhang?: number } =>
  (roof.edges && Object.hasOwn(roof.edges, String(i)) ? roof.edges[String(i)] : undefined) ?? {};

/** The overhang of edge i: its own, else the roof's, else 0. */
export const overhangOf = (roof: Roof, i: number): bigint => BigInt(edgeOf(roof, i).overhang ?? roof.overhang ?? 0);

/** The effective pitch of edge i, as [rise, run], or undefined. */
export function pitchOf(roof: Roof, i: number): readonly [bigint, bigint] | undefined {
  const p = edgeOf(roof, i).pitch ?? roof.pitch;
  return p ? [BigInt(p.rise), BigInt(p.run)] : undefined;
}

/** 16.2: each edge is a gable, sloped or level. */
export function edgeKinds(roof: Roof): EdgeKind[] {
  return roof.footprint.map((_, i) => (edgeOf(roof, i).gable === true ? 'gable' : pitchOf(roof, i) ? 'sloped' : 'level'));
}

/** 16.3: the elevation of the eaves — the level's elevation plus the roof's height (default: the level's height). */
export function eaveOf(doc: FloorspecDocument, roof: Roof): bigint {
  const L = get(doc.levels, roof.level)!;
  return BigInt(L.elevation) + BigInt(roof.height ?? L.height);
}

/** 16.2: flat, shed, gable or hip. */
export function roofKind(ks: readonly EdgeKind[]): RoofKind {
  if (ks.every((k) => k === 'level')) return 'flat';
  if (ks.filter((k) => k === 'sloped').length === 1) return 'shed';
  return ks.includes('gable') ? 'gable' : 'hip';
}

// ── the eave outline (16.3) ─────────────────────────────────────────────────────

const dir = (a: IPoint, b: IPoint): IPoint => [b[0] - a[0], b[1] - a[1]];

/** 16.2.3: two consecutive edges of the footprint are collinear. */
export function collinearVertex(fp: readonly IPoint[]): boolean {
  const n = fp.length;
  return fp.some((_, i) => cross(dir(fp[(i - 1 + n) % n]!, fp[i]!), dir(fp[i]!, fp[(i + 1) % n]!)) === 0n);
}

/**
 * 16.3: every edge of the footprint moved away from its inside by its overhang, each vertex the
 * intersection of the moved lines of its two edges, rounded once — in the footprint's order — or
 * undefined when it does not fit (FS-INV-805). The footprint has no collinear vertex (FS-INV-804).
 */
export function eaveOutline(roof: Roof): IPoint[] | undefined {
  const fp = footprintOf(roof);
  const n = fp.length;
  const ccw = area2(fp) > 0n ? 1n : -1n;
  const lines: Line[] = fp.map((a, i) => {
    const b = fp[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const A = -dy;
    const B = dx;
    return { A, B, C: Surd.sqrt(dx * dx + dy * dy).mulInt(-ccw * overhangOf(roof, i)).addInt(A * a[0] + B * a[1]) };
  });
  const out: IPoint[] = fp.map((_, i) => roundPoint(intersect(lines[(i - 1 + n) % n]!, lines[i]!)));
  for (let i = 0; i < n; i++) if (dot(dir(fp[i]!, fp[(i + 1) % n]!), dir(out[i]!, out[(i + 1) % n]!)) <= 0n) return undefined;
  const a = area2(out);
  if (!isSimple(out) || (a > 0n ? 1n : a < 0n ? -1n : 0n) !== ccw) return undefined;
  return out;
}

// ── invariants (FS-INV-801 … 805) ───────────────────────────────────────────────

export type RoofCode = 'FS-INV-801' | 'FS-INV-802' | 'FS-INV-803' | 'FS-INV-804' | 'FS-INV-805';

/** FS-INV-801 to FS-INV-805 for one roof (10.3); FS-INV-805 not for a roof with FS-INV-804. */
export function roofInvariants(roof: Roof): RoofCode[] {
  const out: RoofCode[] = [];
  const n = roof.footprint.length;
  if (Object.keys(roof.edges ?? {}).some((k) => Number(k) >= n)) out.push('FS-INV-801');
  const ks = edgeKinds(roof);
  if (ks.includes('level') && ks.some((k) => k !== 'level')) out.push('FS-INV-802');
  else if (ks.every((k) => k === 'gable')) out.push('FS-INV-803');
  if (collinearVertex(footprintOf(roof))) out.push('FS-INV-804');
  else if (!eaveOutline(roof)) out.push('FS-INV-805');
  return out;
}

// ── the supported class (16.4) ──────────────────────────────────────────────────

const rectilinear = (ring: readonly IPoint[]): boolean =>
  ring.every((p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    return p[0] === q[0] || p[1] === q[1];
  });

/** The eave outline walked counter-clockwise, each edge with its index in the footprint. */
class Outline {
  readonly ring: IPoint[];
  readonly index: number[];
  readonly kind: EdgeKind[];
  readonly n: number;
  constructor(outline: readonly IPoint[], ks: readonly EdgeKind[]) {
    const n = outline.length;
    if (area2(outline) > 0n) {
      this.ring = [...outline];
      this.index = outline.map((_, j) => j);
    } else {
      this.ring = [...outline].reverse();
      this.index = outline.map((_, j) => (((n - 2 - j) % n) + n) % n);
    }
    this.n = n;
    this.kind = this.index.map((i) => ks[i]!);
  }
  seg(j: number): [IPoint, IPoint] {
    const n = this.n;
    return [this.ring[((j % n) + n) % n]!, this.ring[(((j + 1) % n) + n) % n]!];
  }
  kindAt(j: number): EdgeKind {
    return this.kind[((j % this.n) + this.n) % this.n]!;
  }
}

type Method = 'flat' | 'shed' | 'skeleton' | 'weighted';

/** The effective pitch of every edge of the counter-clockwise outline, undefined for a gable. */
const ringPitches = (roof: Roof, o: Outline): ((readonly [bigint, bigint]) | undefined)[] =>
  o.kind.map((k, j) => (k === 'sloped' ? pitchOf(roof, o.index[j]!) : undefined));

/**
 * 16.4: how the surface is derived — or undefined when the draft does not derive it. A Core 0.4
 * reader (`core04`) derives every roof with two or more sloped edges by the weighted straight
 * skeleton (16.4.3 to 16.4.6 of 0.4); a Core 0.3 reader only equal pitches on a rectilinear outline.
 */
function methodOf(roof: Roof, outline: readonly IPoint[], core04 = false): Method | undefined {
  const ks = edgeKinds(roof);
  if (ks.every((k) => k === 'level')) return 'flat';
  const o = new Outline(outline, ks);
  const sloped = o.kind.flatMap((k, j) => (k === 'sloped' ? [j] : []));
  if (sloped.length === 1) {
    const [a, b] = o.seg(sloped[0]!);
    const nrm: IPoint = [-(b[1] - a[1]), b[0] - a[0]];
    return o.ring.every((v) => dot(nrm, dir(a, v)) >= 0n) ? 'shed' : undefined;
  }
  if (core04) return weightedFaces(o, ringPitches(roof, o)) ? 'weighted' : undefined;
  const [r0, n0] = pitchOf(roof, o.index[sloped[0]!]!)!;
  if (!sloped.every((j) => {
    const [r, n] = pitchOf(roof, o.index[j]!)!;
    return r * n0 === r0 * n;
  }))
    return undefined;
  if (!rectilinear(o.ring)) return undefined;
  const segs = sloped.map((j) => segOf(o, j));
  for (let j = 0; j < o.n; j++) {
    if (o.kind[j] !== 'gable') continue;
    if (o.kindAt(j - 1) !== 'sloped' || o.kindAt(j + 1) !== 'sloped') return undefined;
    const [a, b] = o.seg(j);
    const prev = o.seg(j - 1)[0];
    const next = o.seg(j + 1)[1];
    if (cross(dir(prev, a), dir(a, b)) <= 0n || cross(dir(a, b), dir(b, next)) <= 0n) return undefined;
    if (segs.some((s) => meetsClearance(s, a, b))) return undefined;
  }
  return 'skeleton';
}

/**
 * Condition 3 of 16.4.3: does sloped edge s meet the open rectangle outside the gable edge a → b,
 * as deep as half its length? Coordinates doubled, to keep the half-depth integral.
 */
function meetsClearance(s: Seg, a: IPoint, b: IPoint): boolean {
  const d = dir(a, b);
  const far = [a, b].map((p): IPoint => [2n * p[0] + d[1], 2n * p[1] - d[0]]);
  const xs = [2n * a[0], 2n * b[0], far[0]![0], far[1]![0]];
  const ys = [2n * a[1], 2n * b[1], far[0]![1], far[1]![1]];
  const x0 = min(xs);
  const x1 = max(xs);
  const y0 = min(ys);
  const y1 = max(ys);
  const c = 2n * s.c;
  const lo = 2n * s.lo;
  const hi = 2n * s.hi;
  if (s.o === 'v') return x0 < c && c < x1 && lo < y1 && hi > y0;
  return y0 < c && c < y1 && lo < x1 && hi > x0;
}

const min = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => (b < a ? b : a));
const max = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => (b > a ? b : a));

// ── sloped edges of a rectilinear outline ───────────────────────────────────────

/**
 * An axis-parallel sloped edge: orientation 'h' (y = c) or 'v' (x = c), extent [lo, hi] along it,
 * and s, the sign of its inward normal (+1 towards +y or +x); `j` its index on the outline.
 */
interface Seg {
  readonly o: 'h' | 'v';
  readonly c: bigint;
  readonly lo: bigint;
  readonly hi: bigint;
  readonly s: 1n | -1n;
  readonly j: number;
}

function segOf(o: Outline, j: number): Seg {
  const [a, b] = o.seg(j);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dy === 0n) return { o: 'h', c: a[1], lo: a[0] < b[0] ? a[0] : b[0], hi: a[0] < b[0] ? b[0] : a[0], s: dx > 0n ? 1n : -1n, j };
  return { o: 'v', c: a[0], lo: a[1] < b[1] ? a[1] : b[1], hi: a[1] < b[1] ? b[1] : a[1], s: dy > 0n ? -1n : 1n, j };
}

/** A symbolic number (a + b·ε) / 4: exact, compared lexicographically. */
type Sym = readonly [bigint, bigint];
type SPoint = readonly [Sym, Sym];

const ZERO: Sym = [0n, 0n];
const k4 = (v: bigint): Sym => [4n * v, 0n];
const sadd = (p: Sym, q: Sym): Sym => [p[0] + q[0], p[1] + q[1]];
const ssub = (p: Sym, q: Sym): Sym => [p[0] - q[0], p[1] - q[1]];
const sneg = (p: Sym): Sym => [-p[0], -p[1]];
/** Half of a sum of two grid values: both components are even (see the module comment). */
const shalf = (p: Sym): Sym => [p[0] / 2n, p[1] / 2n];
const scmp = (p: Sym, q: Sym): number => (p[0] !== q[0] ? (p[0] < q[0] ? -1 : 1) : p[1] !== q[1] ? (p[1] < q[1] ? -1 : 1) : 0);
const smax = (...ps: Sym[]): Sym => ps.reduce((a, b) => (scmp(b, a) > 0 ? b : a));
const sabs = (p: Sym): Sym => (scmp(p, ZERO) < 0 ? sneg(p) : p);
const seq = (p: Sym, q: Sym): boolean => p[0] === q[0] && p[1] === q[1];

/** How far P's foot on the edge's line lies beyond the edge: 0 within it. */
const along = (P: SPoint, s: Seg): Sym => {
  const u = s.o === 'v' ? P[1] : P[0];
  return smax(ssub(k4(s.lo), u), ZERO, ssub(u, k4(s.hi)));
};

/** The signed distance of P from the edge's line, positive inwards. */
const perp = (P: SPoint, s: Seg): Sym => {
  const d = ssub(s.o === 'v' ? P[0] : P[1], k4(s.c));
  return s.s > 0n ? d : sneg(d);
};

/** 16.4.3: h(P), the least Chebyshev distance from P to a sloped edge. */
function riseDistance(P: SPoint, segs: readonly Seg[]): Sym {
  let best: Sym | undefined;
  for (const s of segs) {
    const c = smax(sabs(perp(P, s)), along(P, s));
    if (!best || scmp(c, best) < 0) best = c;
  }
  return best!;
}

/** The seams between consecutive collinear sloped edges that face the same way, ×4: x-values of horizontal edges', y-values of vertical ones'. */
function seams(segs: readonly Seg[]): { xs: Set<bigint>; ys: Set<bigint> } {
  const groups = new Map<string, Seg[]>();
  for (const s of segs) {
    const k = `${s.o}|${s.c}|${s.s}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const xs = new Set<bigint>();
  const ys = new Set<bigint>();
  for (const g of groups.values()) {
    g.sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0));
    for (let i = 0; i + 1 < g.length; i++) (g[0]!.o === 'h' ? xs : ys).add(2n * (g[i]!.hi + g[i + 1]!.lo));
  }
  return { xs, ys };
}

/** A symbolic point strictly inside a rectilinear ring (it is never on one of its lines). */
function insideRing(P: SPoint, ring: readonly IPoint[]): boolean {
  const [px, py] = P;
  let w = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (a[0] !== b[0]) continue;
    const lo = a[1] < b[1] ? a[1] : b[1];
    const hi = a[1] < b[1] ? b[1] : a[1];
    if (scmp(k4(a[0]), px) > 0 && scmp(k4(lo), py) < 0 && scmp(py, k4(hi)) < 0) w++;
  }
  return w % 2 === 1;
}

/** Every t > 0 (×4) at which two of the lines v (still) and m ± t (moving) cross. */
function crossingTimes(values: Iterable<bigint>, moving: readonly bigint[], out: Set<bigint>): void {
  const all = [...values];
  for (const m of moving) {
    for (const v of all) if (v !== m) out.add(v > m ? v - m : m - v);
    for (const m2 of moving) if (m2 > m) out.add((m2 - m) / 2n);
  }
}

/** A plan point, ×4 — every node of a skeleton roof has coordinates that are multiples of a half. */
type P4 = readonly [bigint, bigint];
const key = (p: P4): string => `${p[0]},${p[1]}`;

interface Skeleton {
  /** Outline edge j → the boundary rings of its face, counter-clockwise, ×4. */
  readonly faces: Map<number, P4[][]>;
  readonly segs: readonly Seg[];
  readonly byJ: ReadonlyMap<number, Seg>;
}

/** 16.4.3: the faces of an equal-pitch roof on a rectilinear outline, by the wavefront sweep. */
function skeleton(o: Outline): Skeleton {
  const segs: Seg[] = [];
  const gables: Seg[] = [];
  for (let j = 0; j < o.n; j++) {
    if (o.kind[j] === 'sloped') segs.push(segOf(o, j));
    else if (o.kind[j] === 'gable') gables.push(segOf(o, j));
  }
  const byJ = new Map(segs.map((s) => [s.j, s]));
  const sortB = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
  const Xs = [...new Set(o.ring.map((p) => 4n * p[0]))].sort(sortB);
  const Ys = [...new Set(o.ring.map((p) => 4n * p[1]))].sort(sortB);
  const { xs: sx, ys: sy } = seams(segs);
  const timeSet = new Set<bigint>();
  crossingTimes(new Set([...Xs, ...sx]), Xs, timeSet);
  crossingTimes(new Set([...Ys, ...sy]), Ys, timeSet);
  const times = [...timeSet].sort(sortB);
  const x0 = Xs[0]!;
  const x1 = Xs[Xs.length - 1]!;
  const y0 = Ys[0]!;
  const y1 = Ys[Ys.length - 1]!;
  const quads = new Map<number, P4[][]>();
  let t = 0n;
  let ti = 0;
  for (;;) {
    while (ti < times.length && times[ti]! <= t) ti++;
    const nxt = ti < times.length ? times[ti]! : undefined;
    const tau: Sym = [t, 4n];
    const grid = (vals: readonly bigint[], extra: ReadonlySet<bigint>, lo: bigint, hi: bigint): Sym[] => {
      const g = new Map<string, Sym>();
      const put = (s: Sym): void => {
        if (scmp(s, [lo, 0n]) >= 0 && scmp(s, [hi, 0n]) <= 0) g.set(`${s[0]},${s[1]}`, s);
      };
      for (const v of vals) put([v, 0n]);
      for (const v of extra) put([v, 0n]);
      for (const v of vals) {
        put([v + t, 4n]);
        put([v - t, -4n]);
      }
      return [...g.values()].sort(scmp);
    };
    const gx = grid(Xs, sx, x0, x1);
    const gy = grid(Ys, sy, y0, y1);
    const W = new Set<string>();
    const cells: [number, number][] = [];
    for (let i = 0; i + 1 < gx.length; i++) {
      const cx = shalf(sadd(gx[i]!, gx[i + 1]!));
      for (let k = 0; k + 1 < gy.length; k++) {
        const P: SPoint = [cx, shalf(sadd(gy[k]!, gy[k + 1]!))];
        if (insideRing(P, o.ring) && scmp(riseDistance(P, segs), tau) > 0) {
          W.add(`${i},${k}`);
          cells.push([i, k]);
        }
      }
    }
    if (!W.size) break;
    if (nxt === undefined) throw new Error('roof skeleton: the wavefront outlives every candidate time');
    // Every side of the wavefront, with W on its left: (orientation, line, p0, p1, inward sign).
    const pieces = new Map<string, { j: number; ps: [SPoint, SPoint][] }>();
    const side = (orient: 'h' | 'v', line: Sym, p0: SPoint, p1: SPoint, s: 1n | -1n): void => {
      const mid = orient === 'v' ? shalf(sadd(p0[1], p1[1])) : shalf(sadd(p0[0], p1[0]));
      if (line[1] === 0n && gables.some((g) => g.o === orient && 4n * g.c === line[0] && g.s === s && scmp(k4(g.lo), mid) <= 0 && scmp(mid, k4(g.hi)) <= 0)) return; // on a gable: no face
      const cands = segs
        .filter((sg) => sg.o === orient && sg.s === s && seq([4n * sg.c + s * t, 4n * s], line))
        .map((sg) => ({ a: smax(ssub(k4(sg.lo), mid), ZERO, ssub(mid, k4(sg.hi))), j: sg.j }))
        .sort((p, q) => scmp(p.a, q.a) || p.j - q.j);
      if (!cands.length) throw new Error(`roof skeleton: a side of the wavefront on no sloped edge`);
      if (cands.length > 1 && seq(cands[0]!.a, cands[1]!.a)) throw new Error('roof skeleton: a side on a seam');
      const j = cands[0]!.j;
      const k = `${orient}|${line[0]},${line[1]}|${s}|${j}`;
      if (!pieces.has(k)) pieces.set(k, { j, ps: [] });
      pieces.get(k)!.ps.push([p0, p1]);
    };
    for (const [i, k] of cells) {
      if (!W.has(`${i - 1},${k}`)) side('v', gx[i]!, [gx[i]!, gy[k + 1]!], [gx[i]!, gy[k]!], 1n);
      if (!W.has(`${i + 1},${k}`)) side('v', gx[i + 1]!, [gx[i + 1]!, gy[k]!], [gx[i + 1]!, gy[k + 1]!], -1n);
      if (!W.has(`${i},${k - 1}`)) side('h', gy[k]!, [gx[i]!, gy[k]!], [gx[i + 1]!, gy[k]!], 1n);
      if (!W.has(`${i},${k + 1}`)) side('h', gy[k + 1]!, [gx[i + 1]!, gy[k + 1]!], [gx[i]!, gy[k + 1]!], -1n);
    }
    const dt = nxt - t;
    // A grid value's ε-coefficient is −4, 0 or 4, so at time dt it has moved by exactly ±dt (×4).
    const at = (p: SPoint, T: bigint): P4 => [p[0][0] + (p[0][1] / 4n) * T, p[1][0] + (p[1][1] / 4n) * T];
    for (const { j, ps } of pieces.values()) {
      for (const [p0, p1] of chain(ps)) {
        const q = dedupe4([at(p0, 0n), at(p1, 0n), at(p1, dt), at(p0, dt)]);
        if (q.length >= 3 && area2(q) !== 0n) {
          if (area2(q) < 0n) throw new Error('roof skeleton: a trapezoid runs clockwise');
          if (!quads.has(j)) quads.set(j, []);
          quads.get(j)!.push(q);
        }
      }
    }
    t = nxt;
  }
  const verts = new VertexIndex([...quads.values()].flat(2));
  const faces = new Map<number, P4[][]>();
  for (const [j, qs] of quads) faces.set(j, union(qs, verts));
  return { faces, segs, byJ };
}

const skey = (p: SPoint): string => `${p[0][0]},${p[0][1]},${p[1][0]},${p[1][1]}`;

/** Join consecutive collinear sides (the end of one the start of the next) into maximal pieces. */
function chain(ps: readonly [SPoint, SPoint][]): [SPoint, SPoint][] {
  const starts = new Map<string, { p0: SPoint; p1: SPoint }>();
  for (const [p0, p1] of ps) starts.set(skey(p0), { p0, p1 });
  const ends = new Set(ps.map(([, p1]) => skey(p1)));
  const out: [SPoint, SPoint][] = [];
  for (const [k0, { p0 }] of starts) {
    if (ends.has(k0)) continue;
    let q = p0;
    while (starts.has(skey(q))) q = starts.get(skey(q))!.p1;
    out.push([p0, q]);
  }
  return out;
}

function dedupe4(pts: readonly P4[]): P4[] {
  const out: P4[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  while (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
  return out;
}

const inOpenSegment = (p: P4, a: P4, b: P4): boolean =>
  !(a[0] === b[0] && a[1] === b[1]) && !(p[0] === a[0] && p[1] === a[1]) && !(p[0] === b[0] && p[1] === b[1]) && onSegment(p, a, b);

/** Points indexed by the four directions every edge here runs in: x, y, x − y and x + y. */
class VertexIndex {
  private readonly by: Map<bigint, P4[]>[] = [0, 1, 2, 3].map(() => new Map<bigint, P4[]>());
  constructor(points: readonly P4[]) {
    const seen = new Set<string>();
    for (const p of points) {
      const k = key(p);
      if (seen.has(k)) continue;
      seen.add(k);
      VertexIndex.keys(p).forEach((kk, i) => {
        const m = this.by[i]!;
        if (!m.has(kk)) m.set(kk, []);
        m.get(kk)!.push(p);
      });
    }
  }
  private static keys(p: P4): bigint[] {
    return [p[0], p[1], p[0] - p[1], p[0] + p[1]];
  }
  /** The indexed points strictly inside segment a–b, ordered from a to b. */
  inside(a: P4, b: P4): P4[] {
    const d = [b[0] - a[0], b[1] - a[1]] as const;
    const k = d[0] === 0n ? 0 : d[1] === 0n ? 1 : d[0] === d[1] ? 2 : 3;
    if (k === 3 && d[0] !== -d[1]) throw new Error('roof skeleton: an edge in no direction of the index');
    const cand = this.by[k]!.get(VertexIndex.keys(a)[k]!) ?? [];
    const proj = (p: P4): bigint => (p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1];
    return cand.filter((p) => inOpenSegment(p, a, b)).sort((p, q) => (proj(p) < proj(q) ? -1 : proj(p) > proj(q) ? 1 : 0));
  }
}

function atomic(ring: readonly P4[], verts: VertexIndex): [P4, P4][] {
  const out: [P4, P4][] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const pts = [a, ...verts.inside(a, b), b];
    for (let k = 0; k + 1 < pts.length; k++) out.push([pts[k]!, pts[k + 1]!]);
  }
  return out;
}

/** The turn from din to dout, ranked: the left-most turn ranks highest. */
function turnCmp(din: P4, a: P4, b: P4): number {
  const g = (v: P4): number => {
    const c = cross(din, v);
    const d = dot(din, v);
    return c > 0n || (c === 0n && d < 0n) ? 1 : c === 0n ? 0 : -1;
  };
  const ga = g(a);
  const gb = g(b);
  if (ga !== gb) return ga - gb;
  const c = cross(a, b);
  return c > 0n ? -1 : c < 0n ? 1 : 0;
}

/** The union of interior-disjoint counter-clockwise polygons, as its boundary cycles, each counter-clockwise. */
function union(polys: readonly P4[][], verts: VertexIndex): P4[][] {
  const count = new Map<string, { a: P4; b: P4; k: number }>();
  for (const q of polys)
    for (const [a, b] of atomic(q, verts)) {
      const k = `${key(a)}>${key(b)}`;
      const e = count.get(k);
      if (e) e.k++;
      else count.set(k, { a, b, k: 1 });
    }
  const out = new Map<string, { p: P4; next: P4[] }>();
  for (const { a, b, k } of count.values()) {
    const net = k - (count.get(`${key(b)}>${key(a)}`)?.k ?? 0);
    if (net > 1) throw new Error('roof skeleton: overlapping trapezoids');
    if (net === 1) {
      const ka = key(a);
      if (!out.has(ka)) out.set(ka, { p: a, next: [] });
      out.get(ka)!.next.push(b);
    }
  }
  const rings: P4[][] = [];
  while (out.size) {
    const [startKey, { p: start }] = out.entries().next().value!;
    const ring: P4[] = [start];
    let prev: P4 | undefined;
    let cur = start;
    let curKey = startKey;
    for (;;) {
      const node = out.get(curKey)!;
      let nb: P4;
      if (node.next.length === 1) nb = node.next[0]!;
      else {
        // A pinch: the left-most turn keeps cycles apart.
        const din: P4 = [cur[0] - prev![0], cur[1] - prev![1]];
        nb = node.next.reduce((best, w) => (turnCmp(din, [w[0] - cur[0], w[1] - cur[1]], [best[0] - cur[0], best[1] - cur[1]]) > 0 ? w : best));
      }
      node.next.splice(node.next.indexOf(nb), 1);
      if (!node.next.length) out.delete(curKey);
      prev = cur;
      cur = nb;
      curKey = key(cur);
      if (curKey === startKey) break;
      ring.push(cur);
    }
    if (area2(ring) <= 0n) throw new Error('roof skeleton: a face with a hole');
    rings.push(ring);
  }
  return rings;
}

// ── lints (FS-LINT-015) ─────────────────────────────────────────────────────────

/** 16.4.4 (0.3), 16.4.6 (0.4): is this roof's surface derived? The roof has no FS-INV-801 … 805. */
export function surfaceDerived(roof: Roof, core04 = false): boolean {
  return methodOf(roof, eaveOutline(roof)!, core04) !== undefined;
}

/**
 * Why a roof's surface is not derived, in words, or undefined when it is: for a Core 0.4 reader the
 * condition of 16.4.6 it meets; for a Core 0.3 reader the class of 16.4.3 of 0.3 it is outside.
 */
export function surfaceNotDerivedReason(roof: Roof, core04 = false): string | undefined {
  const outline = eaveOutline(roof)!;
  if (methodOf(roof, outline, core04) !== undefined) return undefined;
  const ks = edgeKinds(roof);
  const o = new Outline(outline, ks);
  if (o.kind.filter((k) => k === 'sloped').length === 1) return 'part of its outline lies outside the line of its one sloped edge';
  if (!core04) return 'its pitches differ, its outline has an oblique edge, or a gable is not at the end of a wing';
  return weightedReason(o, ringPitches(roof, o)) ?? 'it is not derived';
}

// ── derived values (16.5) ───────────────────────────────────────────────────────

type P3 = [number, number, number];

export interface DerivedRoofFace {
  edge?: number;
  polygon: P3[];
  area: string;
}
export interface DerivedRoofLine {
  /** `break` (Core 0.4): a level line where the roof over one side changes pitch. */
  kind: 'ridge' | 'break' | 'hip' | 'valley';
  from: P3;
  to: P3;
}
export interface DerivedRoof {
  kind: RoofKind;
  outline: [number, number][];
  eave: number;
  surface: null | {
    high: number;
    box: { min: P3; max: P3 };
    faces: DerivedRoofFace[];
    gables: { edge: number; polygon: P3[] }[];
    lines: DerivedRoofLine[];
  };
}

type B3 = readonly [bigint, bigint, bigint];
const cmp3 = (a: B3, b: B3): number => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
};
const num3 = (p: B3): P3 => [toSafeNumber(p[0]), toSafeNumber(p[1]), toSafeNumber(p[2])];

function dedupe3(pts: readonly B3[]): B3[] {
  const out: B3[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || cmp3(p, q) !== 0) out.push(p);
  }
  while (out.length > 1 && cmp3(out[0]!, out[out.length - 1]!) === 0) out.pop();
  return out;
}

const leastFirst3 = (ring: readonly B3[]): B3[] => {
  let k = 0;
  for (let i = 1; i < ring.length; i++) if (cmp3(ring[i]!, ring[k]!) < 0) k = i;
  return [...ring.slice(k), ...ring.slice(0, k)];
};

const leastFirst2 = (ring: readonly IPoint[]): IPoint[] => {
  let k = 0;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[k]!;
    if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) k = i;
  }
  return [...ring.slice(k), ...ring.slice(0, k)];
};

/** Half of a BigInt, as a decimal string (6.4). */
function halfString(twice: bigint): string {
  const neg = twice < 0n;
  const a = neg ? -twice : twice;
  const s = `${a / 2n}${a % 2n === 1n ? '.5' : ''}`;
  return neg ? `-${s}` : s;
}

const areaOf = (ring: readonly B3[]): string => halfString(area2(ring.map((p) => [p[0], p[1]] as const)));

/** A ×4 coordinate rounded once. */
const r4 = (v: bigint): bigint => roundHalfEvenRational(v, 4n);

/** 16.5: every roof of a valid document, as a Core 0.4 reader (`core04`) or a Core 0.3 reader derives it. */
export function deriveRoofs(doc: FloorspecDocument, core04 = false): Record<string, DerivedRoof> {
  const out: Record<string, DerivedRoof> = {};
  for (const [id, roof] of entries(doc.roofs)) {
    const ks = edgeKinds(roof);
    const outline = eaveOutline(roof)!;
    const e = eaveOf(doc, roof);
    const ring = area2(outline) > 0n ? outline : [...outline].reverse();
    const m = methodOf(roof, outline, core04);
    const v: DerivedRoof = {
      kind: roofKind(ks),
      outline: leastFirst2(ring).map((p) => [toSafeNumber(p[0]), toSafeNumber(p[1])]),
      eave: toSafeNumber(e),
      surface: m === undefined ? null : surfaceOf(roof, outline, ks, e, m),
    };
    Object.defineProperty(out, id, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function gableEnd(index: number, a: IPoint, b: IPoint, on: readonly B3[], e: bigint): { edge: number; polygon: P3[] } {
  const d = dir(a, b);
  const proj = (p: B3): bigint => (p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1];
  const sorted = [...on].sort((p, q) => (proj(p) > proj(q) ? -1 : proj(p) < proj(q) ? 1 : 0));
  return { edge: index, polygon: dedupe3([[a[0], a[1], e], [b[0], b[1], e], ...sorted]).map(num3) };
}

function surfaceOf(roof: Roof, outline: readonly IPoint[], ks: readonly EdgeKind[], e: bigint, m: Method): NonNullable<DerivedRoof['surface']> {
  const o = new Outline(outline, ks);
  const faces: { edge?: number; poly: B3[] }[] = [];
  const gables: { edge: number; polygon: P3[] }[] = [];
  let lines: DerivedRoofLine[] = [];
  let high: bigint;
  if (m === 'flat') {
    faces.push({ poly: o.ring.map((p) => [p[0], p[1], e]) });
    high = e;
  } else if (m === 'shed') {
    const j = o.kind.indexOf('sloped');
    const [a, b] = o.seg(j);
    const [rise, run] = pitchOf(roof, o.index[j]!)!;
    const nrm: IPoint = [-(b[1] - a[1]), b[0] - a[0]];
    const D = dot(nrm, nrm);
    const z = (p: IPoint): Surd => Surd.sqrt(D).mulInt(rise * dot(nrm, dir(a, p))).divInt(run * D).addInt(e);
    faces.push({ edge: o.index[j]!, poly: o.ring.map((p) => [p[0], p[1], z(p).round()]) });
    let hz = z(o.ring[0]!);
    for (const p of o.ring) if (z(p).cmp(hz) > 0) hz = z(p);
    high = hz.round();
    for (let g = 0; g < o.n; g++)
      if (o.kind[g] === 'gable') {
        const [ga, gb] = o.seg(g);
        gables.push(gableEnd(o.index[g]!, ga, gb, [ga, gb].map((p): B3 => [p[0], p[1], z(p).round()]), e));
      }
  } else if (m === 'weighted') {
    const w = weightedSurface(o, ringPitches(roof, o), e);
    faces.push(...w.faces);
    for (const g of w.gables) gables.push({ edge: g.edge, polygon: g.poly.map(num3) });
    lines = w.lines.map((l) => ({ kind: l.kind, from: num3(l.from), to: num3(l.to) }));
    high = w.high;
  } else {
    const j0 = o.kind.indexOf('sloped');
    const [rise, run] = pitchOf(roof, o.index[j0]!)!;
    const sk = skeleton(o);
    // z(P) = e + (rise / run) · h(P), with h(P) ×4 from the sweep's own measure.
    const h4 = (p: P4): bigint => riseDistance([[p[0], 0n], [p[1], 0n]], sk.segs)[0];
    const zr = (p: P4): bigint => roundHalfEvenRational(4n * run * e + rise * h4(p), 4n * run);
    const nodes = new Set(o.ring.map((p) => key([4n * p[0], 4n * p[1]])));
    for (const rs of sk.faces.values())
      for (const rg of rs) {
        const n = rg.length;
        rg.forEach((p, i) => {
          const a = rg[(i - 1 + n) % n]!;
          const b = rg[(i + 1) % n]!;
          if (cross([p[0] - a[0], p[1] - a[1]], [b[0] - p[0], b[1] - p[1]]) !== 0n) nodes.add(key(p));
        });
      }
    for (const j of [...sk.faces.keys()].sort((a, b) => o.index[a]! - o.index[b]!))
      for (const rg of sk.faces.get(j)!) {
        const poly = dedupe3(rg.filter((p) => nodes.has(key(p))).map((p): B3 => [r4(p[0]), r4(p[1]), zr(p)]));
        if (poly.length >= 3) faces.push({ edge: o.index[j]!, poly }); // a face narrower than a base unit can round away
      }
    let hmax = 0n;
    const all = new Map<string, P4>();
    for (const rs of sk.faces.values())
      for (const rg of rs)
        for (const p of rg) {
          all.set(key(p), p);
          const h = h4(p);
          if (h > hmax) hmax = h;
        }
    high = roundHalfEvenRational(4n * run * e + rise * hmax, 4n * run);
    for (let g = 0; g < o.n; g++)
      if (o.kind[g] === 'gable') {
        const [ga, gb] = o.seg(g);
        const a4: P4 = [4n * ga[0], 4n * ga[1]];
        const b4: P4 = [4n * gb[0], 4n * gb[1]];
        const on = [...all.values()].filter((p) => nodes.has(key(p)) && onSegment(p, a4, b4));
        // Sort along the edge with the ×4 points, then round.
        const d = dir(a4, b4);
        const proj = (p: P4): bigint => (p[0] - a4[0]) * d[0] + (p[1] - a4[1]) * d[1];
        on.sort((p, q) => (proj(p) > proj(q) ? -1 : proj(p) < proj(q) ? 1 : 0));
        gables.push({ edge: o.index[g]!, polygon: dedupe3([[ga[0], ga[1], e], [gb[0], gb[1], e], ...on.map((p): B3 => [r4(p[0]), r4(p[1]), zr(p)])]).map(num3) });
      }
    lines = linesOf(sk, h4, zr);
  }
  const outFaces: DerivedRoofFace[] = faces
    .map((f) => ({ edge: f.edge, polygon: leastFirst3(dedupe3(f.poly)) }))
    .sort((a, b) => (a.edge ?? -1) - (b.edge ?? -1) || cmp3(a.polygon[0]!, b.polygon[0]!))
    .map((f) => ({ ...(f.edge !== undefined && { edge: f.edge }), polygon: f.polygon.map(num3), area: areaOf(f.polygon) }));
  gables.sort((a, b) => a.edge - b.edge);
  const xs = o.ring.map((p) => p[0]);
  const ys = o.ring.map((p) => p[1]);
  const thickness = BigInt(roof.thickness ?? 0);
  return {
    high: toSafeNumber(high),
    box: { min: num3([min(xs), min(ys), e - thickness]), max: num3([max(xs), max(ys), high]) },
    faces: outFaces,
    gables,
    lines,
  };
}

/** 16.5: the ridges, hips and valleys — every boundary between the faces of two edges that are not collinear, merged where it runs straight. */
function linesOf(sk: Skeleton, h4: (p: P4) => bigint, zr: (p: P4) => bigint): DerivedRoofLine[] {
  const owner = new Map<string, { a: P4; b: P4; j: number }>();
  for (const [j, rs] of sk.faces)
    for (const rg of rs)
      for (let i = 0; i < rg.length; i++) {
        const a = rg[i]!;
        const b = rg[(i + 1) % rg.length]!;
        owner.set(`${key(a)}>${key(b)}`, { a, b, j });
      }
  const pairs = new Map<string, { j: number; f: number; es: [P4, P4][] }>();
  for (const { a, b, j } of owner.values()) {
    const f = owner.get(`${key(b)}>${key(a)}`)?.j;
    if (f === undefined || f === j) continue;
    const se = sk.byJ.get(j)!;
    const sf = sk.byJ.get(f)!;
    if (se.o === sf.o && se.c === sf.c && se.s === sf.s) continue; // a seam between coplanar faces
    if (j < f) {
      const k = `${j},${f}`;
      if (!pairs.has(k)) pairs.set(k, { j, f, es: [] });
      pairs.get(k)!.es.push([a, b]);
    }
  }
  const out: { kind: DerivedRoofLine['kind']; from: B3; to: B3 }[] = [];
  for (const { j, f, es } of pairs.values()) {
    const se = sk.byJ.get(j)!;
    const sf = sk.byJ.get(f)!;
    const ne: IPoint = se.o === 'v' ? [se.s, 0n] : [0n, se.s];
    const nf: IPoint = sf.o === 'v' ? [sf.s, 0n] : [0n, sf.s];
    for (const [a, b] of merge(es)) {
      const d = dir(a, b);
      const w: IPoint = [-d[1], d[0]]; // into face j, on the left of a → b
      const kind = h4(a) === h4(b) ? 'ridge' : dot([nf[0] - ne[0], nf[1] - ne[1]], w) > 0n ? 'hip' : 'valley';
      const p: B3 = [r4(a[0]), r4(a[1]), zr(a)];
      const q: B3 = [r4(b[0]), r4(b[1]), zr(b)];
      const [from, to] = cmp3(p, q) <= 0 ? [p, q] : [q, p];
      out.push({ kind, from, to });
    }
  }
  out.sort((x, y) => cmp3(x.from, y.from) || cmp3(x.to, y.to));
  return out.map((l) => ({ kind: l.kind, from: num3(l.from), to: num3(l.to) }));
}

/** Join atomic segments that continue one another in a straight line. */
function merge(es: readonly [P4, P4][]): [P4, P4][] {
  const nxt = new Map<string, P4>();
  const pts = new Map<string, P4>();
  for (const [a, b] of es) {
    nxt.set(key(a), b);
    pts.set(key(a), a);
  }
  const ends = new Set(es.map(([, b]) => key(b)));
  const out: [P4, P4][] = [];
  for (const [ka, a] of pts) {
    if (ends.has(ka)) continue;
    const path: P4[] = [a];
    while (nxt.has(key(path[path.length - 1]!))) path.push(nxt.get(key(path[path.length - 1]!))!);
    let start = path[0]!;
    for (let i = 1; i + 1 < path.length; i++) {
      if (cross(dir(path[i - 1]!, path[i]!), dir(path[i]!, path[i + 1]!)) !== 0n) {
        out.push([start, path[i]!]);
        start = path[i]!;
      }
    }
    out.push([start, path[path.length - 1]!]);
  }
  return out;
}
