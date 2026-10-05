/**
 * The geometry of one level: wedges and corner sequences (5.6), face ends and outlines (5.7),
 * join overrides (5.8), junction fills (5.7), faces and room polygons (6.1, 6.2).
 *
 * Built only for a level whose graph is planar and whose walls all have face offsets — the
 * validator's graph invariants (FS-INV-101…108, 111) hold. Every point is exact until it is rounded
 * for output, once (2.2).
 */
import { area2, cross, isSimple, locate, onSegment, segmentsIntersect as segmentsMeet, type IPoint } from '../geometry/predicates.js';
import { HalfEdgeGraph, type Cycle, type Face } from '../geometry/halfedge.js';
import { faceLine, foot, intersect, roundPoint, xeq, type Line, type XPoint } from '../geometry/exact-point.js';
import type { JoinOverride } from '../model/document.js';

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
}

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

  constructor(junctions: readonly LevelJunction[], edges: readonly LevelEdge[]) {
    this.junctions = new Map(junctions.map((j) => [j.id, j]));
    this.edges = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.graph = new HalfEdgeGraph(new Map(junctions.map((j) => [j.id, j.pos])), this.edges);
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
      this.corners.set(jid, ends.map((_, i) => this.cornerSequence(jid, i)));
    }
    for (const e of this.edges) if (e.kind === 'wall') this.faceEnds.set(e.id, this.defaultFaceEnds(e));
    for (const j of junctions) if (j.join?.kind === 'butt') this.applyButt(j);
  }

  // ── 5.5, 5.6 ────────────────────────────────────────────────────────────────

  private pos(jid: string): IPoint {
    return this.junctions.get(jid)!.pos;
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
    return [intersect(this.leftLine(jid, ei), this.rightLine(jid, ej))];
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

  private defaultFaceEnds(e: LevelEdge): FaceEnds<XPoint> {
    const cs = this.corners.get(e.start)!;
    const ce = this.corners.get(e.end)!;
    const i = this.indexAt(e.start, e.id, true);
    const j = this.indexAt(e.end, e.id, false);
    const prev = <T>(arr: T[], x: number): T => arr[(x - 1 + arr.length) % arr.length]!;
    return {
      startLeft: cs[i]![0]!,
      startRight: prev(cs, i).at(-1)!,
      endRight: ce[j]![0]!,
      endLeft: prev(ce, j).at(-1)!,
    };
  }

  /** Set the face end of a wall's outgoing-left or outgoing-right face at a junction. */
  private setEnd(end: End, side: 'left' | 'right', p: XPoint): void {
    const fe = this.faceEnds.get(end.edge.id);
    if (!fe) return; // a separator has no outline
    if (end.atStart) {
      if (side === 'left') fe.startLeft = p;
      else fe.startRight = p;
    } else if (side === 'left') fe.endRight = p;
    else fe.endLeft = p;
  }

  // ── 5.8 ─────────────────────────────────────────────────────────────────────

  private applyButt(j: LevelJunction): void {
    if (j.join?.kind !== 'butt') return;
    const ends = this.ends.get(j.id)!;
    const through = j.join.through;
    if (through.length === 1) {
      const A = ends.find((e) => e.edge.id === through[0])!;
      const B = ends.find((e) => e !== A)!;
      const iA = ends.indexOf(A);
      const iB = ends.indexOf(B);
      const cs = this.corners.get(j.id)!;
      if (cross(A.d, B.d) > 0n) {
        // The wedge from A to B is convex.
        const c = cs[iA]![0]!;
        const r = cs[iB]![0]!;
        const p = intersect(this.leftLine(j.id, A), this.leftLine(j.id, B));
        this.setEnd(A, 'left', p);
        this.setEnd(A, 'right', r);
        this.setEnd(B, 'right', c);
        this.setEnd(B, 'left', p);
      } else {
        // The wedge from B to A is convex.
        const c = cs[iB]![0]!;
        const r = cs[iA]![0]!;
        const p = intersect(this.rightLine(j.id, A), this.rightLine(j.id, B));
        this.setEnd(A, 'right', p);
        this.setEnd(A, 'left', r);
        this.setEnd(B, 'left', c);
        this.setEnd(B, 'right', p);
      }
    } else {
      const J = this.pos(j.id);
      for (const id of through) {
        const W = ends.find((e) => e.edge.id === id)!;
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

  /** 5.7: the outline startRight → endRight → endLeft → startLeft, rounded, repeats removed. */
  outline(wallId: string): IPoint[] {
    const f = this.roundedFaceEnds(wallId);
    return dedupeCyclic([f.startRight, f.endRight, f.endLeft, f.startLeft]);
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
