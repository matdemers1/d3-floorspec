/**
 * Closures: the corner a separator leaves open between two walls (FLR-T-12.20).
 *
 * A separator has no thickness — its face offsets are zero (5.4) — so at a junction where it sits
 * between two walls, the corner sequences of 5.6 stop each wall's face at the separator's line
 * through the junction. The walls' faces on that side never meet: the square of wall thickness
 * where they would have met — the outside of an L whose inside a separator continues, or a sliver
 * of one wall where a separator leaves at a shallow angle — is covered by no wall and no fill, and
 * shows in 3D as a notch.
 *
 * The engine's derived values are normative and stay as they are; the mesh closes the notch. For
 * each wall end at a junction followed (counter-clockwise) by one or more separators and then
 * another wall's end, the closure is the polygon from the first wall's outgoing-left face end,
 * along the fill's boundary (the corners the separators made) to the second wall's outgoing-right
 * face end, and on to the corner the two faces would have made without the separators: the
 * intersection of the two face lines, computed exactly in rationals from the derived (integer) face
 * ends and the walls' directions, and rounded once (2.2). Walls whose faces are parallel there make
 * no corner and leave no notch. A closure spans its two walls' least base to their greatest top.
 *
 * Not closed: a butt join (5.8), whose through walls already run past the junction, and a junction
 * where an arc wall or an arc separator meets (21), whose face directions there are the arc's.
 */
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import { MeshBuilder } from './builder.js';
import { Rat, type IPoint } from './exact.js';
import type { Kernel } from './kernel.js';
import { get } from './own.js';
import type { RawPart } from './part.js';
import { flatSlabs, solidTop } from './walls.js';

type Point = readonly [number, number];

interface End {
  /** The wall's ID, or undefined for a separator. */
  wall?: string;
  /** The outgoing direction, integers. */
  d: IPoint;
  /** A wall's outgoing-left and outgoing-right face ends at the junction (5.7), rounded as derived. */
  left?: Point;
  right?: Point;
}

const I = (p: Point): IPoint => [BigInt(p[0]), BigInt(p[1])];
const cross = (a: IPoint, b: IPoint): bigint => a[0] * b[1] - a[1] * b[0];
const same = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];

/** 0 for a direction in the upper half-plane (or along +x), 1 for the lower: the first key of a counter-clockwise sort. */
const half = (d: IPoint): number => (d[1] > 0n || (d[1] === 0n && d[0] > 0n) ? 0 : 1);
const byAngle = (a: End, b: End): number => half(a.d) - half(b.d) || (cross(a.d, b.d) > 0n ? -1 : cross(a.d, b.d) < 0n ? 1 : 0);

/** Twice the signed area of an integer ring. */
function area2(ring: readonly Point[]): bigint {
  let s = 0n;
  for (let i = 0; i < ring.length; i++) {
    const p = I(ring[i]!);
    const q = I(ring[(i + 1) % ring.length]!);
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s;
}

/** Orientation of r about the segment p → q: positive to the left. */
const orient = (p: IPoint, q: IPoint, r: IPoint): bigint => cross([q[0] - p[0], q[1] - p[1]], [r[0] - p[0], r[1] - p[1]]);

/** Do two closed segments share a point? */
function meets(a: IPoint, b: IPoint, c: IPoint, d: IPoint): boolean {
  const s = (x: bigint): number => (x > 0n ? 1 : x < 0n ? -1 : 0);
  const [o1, o2, o3, o4] = [s(orient(a, b, c)), s(orient(a, b, d)), s(orient(c, d, a)), s(orient(c, d, b))];
  if (o1 !== o2 && o3 !== o4) return true;
  const on = (p: IPoint, q: IPoint, r: IPoint): boolean =>
    (r[0] >= (p[0] < q[0] ? p[0] : q[0]) && r[0] <= (p[0] > q[0] ? p[0] : q[0]) && r[1] >= (p[1] < q[1] ? p[1] : q[1]) && r[1] <= (p[1] > q[1] ? p[1] : q[1]));
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}

/** A ring whose edges meet only where neighbours share their vertex. */
function simple(ring: readonly Point[]): boolean {
  const n = ring.length;
  const P = ring.map(I);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (meets(P[i]!, P[(i + 1) % n]!, P[j]!, P[(j + 1) % n]!)) return false;
    }
  return true;
}

/** Consecutive repeats removed, the first counting as following the last. */
function dedupe(ring: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of ring) if (!out.length || !same(out[out.length - 1]!, p)) out.push(p);
  while (out.length > 1 && same(out[0]!, out[out.length - 1]!)) out.pop();
  return out;
}

/** Where the line through p along d meets the line through q along e (not parallel), rounded once. */
function corner(p: Point, d: IPoint, q: Point, e: IPoint): Point {
  const P = I(p);
  const Q = I(q);
  const t = new Rat(cross([Q[0] - P[0], Q[1] - P[1]], e), cross(d, e));
  const x = new Rat(P[0]).add(t.mul(new Rat(d[0])));
  const y = new Rat(P[1]).add(t.mul(new Rat(d[1])));
  return [Number(x.round()), Number(y.round())];
}

/**
 * Every closure ring at every junction, counter-clockwise, with the two walls it lies between —
 * exported for the property tests, which check each against the face lines independently.
 */
export function closureRings(doc: FloorspecDocument, derived: Derived): { junction: string; walls: [string, string]; ring: Point[] }[] {
  const out: { junction: string; walls: [string, string]; ring: Point[] }[] = [];
  const touching = new Map<string, End[]>();
  const add = (j: string, e: End): void => {
    touching.set(j, [...(touching.get(j) ?? []), e]);
  };
  const arcAt = new Set<string>();
  const separated = new Set<string>();
  for (const [, s] of Object.entries(doc.separators ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (s === undefined) continue;
    const S = get(doc.junctions, s.start)?.position;
    const E = get(doc.junctions, s.end)?.position;
    if (S === undefined || E === undefined) continue;
    if (s.arc?.sagitta) arcAt.add(s.start).add(s.end);
    separated.add(s.start).add(s.end);
    add(s.start, { d: [BigInt(E[0] - S[0]), BigInt(E[1] - S[1])] });
    add(s.end, { d: [BigInt(S[0] - E[0]), BigInt(S[1] - E[1])] });
  }
  if (!separated.size) return out;
  for (const id of Object.keys(derived.walls).sort()) {
    const w = get(doc.walls, id)!;
    if (!separated.has(w.start) && !separated.has(w.end)) continue;
    const dw = derived.walls[id]!;
    if (w.arc?.sagitta) arcAt.add(w.start).add(w.end);
    const S = get(doc.junctions, w.start)!.position;
    const E = get(doc.junctions, w.end)!.position;
    add(w.start, { wall: id, d: [BigInt(E[0] - S[0]), BigInt(E[1] - S[1])], left: dw.startLeft, right: dw.startRight });
    add(w.end, { wall: id, d: [BigInt(S[0] - E[0]), BigInt(S[1] - E[1])], left: dw.endRight, right: dw.endLeft });
  }
  for (const jid of [...separated].sort()) {
    const j = get(doc.junctions, jid);
    if (j === undefined || j.join?.kind === 'butt' || arcAt.has(jid)) continue;
    const ends = (touching.get(jid) ?? []).sort(byAngle);
    const k = ends.length;
    if (ends.filter((e) => e.wall !== undefined).length < 2) continue;
    const fill = derived.junctionFills[jid];
    for (let i = 0; i < k; i++) {
      const ei = ends[i]!;
      if (ei.wall === undefined) continue;
      let n = 1;
      while (n < k && ends[(i + n) % k]!.wall === undefined) n++;
      const ej = ends[(i + n) % k]!;
      // Nothing between them but each other, or the same wall back again: no separator, no notch.
      if (n === 1 || ej === ei || ej.wall === undefined || ej.wall === ei.wall) continue;
      // Faces parallel there (walls running straight through) meet in no corner, and leave none open.
      if (cross(ei.d, ej.d) === 0n) continue;
      const L = ei.left!;
      const R = ej.right!;
      // From the first wall's face end along the fill's boundary — the corners the separators made — to the second's.
      let path: Point[] = [L, R];
      if (fill !== undefined) {
        const a = fill.findIndex((p) => same(p, L));
        if (a >= 0) {
          const walk: Point[] = [];
          for (let s = 0; s < fill.length; s++) {
            const p = fill[(a + s) % fill.length]!;
            walk.push(p);
            if (same(p, R)) {
              path = walk;
              break;
            }
          }
        }
      }
      const X = corner(L, ei.d, R, ej.d);
      // Walking the fill's way round and then out to the corner goes clockwise round the notch.
      const ring = dedupe([...path, X]);
      if (ring.length < 3 || area2(ring) >= 0n) continue;
      const ccw = [...ring].reverse();
      if (!simple(ccw)) continue;
      out.push({ junction: jid, walls: [ei.wall, ej.wall], ring: ccw });
    }
  }
  return out;
}

export function closureParts(kernel: Kernel, doc: FloorspecDocument, derived: Derived, want: (kind: RawPart['kind']) => boolean): RawPart[] {
  if (!want('junctionFill')) return [];
  const slabs = flatSlabs(doc, derived);
  const out: RawPart[] = [];
  for (const c of closureRings(doc, derived)) {
    const level = get(doc.junctions, c.junction)!.level;
    const ws = c.walls.map((w) => derived.walls[w]!);
    const base = Math.min(...ws.map((w) => w.baseElevation));
    const top = solidTop(slabs.get(level), c.ring, base, Math.max(...ws.map((w) => w.topElevation)));
    if (top <= base) continue;
    const b = new MeshBuilder(kernel);
    b.prism([c.ring], base, top);
    out.push({ kind: 'junctionFill', id: c.junction, level, closed: true, piece: `closure:${c.walls[0]}`, exact: b });
  }
  return out;
}
