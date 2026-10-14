/**
 * The outline of a level's walls as drafting reads it (FLR-T-9.3, moved here for FLR-T-18.11 so the
 * editor, render2d and the worker's drawings share it): the union of the wall and junction pieces —
 * their shared edges cancel exactly, the pieces' vertices being the engine's rounded integers,
 * compared with BigInt — and, from it, the building's outer boundary loops.
 */
import type { Pt } from './scene.js';

export type XY = readonly [number, number];

/** A directed outline edge with the wall material on its left (counter-clockwise pieces). */
export interface OutlineEdge {
  readonly a: Pt;
  readonly b: Pt;
  readonly exterior: boolean;
}

const key = (p: XY): string => `${p[0]},${p[1]}`;

function signedArea2(ring: readonly XY[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  return s;
}

/** A ring turned counter-clockwise. */
export const ccw = (ring: readonly Pt[]): readonly Pt[] => (signedArea2(ring) < 0 ? [...ring].reverse() : ring);

/** Is (x, y) inside the rings, by the even–odd rule? */
export function insideRings(x: number, y: number, rings: readonly (readonly XY[])[]): boolean {
  let inside = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i]!;
      const [xj, yj] = r[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}

/**
 * The boundary of a union of counter-clockwise integer polygons that meet edge to edge: every edge
 * is split at any piece vertex lying on it (exactly, in BigInt), and an edge whose reverse is also
 * present is interior and cancels. What is left is the outline, material on its left.
 */
export function unionOutline(pieces: readonly { readonly ring: readonly Pt[]; readonly exterior: boolean }[]): OutlineEdge[] {
  const vertices = new Map<string, Pt>();
  for (const p of pieces) for (const v of p.ring) vertices.set(key(v), v);
  const verts = [...vertices.values()];
  const edges = new Map<string, OutlineEdge>();
  const push = (a: Pt, b: Pt, exterior: boolean): void => {
    if (a[0] === b[0] && a[1] === b[1]) return;
    const k = `${key(a)}>${key(b)}`;
    const r = `${key(b)}>${key(a)}`;
    if (edges.has(r)) {
      // An edge two pieces share: interior. The exterior flag of a cancelled edge is irrelevant.
      edges.delete(r);
      return;
    }
    const prior = edges.get(k);
    edges.set(k, { a, b, exterior: exterior || (prior?.exterior ?? false) });
  };
  for (const p of pieces) {
    const ring = p.ring;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const ax = BigInt(a[0]);
      const ay = BigInt(a[1]);
      const dx = BigInt(b[0]) - ax;
      const dy = BigInt(b[1]) - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0n) continue;
      const on: { t: bigint; v: Pt }[] = [];
      for (const v of verts) {
        const vx = BigInt(v[0]) - ax;
        const vy = BigInt(v[1]) - ay;
        if (vx * dy - vy * dx !== 0n) continue;
        const t = vx * dx + vy * dy;
        if (t > 0n && t < len2) on.push({ t, v });
      }
      on.sort((p1, p2) => (p1.t < p2.t ? -1 : p1.t > p2.t ? 1 : 0));
      let from = a;
      for (const { v } of on) {
        push(from, v, p.exterior);
        from = v;
      }
      push(from, b, p.exterior);
    }
  }
  return [...edges.values()];
}

/**
 * The outline with collinear runs joined: a straight face split by junctions along it becomes one
 * edge. Exact (BigInt cross products on the engine's integers).
 */
export function mergeCollinear(outline: readonly OutlineEdge[]): OutlineEdge[] {
  const from = new Map<string, OutlineEdge>();
  const into = new Map<string, OutlineEdge>();
  for (const e of outline) {
    from.set(key(e.a), e);
    into.set(key(e.b), e);
  }
  const straight = (p: OutlineEdge, q: OutlineEdge): boolean =>
    (BigInt(p.b[0]) - BigInt(p.a[0])) * (BigInt(q.b[1]) - BigInt(q.a[1])) - (BigInt(p.b[1]) - BigInt(p.a[1])) * (BigInt(q.b[0]) - BigInt(q.a[0])) === 0n &&
    (p.b[0] - p.a[0]) * (q.b[0] - q.a[0]) + (p.b[1] - p.a[1]) * (q.b[1] - q.a[1]) > 0;
  const out: OutlineEdge[] = [];
  const used = new Set<OutlineEdge>();
  for (const e of outline) {
    if (used.has(e)) continue;
    const prev = into.get(key(e.a));
    if (prev !== undefined && prev !== e && straight(prev, e) && !used.has(prev)) continue; // not a run's first edge
    let last = e;
    let exterior = e.exterior;
    used.add(e);
    for (;;) {
      const next = from.get(key(last.b));
      if (next === undefined || used.has(next) || !straight(last, next)) break;
      used.add(next);
      exterior ||= next.exterior;
      last = next;
    }
    out.push({ a: e.a, b: last.b, exterior });
  }
  // A loop that is one straight run all the way round cannot happen; anything left over is kept.
  for (const e of outline) if (!used.has(e)) out.push(e);
  return out;
}

/**
 * The outline's closed loops, each a ring of vertices in the edges' direction (material on the
 * left). A loop with positive area is an outer boundary of the walls — the building's outside
 * faces; one with negative area runs round a room. Where two loops touch at a vertex, each edge
 * continues by the sharpest left turn, so the loops stay simple.
 */
export function outlineLoops(outline: readonly OutlineEdge[]): Pt[][] {
  const from = new Map<string, OutlineEdge[]>();
  for (const e of outline) from.set(key(e.a), [...(from.get(key(e.a)) ?? []), e]);
  const used = new Set<OutlineEdge>();
  const loops: Pt[][] = [];
  for (const start of outline) {
    if (used.has(start)) continue;
    const ring: Pt[] = [];
    let e: OutlineEdge | undefined = start;
    while (e !== undefined && !used.has(e)) {
      used.add(e);
      ring.push(e.a);
      const options: OutlineEdge[] = (from.get(key(e.b)) ?? []).filter((f) => !used.has(f));
      if (options.length <= 1) e = options[0];
      else {
        const cur: OutlineEdge = e;
        const dx = cur.b[0] - cur.a[0];
        const dy = cur.b[1] - cur.a[1];
        // The leftmost turn: the largest angle of turning counter-clockwise.
        e = options.reduce((best, f) => (turn(dx, dy, f) > turn(dx, dy, best) ? f : best));
      }
    }
    if (ring.length >= 3) loops.push(ring);
  }
  return loops;
}

function turn(dx: number, dy: number, f: OutlineEdge): number {
  const fx = f.b[0] - f.a[0];
  const fy = f.b[1] - f.a[1];
  return Math.atan2(dx * fy - dy * fx, dx * fx + dy * fy);
}

/** The outer boundary loops of an outline: its counter-clockwise loops, largest first. */
export function outerLoops(outline: readonly OutlineEdge[]): Pt[][] {
  return outlineLoops(outline)
    .filter((r) => signedArea2(r) > 0)
    .sort((a, b) => signedArea2(b) - signedArea2(a));
}
