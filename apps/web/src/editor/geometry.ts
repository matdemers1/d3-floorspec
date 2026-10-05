import type { FaceView, LevelView, Point, Ring } from './model';

/**
 * Plane helpers for the editor's interaction: hit-testing, projection and snapping all ask "where
 * is the pointer", which is a question in floats. None of these values is ever written to the
 * model as computed here — what goes into an op is an integer (rounded once) or a typed length the
 * applier resolves itself (Ops 3).
 */

export const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
export const scale = (a: Point, k: number): Point => [a[0] * k, a[1] * k];
export const dot = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Point, b: Point): number => a[0] * b[1] - a[1] * b[0];
export const len = (a: Point): number => Math.hypot(a[0], a[1]);
export const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const samePoint = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];
export const roundPoint = (p: Point): Point => [Math.round(p[0]), Math.round(p[1])];

/** The parameter t ∈ [0, 1] of the point on segment ab nearest p, and that point. */
export function project(p: Point, a: Point, b: Point): { t: number; point: Point; distance: number } {
  const d = sub(b, a);
  const l2 = dot(d, d);
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), d) / l2));
  const point: Point = [a[0] + d[0] * t, a[1] + d[1] * t];
  return { t, point, distance: dist(p, point) };
}

/** Even–odd point in ring. Points on the boundary count as either; callers give a tolerance. */
export function inRing(p: Point, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point;
    const b = ring[j] as Point;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
export function inFace(p: Point, face: { outer: Ring; holes: readonly Ring[] }): boolean {
  return inRing(p, face.outer) && !face.holes.some((h) => inRing(p, h));
}

/** The bounded face of a level containing p, if any — anchored or not. */
export function faceAt(level: LevelView, p: Point): FaceView | undefined {
  // Faces do not overlap; but when one is a hole of another, the smaller one is the one you see.
  return level.faces.filter((f) => inFace(p, f)).sort((a, b) => (a.area2 < b.area2 ? -1 : 1))[0];
}

/** Signed area of a ring (positive counter-clockwise in a y-up plane). */
export function signedArea(ring: Ring): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j] as Point;
    const b = ring[i] as Point;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** The centroid of a polygon's area, for placing a label; falls back to the vertex mean. */
export function centroid(ring: Ring): Point {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p = ring[j] as Point;
    const q = ring[i] as Point;
    const f = p[0] * q[1] - q[0] * p[1];
    a += f;
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  if (a === 0) {
    const n = ring.length || 1;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** The unit left normal of a direction (Core 5.5: n points left of the outgoing direction). */
export function leftNormal(a: Point, b: Point): Point {
  const d = sub(b, a);
  const l = len(d) || 1;
  return [-d[1] / l, d[0] / l];
}

/**
 * Which rooms are beside a wall: sample a point just beyond each face at the wall's midpoint and
 * ask which face holds it. `left` is the wall's exterior side (Core 5.4).
 */
export function roomsBeside(level: LevelView, wallId: string): { left: string | null; right: string | null } {
  const wall = level.walls.find((w) => w.id === wallId);
  const sep = wall === undefined ? level.separators.find((s) => s.id === wallId) : undefined;
  const a = wall?.a ?? sep?.a;
  const b = wall?.b ?? sep?.b;
  if (a === undefined || b === undefined) return { left: null, right: null };
  const n = leftNormal(a, b);
  const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // A little past each face: a sixty-fourth of an inch, or more for a thick wall.
  const eps = 508;
  const leftAt = add(mid, scale(n, (wall?.left ?? 0) + eps));
  const rightAt = add(mid, scale(n, -((wall?.right ?? 0) + eps)));
  return { left: faceAt(level, leftAt)?.room ?? null, right: faceAt(level, rightAt)?.room ?? null };
}

/** Distance from p to a closed polygon's boundary, or 0 when p is inside it. */
export function distanceToRing(p: Point, ring: Ring): number {
  if (inRing(p, ring)) return 0;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) best = Math.min(best, project(p, ring[j] as Point, ring[i] as Point).distance);
  return best;
}

export type Hit =
  | { kind: 'junction'; id: string }
  | { kind: 'opening'; id: string }
  | { kind: 'wall'; id: string }
  | { kind: 'separator'; id: string }
  | { kind: 'slab'; id: string }
  | { kind: 'room'; id: string };

/**
 * What is under the pointer, most specific first: a junction handle, an opening, a wall (its body
 * or within `tol` of it), a separator, then the room whose face holds the point. `tol` is in base
 * units — the caller turns pixels into it, so a touch target can be larger than a mouse's.
 */
export function hitTest(level: LevelView, p: Point, tol: number, options: { junctions?: boolean } = {}): Hit | null {
  if (options.junctions !== false) {
    let best: { id: string; d: number } | null = null;
    for (const j of level.junctions) {
      const d = dist(p, j.position);
      if (d <= tol && (best === null || d < best.d)) best = { id: j.id, d };
    }
    if (best !== null) return { kind: 'junction', id: best.id };
  }
  for (const o of level.openings) {
    const wall = level.walls.find((w) => w.id === o.wall);
    const half = (wall?.thickness ?? 0) / 2 + tol;
    if (project(p, o.start, o.end).distance <= half && dist(o.start, o.end) > 0) {
      const t = project(p, o.start, o.end).t;
      if (t > 0 && t < 1) return { kind: 'opening', id: o.id };
    }
  }
  let wallBest: { id: string; d: number } | null = null;
  for (const w of level.walls) {
    const d = distanceToRing(p, w.ring);
    if (d <= tol && (wallBest === null || d < wallBest.d)) wallBest = { id: w.id, d };
  }
  if (wallBest !== null) return { kind: 'wall', id: wallBest.id };
  for (const s of level.separators) if (project(p, s.a, s.b).distance <= tol) return { kind: 'separator', id: s.id };
  const face = faceAt(level, p);
  if (face?.room !== undefined && face.room !== null) return { kind: 'room', id: face.room };
  // A slab (Core 6.7) under the pointer, outside every room: the last thing a click finds.
  for (const s of level.slabs) if (insideRing(p, s.outline)) return { kind: 'slab', id: s.id };
  return null;
}

/** Every element whose geometry lies in a rectangle — for a marquee or a "fit to selection". */
export function boundsOf(points: readonly Point[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * A point well inside a face, rounded to base units, for a room's anchor when nobody pointed at
 * one (the keyboard's "name a room"): the centroid when it is inside, else the middle of the widest
 * span of a horizontal line through the face.
 */
export function interiorPoint(face: { outer: Ring; holes: readonly Ring[] }): Point | null {
  const c = roundPoint(centroid(face.outer));
  if (inFace(c, face)) return c;
  const ys = face.outer.map((p) => p[1]);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  for (const t of [0.5, 0.25, 0.75, 0.375, 0.625, 0.125, 0.875]) {
    const y = minY + (maxY - minY) * t;
    const xs: number[] = [];
    for (const ring of [face.outer, ...face.holes]) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j] as Point;
        const b = ring[i] as Point;
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    xs.sort((m, n) => m - n);
    let best: Point | null = null;
    let width = 0;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = (xs[i + 1] as number) - (xs[i] as number);
      if (w > width) {
        width = w;
        best = [((xs[i] as number) + (xs[i + 1] as number)) / 2, y];
      }
    }
    if (best !== null) {
      const p = roundPoint(best);
      if (inFace(p, face)) return p;
    }
  }
  return null;
}

/** Is a point inside a ring (even-odd), in floating point — for picking, never for geometry. */
export function insideRing(p: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point;
    const b = ring[j] as Point;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
