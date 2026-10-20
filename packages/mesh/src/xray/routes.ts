/**
 * Routing along walls (FLR-T-14.5): a level's walls as a graph — its junctions the nodes, each wall
 * an edge as long as its location line — and the shortest way along them between two points on
 * walls, found by Dijkstra with ties broken by ID, so the same document always routes the same way.
 * A route runs in the middle of each wall's core (WallFrame.core), so a cable or a pipe is inside the
 * studs, and steps across at a junction from one wall's core to the next.
 */
import { alongOf, dot, planAt, type V2, type WallFrame } from './frames.js';
import type { P3 } from './types.js';

/** A point on a wall: which, and how far along it. */
export interface OnWall {
  readonly wall: string;
  readonly t: number;
}

/** The walls of each level, sorted by ID. */
export function byLevel(frames: ReadonlyMap<string, WallFrame>): Map<string, WallFrame[]> {
  const out = new Map<string, WallFrame[]>();
  for (const f of frames.values()) out.set(f.level, [...(out.get(f.level) ?? []), f]);
  return out;
}

/** The wall of a level nearest a point of the plan (to its location line), and where along it; ties by ID. */
export function nearestWall(walls: readonly WallFrame[] | undefined, p: V2): (OnWall & { distance: number }) | null {
  let best: (OnWall & { distance: number }) | null = null;
  for (const f of walls ?? []) {
    const t = Math.min(f.L, Math.max(0, alongOf(f, p)));
    const q = planAt(f, t, 0);
    const dx = p[0] - q[0];
    const dy = p[1] - q[1];
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (best === null || distance < best.distance) best = { wall: f.id, t, distance };
  }
  return best;
}

/** A point of a wall's core: `t` along it, in the middle of its core. */
export const coreAt = (f: WallFrame, t: number): V2 => planAt(f, t, f.core);

/** The way along a level's walls from one point on a wall to another: the plan polyline and the walls it uses. */
export interface WallPath {
  readonly points: V2[];
  readonly walls: string[];
  readonly length: number;
}

/**
 * The shortest way along the walls of `walls` from `a` to `b`, or null when no walls join them.
 * The polyline runs in each wall's core; at a junction it steps from one core to the next.
 */
export function wallPath(walls: readonly WallFrame[], frames: ReadonlyMap<string, WallFrame>, a: OnWall, b: OnWall): WallPath | null {
  const fa = frames.get(a.wall);
  const fb = frames.get(b.wall);
  if (fa === undefined || fb === undefined) return null;
  if (a.wall === b.wall) return { points: [coreAt(fa, a.t), coreAt(fa, b.t)], walls: [a.wall], length: Math.abs(b.t - a.t) };
  // Dijkstra over the junctions, from the two ends of a's wall.
  const dist = new Map<string, number>();
  const prev = new Map<string, { node: string | null; wall: string }>();
  const edges = new Map<string, { to: string; wall: WallFrame }[]>();
  for (const f of walls) {
    edges.set(f.start, [...(edges.get(f.start) ?? []), { to: f.end, wall: f }]);
    edges.set(f.end, [...(edges.get(f.end) ?? []), { to: f.start, wall: f }]);
  }
  const relax = (node: string, d: number, from: string | null, wall: string) => {
    const was = dist.get(node);
    if (was === undefined || d < was) {
      dist.set(node, d);
      prev.set(node, { node: from, wall });
    }
  };
  relax(fa.start, a.t, null, fa.id);
  relax(fa.end, fa.L - a.t, null, fa.id);
  const done = new Set<string>();
  for (;;) {
    let next: string | null = null;
    for (const [node, d] of dist) {
      if (done.has(node)) continue;
      if (next === null || d < dist.get(next)! || (d === dist.get(next)! && node < next)) next = node;
    }
    if (next === null) break;
    done.add(next);
    const d = dist.get(next)!;
    for (const e of edges.get(next) ?? []) if (!done.has(e.to)) relax(e.to, d + e.wall.L, next, e.wall.id);
  }
  const viaStart = dist.get(fb.start);
  const viaEnd = dist.get(fb.end);
  const options = [
    ...(viaStart === undefined ? [] : [{ node: fb.start, d: viaStart + b.t }]),
    ...(viaEnd === undefined ? [] : [{ node: fb.end, d: viaEnd + fb.L - b.t }]),
  ].sort((p, q) => p.d - q.d || (p.node < q.node ? -1 : 1));
  const best = options[0];
  if (best === undefined) return null;
  // Back from b's wall to a's: each step a wall and the junction it was entered from.
  const steps: { node: string; wall: string }[] = [];
  for (let node: string | null = best.node; node !== null; ) {
    const p: { node: string | null; wall: string } = prev.get(node)!;
    steps.unshift({ node, wall: p.wall });
    node = p.node;
  }
  const points: V2[] = [coreAt(fa, a.t)];
  const used: string[] = [];
  let at = fa;
  for (const s of steps) {
    const f = frames.get(s.wall)!;
    // Along the wall it is on to the junction, then onto the next wall at that junction.
    const end = f.start === s.node ? 0 : f.L;
    if (f.id !== at.id) points.push(coreAt(f, f.start === s.node ? f.L : 0));
    points.push(coreAt(f, end));
    used.push(f.id);
    at = f;
  }
  points.push(coreAt(fb, fb.start === best.node ? 0 : fb.L));
  points.push(coreAt(fb, b.t));
  used.push(fb.id);
  return { points: simplify(points), walls: [...new Set(used)].sort(), length: best.d };
}

/** Drop repeated points and the middle of three in a line. */
export function simplify<T extends readonly number[]>(points: readonly T[]): T[] {
  const same = (p: T, q: T) => p.every((v, i) => v === q[i]);
  const out: T[] = [];
  for (const p of points) if (out.length === 0 || !same(out[out.length - 1]!, p)) out.push(p);
  const kept: T[] = [];
  for (let i = 0; i < out.length; i++) {
    const p = kept[kept.length - 1];
    const q = out[i]!;
    const r = out[i + 1];
    if (p !== undefined && r !== undefined && collinear(p, q, r)) continue;
    kept.push(q);
  }
  return kept;
}

/** Whether q is on the segment from p to r, pointing on: the same direction both sides. */
function collinear(p: readonly number[], q: readonly number[], r: readonly number[]): boolean {
  const a = p.map((v, i) => q[i]! - v);
  const b = q.map((v, i) => r[i]! - v);
  const la = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const lb = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  if (la === 0 || lb === 0) return true;
  const c = a.reduce((s, v, i) => s + v * b[i]!, 0) / (la * lb);
  return c > 1 - 1e-12;
}

/** Lift a plan polyline to a height. */
export const atHeight = (points: readonly V2[], z: number): P3[] => points.map((p) => [p[0], p[1], z] as const);

/**
 * From one point to another on the plan by two straight legs, east–west then north–south — a run
 * under a floor or over a ceiling, square to the house's axes.
 */
export function squareRoute(a: V2, b: V2, z: number): P3[] {
  return simplify<P3>([
    [a[0], a[1], z],
    [b[0], a[1], z],
    [b[0], b[1], z],
  ]);
}

/** A wall's point of the plan, `t` along it, and the plan distance from a point to it. */
export function distanceTo(f: WallFrame, p: V2): number {
  const t = Math.min(f.L, Math.max(0, alongOf(f, p)));
  const q = planAt(f, t, 0);
  const d: V2 = [p[0] - q[0], p[1] - q[1]];
  return Math.sqrt(dot(d, d));
}
