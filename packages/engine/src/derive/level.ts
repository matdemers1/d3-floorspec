/**
 * The geometry of one level: wedges and corner sequences (5.6), face ends and outlines (5.7),
 * join overrides (5.8), junction fills (5.7), faces and room polygons (6.1, 6.2).
 *
 * Built only for a level whose graph is planar and whose walls all have face offsets — the
 * validator's graph invariants (FS-INV-101…108, 111, 113) hold. Every point is exact until it is
 * rounded for output, once (2.2).
 *
 * An arc edge (Core 0.4, chapter 21) is the chain of its polyline's segments: each is an edge of the
 * graph here, `<id>~<k>`, between the arc's junctions and its polyline's vertices `<id>^<k>`, which are
 * not junctions (21.3); `src` names the arc. At a junction, an arc's face is a face path, and corners
 * are found along it, cutting off the face vertices a join passes (21.4).
 */
import { area2, cross, isSimple, locate, onSegment, segmentsIntersect as segmentsMeet, type IPoint } from '../geometry/predicates.js';
import { HalfEdgeGraph, type Cycle, type Face } from '../geometry/halfedge.js';
import { faceLine, foot, intersect, roundPoint, xeq, type Line, type XPoint } from '../geometry/exact-point.js';
import type { JoinOverride } from '../model/document.js';
import { arcPolyline } from '../geometry/arcs.js';
import { Surd } from '../exact/surd.js';

export interface LevelJunction {
  readonly id: string;
  readonly pos: IPoint;
  readonly join: JoinOverride | undefined;
}

export interface LevelEdge {
  readonly id: string;
  readonly kind: 'wall' | 'separator';
  readonly start: string;
  readonly end: string;
  /** Doubled face offsets (5.4): 2a and 2b; 0 for a separator. */
  readonly a2: bigint;
  readonly b2: bigint;
  /** Core 0.4, 21.1: the sagitta of an arc edge whose arc fits — given to the constructor. */
  readonly sagitta?: bigint;
  /** 21.3: for a segment of an arc edge, the arc edge's ID; absent for an edge that is its own. */
  readonly src?: string;
}

/** The ID of the edge of the document a level-graph edge belongs to: an arc's, for one of its segments. */
export const srcOf = (e: LevelEdge): string => e.src ?? e.id;

export interface FaceEnds<P> {
  startRight: P;
  endRight: P;
  endLeft: P;
  startLeft: P;
}

export interface RoomPolygon {
  readonly outer: IPoint[];
  readonly holes: IPoint[][];
  /** Twice the net area: outer ring's signed area plus the holes' (negative) signed areas. */
  readonly area2: bigint;
  readonly degenerate: boolean;
}

export type AnchorLocation = { kind: 'onEdge' } | { kind: 'unbounded' } | { kind: 'face'; face: number };

/** Remove each vertex equal to the one before it, the first counting as following the last. */
export function dedupeCyclic(pts: readonly IPoint[]): IPoint[] {
  const out: IPoint[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  while (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
  return out;
}

const lessPoint = (a: IPoint, b: IPoint): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/** Rotate a ring to start at its least vertex (least x, then least y), keeping its orientation. */
export function startAtLeast(ring: readonly IPoint[]): IPoint[] {
  if (ring.length === 0) return [];
  let best = 0;
  for (let i = 1; i < ring.length; i++) if (lessPoint(ring[i]!, ring[best]!)) best = i;
  return [...ring.slice(best), ...ring.slice(0, best)];
}

export function comparePoints(a: IPoint, b: IPoint): number {
  return a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : 0;
}

interface End {
  /** The outgoing half-edge. */
  readonly h: number;
  readonly edge: LevelEdge;
  readonly atStart: boolean;
  readonly d: IPoint;
  /** Outgoing offsets (λ, ρ) of 5.5, doubled. */
  readonly lam2: bigint;
  readonly rho2: bigint;
}

export class LevelGeometry {
  readonly graph: HalfEdgeGraph;
  readonly edges: readonly LevelEdge[];
  readonly junctions: ReadonlyMap<string, LevelJunction>;
  /** Per junction: corner sequences of its wedges, wedge i from e_i to e_(i+1) (5.6). */
  readonly corners = new Map<string, XPoint[][]>();
  /** Per wall: its exact face ends, after joins (5.7, 5.8). */
  readonly faceEnds = new Map<string, FaceEnds<XPoint>>();
  private readonly ends = new Map<string, End[]>();
  private readonly rounded = new Map<XPoint, IPoint>();
  /** The vertices of arcs' polylines that are not junctions (21.3), and their positions. */
  private readonly vpos = new Map<string, IPoint>();
  /** Per edge of the document on this level: its level-graph edges, in order — one, or an arc's segments. */
  readonly chains = new Map<string, LevelEdge[]>();
  /** Per edge of the document: its polyline — two points for a straight edge (21.2). */
  readonly polylines = new Map<string, readonly IPoint[]>();
  /** The walls of the document on this level. */
  readonly walls: string[] = [];
  /** 21.4: the face vertices cut off at a junction — `junction|half-edge|side` (+1 its J-left, -1 its J-right). */
  private readonly cuts = new Map<string, number>();
  /** 21.4: the face vertices cut off each wall's faces by its face ends — `wall|start|left` and so on. */
  private readonly endCuts = new Map<string, number>();
  private readonly edgeIndex = new Map<string, number>();

  constructor(junctions: readonly LevelJunction[], edges: readonly LevelEdge[]) {
    this.junctions = new Map(junctions.map((j) => [j.id, j]));
    const expanded: LevelEdge[] = [];
    for (const e of edges) {
      if (e.kind === 'wall') this.walls.push(e.id);
      const S = this.junctions.get(e.start)!.pos;
      const E = this.junctions.get(e.end)!.pos;
      const poly = e.sagitta === undefined ? [S, E] : arcPolyline(S, E, e.sagitta);
      this.polylines.set(e.id, poly);
      if (poly.length === 2) {
        expanded.push({ id: e.id, kind: e.kind, start: e.start, end: e.end, a2: e.a2, b2: e.b2 });
        continue;
      }
      const names = [e.start, ...poly.slice(1, -1).map((_, k) => `${e.id}^${k + 1}`), e.end];
      poly.slice(1, -1).forEach((p, k) => this.vpos.set(names[k + 1]!, p));
      for (let k = 0; k < poly.length - 1; k++)
        expanded.push({ id: `${e.id}~${k + 1}`, kind: e.kind, start: names[k]!, end: names[k + 1]!, a2: e.a2, b2: e.b2, src: e.id });
    }
    this.edges = expanded.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.edges.forEach((e, i) => {
      const chain = this.chains.get(srcOf(e)) ?? [];
      chain.push(e);
      this.chains.set(srcOf(e), chain);
      this.edgeIndex.set(e.id, i);
    });
    for (const [id, chain] of this.chains) {
      if (chain.length < 2) continue;
      const k = (e: LevelEdge): number => Number(e.id.slice(id.length + 1));
      chain.sort((a, b) => k(a) - k(b));
    }
    const positions = new Map<string, IPoint>([...junctions.map((j): [string, IPoint] => [j.id, j.pos]), ...this.vpos]);
    this.graph = new HalfEdgeGraph(positions, this.edges);
    for (const [jid, star] of this.graph.stars) {
      const ends = star.map((h) => {
        const edge = this.edges[h >> 1]!;
        const atStart = (h & 1) === 0;
        return {
          h,
          edge,
          atStart,
          d: this.graph.direction(h),
          lam2: atStart ? edge.a2 : edge.b2,
          rho2: atStart ? edge.b2 : edge.a2,
        };
      });
      this.ends.set(jid, ends);
    }
    // The vertices of polylines first: a corner at a junction is found along face paths that end at them.
    const order = [...this.graph.stars.keys()].sort((a, b) => Number(this.junctions.has(a)) - Number(this.junctions.has(b)));
    for (const jid of order) this.corners.set(jid, this.ends.get(jid)!.map((_, i) => this.cornerSequence(jid, i)));
    for (const id of this.walls) this.faceEnds.set(id, this.defaultFaceEnds(id));
    for (const j of junctions) if (j.join?.kind === 'butt') this.applyButt(j);
  }

  // ── 5.5, 5.6 ────────────────────────────────────────────────────────────────

  private pos(jid: string): IPoint {
    return this.junctions.get(jid)?.pos ?? this.vpos.get(jid)!;
  }

  /** Is this a vertex of an arc's polyline rather than a junction (21.3)? */
  isVertex(id: string): boolean {
    return this.vpos.has(id);
  }

  /** The index in `edges` of an edge of the document — an arc's first segment (21.3). */
  edgeIndexOf(id: string): number {
    return this.edgeIndex.get(this.chains.get(id)![0]!.id)!;
  }

  leftLine(jid: string, end: End): Line {
    return faceLine(this.pos(jid), end.d, end.lam2);
  }

  rightLine(jid: string, end: End): Line {
    return faceLine(this.pos(jid), end.d, -end.rho2);
  }

  private cornerSequence(jid: string, i: number): XPoint[] {
    const ends = this.ends.get(jid)!;
    const k = ends.length;
    const ei = ends[i]!;
    const ej = ends[(i + 1) % k]!;
    if (k === 1 || cross(ei.d, ej.d) === 0n) {
      const J = this.pos(jid);
      const f1 = foot(J, ei.d, ei.lam2);
      const f2 = foot(J, ej.d, -ej.rho2);
      return xeq(f1, f2) ? [f1] : [f1, f2];
    }
    const m = this.meet(jid, ei, 1, ej, -1);
    this.cuts.set(`${jid}|${ei.h}|1`, m.a);
    this.cuts.set(`${jid}|${ej.h}|-1`, m.b);
    return [m.p];
  }

  // ── 21.4: face paths ────────────────────────────────────────────────────────

  /** The face path of an edge leaving junction J: [(vertex nearer J, the segment's end there)], from J out. */
  private path(jid: string, end: End): { v: string; end: End }[] {
    const chain = this.chains.get(srcOf(end.edge))!;
    if (chain.length === 1) return [{ v: jid, end }];
    const seq = end.atStart ? chain : [...chain].reverse();
    const out: { v: string; end: End }[] = [];
    let v = jid;
    for (const seg of seq) {
      const atStart = seg.start === v;
      const h = 2 * this.edgeIndex.get(seg.id)! + (atStart ? 0 : 1);
      out.push({ v, end: this.ends.get(v)!.find((x) => x.h === h)! });
      v = atStart ? seg.end : seg.start;
    }
    return out;
  }

  private line(v: string, end: End, side: 1 | -1): Line {
    return side > 0 ? this.leftLine(v, end) : this.rightLine(v, end);
  }

  /** 21.4: does p lie beyond the far end of piece a of a face path — past the rounded face vertex there? */
  private beyond(p: XPoint, path: { v: string; end: End }[], a: number, side: 1 | -1): boolean {
    const { v, end } = path[a + 1]!;
    const ends = this.ends.get(v)!;
    const i = ends.indexOf(end);
    const cs = this.corners.get(v)!;
    const fv = this.round(side > 0 ? cs[i]![0]! : cs[(i - 1 + ends.length) % ends.length]!.at(-1)!);
    const d = path[a]!.end.d;
    return p.x.sub(Surd.of(fv[0])).mulInt(d[0]).add(p.y.sub(Surd.of(fv[1])).mulInt(d[1])).sign() > 0;
  }

  /**
   * 21.4: where the `s1` face of one edge meets the `s2` face of another at junction J (+1 its J-left, -1
   * its J-right): along their face paths, moving to the next piece of each path the point lies beyond,
   * while there is one. `a` and `b` count the pieces passed — the face vertices the join cuts off.
   */
  private meet(jid: string, e1: End, s1: 1 | -1, e2: End, s2: 1 | -1): { p: XPoint; a: number; b: number } {
    if (!this.junctions.has(jid)) return { p: intersect(this.line(jid, e1, s1), this.line(jid, e2, s2)), a: 0, b: 0 };
    const p1 = this.path(jid, e1);
    const p2 = this.path(jid, e2);
    let a = 0;
    let b = 0;
    let p = intersect(this.line(jid, e1, s1), this.line(jid, e2, s2));
    for (;;) {
      const adv1 = a + 1 < p1.length && this.beyond(p, p1, a, s1) ? 1 : 0;
      const adv2 = b + 1 < p2.length && this.beyond(p, p2, b, s2) ? 1 : 0;
      if (!adv1 && !adv2) return { p, a, b };
      const l1 = this.line(p1[a + adv1]!.v, p1[a + adv1]!.end, s1);
      const l2 = this.line(p2[b + adv2]!.v, p2[b + adv2]!.end, s2);
      if (l1.A * l2.B - l2.A * l1.B === 0n) return { p, a, b };
      p = intersect(l1, l2);
      a += adv1;
      b += adv2;
    }
  }

  private cut(jid: string, end: End, side: 1 | -1): number {
    return this.cuts.get(`${jid}|${end.h}|${side}`) ?? 0;
  }

  /** The number of edges at a junction. */
  degree(jid: string): number {
    return this.ends.get(jid)?.length ?? 0;
  }

  /** The outgoing directions at a junction, in angular order. */
  directions(jid: string): { edge: LevelEdge; d: IPoint }[] {
    return (this.ends.get(jid) ?? []).map((e) => ({ edge: e.edge, d: e.d }));
  }

  // ── 5.7 ─────────────────────────────────────────────────────────────────────

  private indexAt(jid: string, edgeId: string, atStart: boolean): number {
    return this.ends.get(jid)!.findIndex((e) => e.edge.id === edgeId && e.atStart === atStart);
  }

  private defaultFaceEnds(id: string): FaceEnds<XPoint> {
    const chain = this.chains.get(id)!;
    const first = chain[0]!;
    const last = chain[chain.length - 1]!;
    const start = first.start;
    const endJ = last.end;
    const cs = this.corners.get(start)!;
    const ce = this.corners.get(endJ)!;
    const i = this.indexAt(start, first.id, true);
    const j = this.indexAt(endJ, last.id, false);
    const prev = <T>(arr: T[], x: number): T => arr[(x - 1 + arr.length) % arr.length]!;
    const es = this.ends.get(start)![i]!;
    const ee = this.ends.get(endJ)![j]!;
    this.endCuts.set(`${id}|start|left`, this.cut(start, es, 1));
    this.endCuts.set(`${id}|start|right`, this.cut(start, es, -1));
    this.endCuts.set(`${id}|end|right`, this.cut(endJ, ee, 1));
    this.endCuts.set(`${id}|end|left`, this.cut(endJ, ee, -1));
    return {
      startLeft: cs[i]![0]!,
      startRight: prev(cs, i).at(-1)!,
      endRight: ce[j]![0]!,
      endLeft: prev(ce, j).at(-1)!,
    };
  }

  /** Set the face end of a wall's outgoing-left or outgoing-right face at a junction, and the face vertices it cuts off. */
  private setEnd(end: End, side: 'left' | 'right', p: XPoint, cut = 0): void {
    const id = srcOf(end.edge);
    const fe = this.faceEnds.get(id);
    if (!fe) return; // a separator has no outline
    if (end.atStart) {
      if (side === 'left') fe.startLeft = p;
      else fe.startRight = p;
      this.endCuts.set(`${id}|start|${side}`, cut);
    } else if (side === 'left') {
      fe.endRight = p;
      this.endCuts.set(`${id}|end|right`, cut);
    } else {
      fe.endLeft = p;
      this.endCuts.set(`${id}|end|left`, cut);
    }
  }

  // ── 5.8 ─────────────────────────────────────────────────────────────────────

  private applyButt(j: LevelJunction): void {
    if (j.join?.kind !== 'butt') return;
    const ends = this.ends.get(j.id)!;
    const through = j.join.through;
    if (through.length === 1) {
      const A = ends.find((e) => srcOf(e.edge) === through[0])!;
      const B = ends.find((e) => e !== A)!;
      const iA = ends.indexOf(A);
      const iB = ends.indexOf(B);
      const cs = this.corners.get(j.id)!;
      if (cross(A.d, B.d) > 0n) {
        // The wedge from A to B is convex.
        const c = cs[iA]![0]!;
        const r = cs[iB]![0]!;
        const m = this.meet(j.id, A, 1, B, 1);
        this.setEnd(A, 'left', m.p, m.a);
        this.setEnd(A, 'right', r, this.cut(j.id, A, -1));
        this.setEnd(B, 'right', c, this.cut(j.id, B, -1));
        this.setEnd(B, 'left', m.p, m.b);
      } else {
        // The wedge from B to A is convex.
        const c = cs[iB]![0]!;
        const r = cs[iA]![0]!;
        const m = this.meet(j.id, A, -1, B, -1);
        this.setEnd(A, 'right', m.p, m.a);
        this.setEnd(A, 'left', r, this.cut(j.id, A, 1));
        this.setEnd(B, 'left', c, this.cut(j.id, B, 1));
        this.setEnd(B, 'right', m.p, m.b);
      }
    } else {
      const J = this.pos(j.id);
      for (const id of through) {
        const W = ends.find((e) => srcOf(e.edge) === id)!;
        this.setEnd(W, 'left', foot(J, W.d, W.lam2));
        this.setEnd(W, 'right', foot(J, W.d, -W.rho2));
      }
    }
  }

  // ── rounding ────────────────────────────────────────────────────────────────

  round(p: XPoint): IPoint {
    let r = this.rounded.get(p);
    if (!r) {
      r = roundPoint(p);
      this.rounded.set(p, r);
    }
    return r;
  }

  roundedFaceEnds(wallId: string): FaceEnds<IPoint> {
    const fe = this.faceEnds.get(wallId)!;
    return {
      startRight: this.round(fe.startRight),
      endRight: this.round(fe.endRight),
      endLeft: this.round(fe.endLeft),
      startLeft: this.round(fe.startLeft),
    };
  }

  /**
   * 21.4: an arc wall's left and right face vertices, rounded, from its start to its end, without those a
   * join at either end cuts off; none for a straight wall.
   */
  faceVertices(wallId: string): { left: IPoint[]; right: IPoint[] } {
    const chain = this.chains.get(wallId)!;
    const left: IPoint[] = [];
    const right: IPoint[] = [];
    for (const seg of chain.slice(1)) {
      const v = seg.start;
      const ends = this.ends.get(v)!;
      const i = this.indexAt(v, seg.id, true);
      const cs = this.corners.get(v)!;
      left.push(this.round(cs[i]![0]!));
      right.push(this.round(cs[(i - 1 + ends.length) % ends.length]!.at(-1)!));
    }
    const c = (k: string): number => this.endCuts.get(`${wallId}|${k}`) ?? 0;
    const trim = (xs: IPoint[], a: number, b: number): IPoint[] => xs.slice(a, Math.max(a, xs.length - b));
    return { left: trim(left, c('start|left'), c('end|left')), right: trim(right, c('start|right'), c('end|right')) };
  }

  /** 5.7, 21.4: the outline startRight → right face vertices → endRight → endLeft → left face vertices back → startLeft. */
  outline(wallId: string): IPoint[] {
    const f = this.roundedFaceEnds(wallId);
    const { left, right } = this.faceVertices(wallId);
    return dedupeCyclic([f.startRight, ...right, f.endRight, f.endLeft, ...[...left].reverse(), f.startLeft]);
  }

  /**
   * 21.4: arriving along half-edge h at a vertex of an arc's polyline, does the walk's left face turn at a
   * face vertex that a join at one of the arc's junctions cuts off?
   */
  private cutOff(h: number, v: string): boolean {
    if (!this.vpos.has(v)) return false;
    const seg = this.edges[h >> 1]!;
    const chain = this.chains.get(srcOf(seg))!;
    const k = chain.findIndex((e) => e.end === v) + 1;           // v is the arc's k-th vertex
    const side: 1 | -1 = (h & 1) === 0 ? 1 : -1;                // the arc's left (+1) or right (-1)
    const first = chain[0]!;
    const last = chain[chain.length - 1]!;
    const atStart = this.cuts.get(`${first.start}|${2 * this.edgeIndex.get(first.id)!}|${side}`) ?? 0;
    const atEnd = this.cuts.get(`${last.end}|${2 * this.edgeIndex.get(last.id)! + 1}|${-side}`) ?? 0;
    return k <= atStart || k >= chain.length - atEnd;
  }

  /** 5.7.2: is a wall's outline a simple polygon with positive area, counter-clockwise? */
  outlineOk(wallId: string): boolean {
    const o = this.outline(wallId);
    return o.length >= 3 && isSimple(o) && area2(o) > 0n;
  }

  /**
   * 5.7: the junction fill of a junction with three or more edges and the default join — the
   * corner sequences of all its wedges in wedge order, rounded, repeats removed. Undefined when the
   * junction has no fill (fewer than three edges, or a butt join); `empty` when it has fewer than
   * three vertices or zero area.
   */
  fill(jid: string): { ring: IPoint[]; empty: boolean; ok: boolean } | undefined {
    const j = this.junctions.get(jid)!;
    if (this.degree(jid) < 3 || j.join?.kind === 'butt') return undefined;
    const ring = dedupeCyclic(this.corners.get(jid)!.flat().map((p) => this.round(p)));
    const a = area2(ring);
    const empty = ring.length < 3 || a === 0n;
    return { ring: startAtLeast(ring), empty, ok: empty || (isSimple(ring) && a > 0n) };
  }

  // ── 6.1, 6.2 ────────────────────────────────────────────────────────────────

  get faces(): readonly Face[] {
    return this.graph.faces;
  }

  /** 6.2: the ring of a cycle — each wedge it passes through, corner sequence reversed. */
  ring(c: Cycle): IPoint[] {
    const pts: IPoint[] = [];
    for (const h of c.halfEdges) {
      const v = this.graph.dest(h);
      if (this.cutOff(h, v)) continue;
      const star = this.graph.stars.get(v)!;
      const m = this.graph.starIndex[h ^ 1]!;
      const seq = this.corners.get(v)![(m - 1 + star.length) % star.length]!;
      for (let t = seq.length - 1; t >= 0; t--) pts.push(this.round(seq[t]!));
    }
    return startAtLeast(dedupeCyclic(pts));
  }

  roomPolygon(face: Face): RoomPolygon {
    const outer = this.ring(face.outer);
    const holes = face.inner.map((c) => this.ring(c)).sort((a, b) => comparePoints(a[0] ?? [0n, 0n], b[0] ?? [0n, 0n]));
    const outerA = area2(outer);
    const holeAs = holes.map(area2);
    const total = holeAs.reduce((s, a) => s + a, outerA);
    return { outer, holes, area2: total, degenerate: isDegenerate(outer, holes, outerA, holeAs) };
  }

  /** 6.3: where a room's anchor is — on a location line, in the unbounded face, or in a face. */
  locateAnchor(p: IPoint): AnchorLocation {
    for (const e of this.edges) if (onSegment(p, this.pos(e.start), this.pos(e.end))) return { kind: 'onEdge' };
    const f = this.graph.innermostFace(p);
    return f ? { kind: 'face', face: this.graph.faces.indexOf(f) } : { kind: 'unbounded' };
  }
}

/** 6.2: are these rings, taken as a room polygon, degenerate? */
export function polygonDegenerate(outer: IPoint[], holes: IPoint[][]): boolean {
  return isDegenerate(outer, holes, area2(outer), holes.map(area2));
}

/** 6.2: is a room polygon degenerate? */
function isDegenerate(outer: IPoint[], holes: IPoint[][], outerA: bigint, holeAs: bigint[]): boolean {
  if (outer.length < 3 || !isSimple(outer) || outerA <= 0n) return true;
  for (let i = 0; i < holes.length; i++) {
    const h = holes[i]!;
    if (h.length < 3 || !isSimple(h) || holeAs[i]! >= 0n) return true;
    // Strictly inside the outer ring: every vertex inside, and no edge touching it.
    if (h.some((p) => locate(p, outer) !== 'inside')) return true;
    if (ringsTouch(h, outer)) return true;
  }
  for (let i = 0; i < holes.length; i++)
    for (let j = i + 1; j < holes.length; j++) {
      const a = holes[i]!;
      const b = holes[j]!;
      if (ringsTouch(a, b)) return true;
      if (a.some((p) => locate(p, b) !== 'outside') || b.some((p) => locate(p, a) !== 'outside')) return true;
    }
  return false;
}

function ringsTouch(a: IPoint[], b: IPoint[]): boolean {
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (segmentsMeet(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!)) return true;
  return false;
}
