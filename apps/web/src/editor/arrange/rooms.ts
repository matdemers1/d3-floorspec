import type { LevelView, Point, WallView } from '../model';
import { cross, dist, project, sub } from '../geometry';

const r = (p: Point): [number, number] => [Math.round(p[0]), Math.round(p[1])];

/**
 * The sides of a room, as pieces of walls on their location lines: a room's face is bounded by wall
 * faces (Core 6.3), each on one wall; a side runs along that wall's location line between where it
 * meets the walls of the sides before and after it. A side may be part of a longer wall that runs on
 * past the room — a copy of the room takes only its own side of it. Each piece runs the way its wall
 * does, so its exterior stays on the same side (Core 5.4).
 */
export function wallsOfRoom(level: LevelView, room: string): { wall: WallView; a: Point; b: Point; from: number }[] {
  const face = level.faces.find((f) => f.room === room);
  if (face === undefined) return [];
  const ring = face.outer;
  const n = ring.length;
  const sides: (WallView | undefined)[] = [];
  for (let i = 0; i < n; i++) sides.push(wallOfEdge(level, ring[i] as Point, ring[(i + 1) % n] as Point));
  const out: { wall: WallView; a: Point; b: Point; from: number }[] = [];
  for (let i = 0; i < n; i++) {
    const wall = sides[i];
    if (wall === undefined) continue;
    // Each end where this side's location line meets its neighbour's; along the wall when they run straight on.
    const end = (j: number, corner: Point): Point => {
      const other = sides[(j + n) % n];
      const meet = other === undefined || other === wall ? null : intersect(wall.a, wall.b, other.a, other.b);
      return meet ?? project(corner, wall.a, wall.b).point;
    };
    const p = end(i - 1, ring[i] as Point);
    const q = end(i + 1, ring[(i + 1) % n] as Point);
    const tp = along(wall, p);
    const tq = along(wall, q);
    const [a, b] = tp <= tq ? [p, q] : [q, p];
    out.push({ wall, a: r(a), b: r(b), from: Math.min(tp, tq) });
  }
  return out;
}

/** Signed distance along a wall's location line from its start. */
const along = (w: WallView, p: Point): number => {
  const L = dist(w.a, w.b) || 1;
  return ((p[0] - w.a[0]) * (w.b[0] - w.a[0]) + (p[1] - w.a[1]) * (w.b[1] - w.a[1])) / L;
};

/** The straight wall whose face a face edge lies on: parallel to it, a face's distance off its location line. */
function wallOfEdge(level: LevelView, p: Point, q: Point): WallView | undefined {
  const mid: Point = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const e = sub(q, p);
  const le = Math.hypot(e[0], e[1]);
  if (le === 0) return undefined;
  let best: { w: WallView; d: number } | undefined;
  for (const w of level.walls) {
    if (w.arc !== undefined) continue;
    const d = sub(w.b, w.a);
    const L = Math.hypot(d[0], d[1]);
    if (L === 0 || Math.abs(cross(d, e)) / (L * le) > 1e-6) continue;
    const pr = project(mid, w.a, w.b);
    if (pr.t <= 0 || pr.t >= 1) continue;
    const off = Math.abs(cross(d, sub(mid, w.a))) / L;
    const slack = Math.min(Math.abs(off - w.left), Math.abs(off - w.right));
    if (slack > 2 || (best !== undefined && best.d <= slack)) continue;
    best = { w, d: slack };
  }
  return best?.w;
}

/** Where two lines (through a, b and through c, d) meet, or null when they are parallel. */
function intersect(a: Point, b: Point, c: Point, d: Point): Point | null {
  const r1 = sub(b, a);
  const r2 = sub(d, c);
  const den = cross(r1, r2);
  if (Math.abs(den) < 1e-9 * Math.hypot(r1[0], r1[1]) * Math.hypot(r2[0], r2[1])) return null;
  const t = cross(sub(c, a), r2) / den;
  return [a[0] + r1[0] * t, a[1] + r1[1] * t];
}

/** The junctions at a room's corners, on its walls' location lines: what moves a room's enclosure. */
export function cornersOf(level: LevelView, room: string): string[] {
  const at = new Map(level.junctions.map((j) => [`${String(j.position[0])},${String(j.position[1])}`, j.id]));
  const ids = new Set<string>();
  for (const side of wallsOfRoom(level, room))
    for (const p of [side.a, side.b]) {
      const id = at.get(`${String(p[0])},${String(p[1])}`);
      if (id !== undefined) ids.add(id);
    }
  return [...ids];
}
