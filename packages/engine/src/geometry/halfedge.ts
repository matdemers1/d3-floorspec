/**
 * A half-edge structure for one level's plane graph (5.3, 6.1), built on exact integer positions.
 *
 * Every edge is two half-edges, one each way, each with the face on its left. Around a junction,
 * outgoing half-edges are sorted by angle counter-clockwise from +X (5.6); arriving at junction J
 * along e_m, a boundary walk leaves along e_(m−1), the next edge clockwise (6.1). The walks are the
 * cycles; a cycle of positive area is the outer cycle of a bounded face, and each connected
 * component has exactly one other cycle, its outside, which is either the unbounded face's or an
 * inner cycle (a hole) of the innermost bounded face around it.
 *
 * The graph must be planar (5.3): faces of a graph whose edges cross are not defined.
 */
import { area2, compareAngle, sub, winding, type IPoint } from './predicates.js';

export interface HEdgeInput {
  readonly id: string;
  readonly start: string;
  readonly end: string;
}

export interface Cycle {
  /** Half-edge indices in walk order. Half-edge 2e runs from edge e's start to its end; 2e+1 back. */
  readonly halfEdges: readonly number[];
  /** The junctions the walk leaves from, in order. */
  readonly vertices: readonly string[];
  /** Twice the signed area of the walk's junction polygon. */
  readonly area2: bigint;
  readonly component: number;
}

export interface Face {
  readonly outer: Cycle;
  readonly inner: Cycle[];
}

export class HalfEdgeGraph {
  readonly edges: readonly HEdgeInput[];
  readonly positions: ReadonlyMap<string, IPoint>;
  /** Per junction: outgoing half-edges sorted by angle (e_0 … e_(k−1) of 5.6). */
  readonly stars = new Map<string, number[]>();
  /** For each half-edge: its index in its origin's star. */
  readonly starIndex: number[] = [];
  readonly cycles: Cycle[] = [];
  readonly cycleOf: number[] = [];
  /** Bounded faces, in the order of their outer cycles' discovery. */
  readonly faces: Face[] = [];
  /** The cycles bounding the unbounded face. */
  readonly unbounded: Cycle[] = [];

  constructor(positions: ReadonlyMap<string, IPoint>, edges: readonly HEdgeInput[]) {
    this.positions = positions;
    this.edges = edges;
    for (const id of [...positions.keys()].sort()) this.stars.set(id, []);
    edges.forEach((e, i) => {
      this.stars.get(e.start)!.push(2 * i);
      this.stars.get(e.end)!.push(2 * i + 1);
    });
    for (const [, star] of this.stars) {
      star.sort((h1, h2) => compareAngle(this.direction(h1), this.direction(h2)));
      star.forEach((h, idx) => (this.starIndex[h] = idx));
    }
    this.traceCycles();
    this.buildFaces();
  }

  origin(h: number): string {
    const e = this.edges[h >> 1]!;
    return h & 1 ? e.end : e.start;
  }

  dest(h: number): string {
    const e = this.edges[h >> 1]!;
    return h & 1 ? e.start : e.end;
  }

  /** The outgoing direction of half-edge h from its origin. */
  direction(h: number): IPoint {
    return sub(this.positions.get(this.dest(h))!, this.positions.get(this.origin(h))!);
  }

  /** The half-edge after h on its face's boundary (6.1). */
  next(h: number): number {
    const twin = h ^ 1;
    const star = this.stars.get(this.dest(h))!;
    const m = this.starIndex[twin]!;
    return star[(m - 1 + star.length) % star.length]!;
  }

  private traceCycles(): void {
    // Components, by union-find over junctions.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      while (parent.get(x) !== r) {
        const n = parent.get(x)!;
        parent.set(x, r);
        x = n;
      }
      return r;
    };
    for (const id of this.stars.keys()) parent.set(id, id);
    for (const e of this.edges) {
      const a = find(e.start);
      const b = find(e.end);
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
    const componentIds = new Map<string, number>();
    const total = this.edges.length * 2;
    for (let h0 = 0; h0 < total; h0++) {
      if (this.cycleOf[h0] !== undefined) continue;
      const hs: number[] = [];
      let h = h0;
      do {
        this.cycleOf[h] = this.cycles.length;
        hs.push(h);
        h = this.next(h);
      } while (h !== h0);
      const vertices = hs.map((x) => this.origin(x));
      const root = find(vertices[0]!);
      if (!componentIds.has(root)) componentIds.set(root, componentIds.size);
      this.cycles.push({
        halfEdges: hs,
        vertices,
        area2: area2(vertices.map((v) => this.positions.get(v)!)),
        component: componentIds.get(root)!,
      });
    }
  }

  private buildFaces(): void {
    const bounded = this.cycles.filter((c) => c.area2 > 0n);
    for (const c of bounded) this.faces.push({ outer: c, inner: [] });
    for (const c of this.cycles) {
      if (c.area2 > 0n) continue;
      // The outside of component c.component: a hole in the innermost bounded face of another
      // component that contains it, or part of the unbounded face's boundary.
      const p = this.positions.get(c.vertices[0]!)!;
      const face = this.innermostFace(p, c.component);
      if (face) face.inner.push(c);
      else this.unbounded.push(c);
    }
  }

  /** The bounded face whose outer cycle most tightly encloses p, ignoring one component's own faces. */
  innermostFace(p: IPoint, excludeComponent = -1): Face | undefined {
    let best: Face | undefined;
    for (const f of this.faces) {
      if (f.outer.component === excludeComponent) continue;
      if (best && f.outer.area2 >= best.outer.area2) continue;
      if (winding(p, f.outer.vertices.map((v) => this.positions.get(v)!)) !== 0) best = f;
    }
    return best;
  }
}
