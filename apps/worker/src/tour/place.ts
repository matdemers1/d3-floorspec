/**
 * Where a tour's panoramas stand, and how they link (FLR-T-14.2). A room's panorama is taken from
 * its visual centre — the point of its floor farthest from its walls (its pole of inaccessibility),
 * moved the least it must be to keep 0.3 m clear of anything standing in the room — at eye height;
 * or from a saved view's eye. Two toured rooms are linked at each door, empty opening and separator
 * (open plan) between them — the door graph `floorspec_describe` reports — and each panorama has a
 * hotspot toward the threshold of the nearest one to each neighbour.
 *
 * Plan in metres, z up, as the scene's rooms, passages and obstacles are (export/gltf/scene.ts).
 */
import { yawPitch, type Point3, type TourHotspot } from '@floorspec/mesh';
import type { Scene, ScenePassage, SceneObstacle, SceneRoom } from '../export/gltf/scene.js';
import { centroid, CLEARANCE, inside } from '../render3d/camera.js';

type Pt = readonly [number, number];

/** The grid the floor is searched on, metres. */
const STEP = 0.1;
/** How far from a wall the eye may stand, at least, once it has had to move: half a stride. */
const OFF_WALL = 0.45;
/** A rug's height, or less: a thing stood on (metres). */
const FLAT = 0.03;
/** How far into each room a passage is probed to find the rooms either side of it, past the wall's face. */
const PROBE = 0.3;

function edgeDistance(p: Pt, ring: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]!;
    const [bx, by] = ring[i]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

const clearOf = (p: Pt, ring: readonly Pt[]): number => (inside(p, ring) ? 0 : edgeDistance(p, ring));

/** Where the eye is in a room: the eye's height above its floor (lower under a low ceiling). */
export function eyeZ(room: SceneRoom, eyeHeight: number): number {
  return room.floor + Math.max(0.3, Math.min(eyeHeight, room.ceiling - room.floor - 0.15));
}

/**
 * A room's visual centre, kept clear of what stands in it: its pole of inaccessibility on a 0.1 m
 * grid (the centroid on a tie, and for a room too small for the grid), moved to the nearest point
 * 0.3 m clear of every piece of furniture or fixture that reaches near the eye — a rug is stood on —
 * and half a stride from the walls; with none, the point farthest from both.
 */
export function visualCentre(room: SceneRoom, obstacles: readonly SceneObstacle[], eye: number): [number, number] {
  const ring = room.outer;
  const c = centroid(ring);
  const here = obstacles.filter((o) => o.level === room.level && o.bottom < eye + 0.25 && o.top > room.floor + FLAT && !(o.decor === true && o.top - o.bottom < FLAT));
  const clearance = (p: Pt): number => here.reduce((m, o) => Math.min(m, clearOf(p, o.footprint)), Infinity);
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const nx = Math.ceil((Math.max(...xs) - x0) / STEP);
  const ny = Math.ceil((Math.max(...ys) - y0) / STEP);
  const grid: { p: [number, number]; edge: number }[] = [];
  for (let j = 1; j < ny; j++)
    for (let i = 1; i < nx; i++) {
      const p: [number, number] = [x0 + i * STEP, y0 + j * STEP];
      if (inside(p, ring)) grid.push({ p, edge: edgeDistance(p, ring) });
    }
  if (grid.length === 0) return [c[0], c[1]];
  const fromC = (p: Pt) => Math.hypot(p[0] - c[0], p[1] - c[1]);
  // The pole: farthest from the walls, within a centimetre; of those, the nearest the centroid.
  const far = Math.max(...grid.map((g) => g.edge));
  const pole = grid.filter((g) => g.edge >= far - 0.01).reduce((a, b) => (fromC(b.p) < fromC(a.p) ? b : a)).p;
  if (clearance(pole) >= CLEARANCE) return pole;
  const fromPole = (p: Pt) => Math.hypot(p[0] - pole[0], p[1] - pole[1]);
  const clear = grid.filter((g) => g.edge >= Math.min(OFF_WALL, far) && clearance(g.p) >= CLEARANCE);
  if (clear.length > 0) return clear.reduce((a, b) => (fromPole(b.p) < fromPole(a.p) ? b : a)).p;
  return grid.reduce((a, b) => (Math.min(b.edge, clearance(b.p)) > Math.min(a.edge, clearance(a.p)) ? b : a)).p;
}

/** The room of a level a point is in. */
function roomAt(rooms: readonly SceneRoom[], level: string, p: Pt): SceneRoom | undefined {
  return rooms.find((r) => r.level === level && inside(p, r.outer));
}

/** A way between two rooms: each side's room, and the passage. */
export interface Link {
  readonly a: string;
  readonly b: string;
  readonly passage: ScenePassage;
}

/** Every passage with a room on each side — two different rooms, both among `rooms` — once each, by its ID. */
export function linksOf(scene: Pick<Scene, 'rooms' | 'passages'>, rooms: ReadonlySet<string> = new Set(scene.rooms.map((r) => r.id))): Link[] {
  const out: Link[] = [];
  for (const passage of scene.passages) {
    const depth = passage.halfThickness + PROBE;
    const side = (s: number): Pt => [passage.mid[0] + s * passage.normal[0] * depth, passage.mid[1] + s * passage.normal[1] * depth];
    const a = roomAt(scene.rooms, passage.level, side(1));
    const b = roomAt(scene.rooms, passage.level, side(-1));
    if (a === undefined || b === undefined || a.id === b.id || !rooms.has(a.id) || !rooms.has(b.id)) continue;
    out.push({ a: a.id, b: b.id, passage });
  }
  return out;
}

/** What a toured room's hotspots point at: one per neighbouring toured room, at the passage nearest the eye, by the neighbour's place in the tour. */
export function hotspotsOf(room: SceneRoom, eye: Point3, links: readonly Link[], tour: readonly SceneRoom[]): TourHotspot[] {
  const best = new Map<string, { link: Link; d: number }>();
  for (const link of links) {
    const other = link.a === room.id ? link.b : link.b === room.id ? link.a : undefined;
    if (other === undefined) continue;
    const d = Math.hypot(link.passage.mid[0] - eye[0], link.passage.mid[1] - eye[1]);
    const had = best.get(other);
    if (had === undefined || d < had.d - 1e-9 || (Math.abs(d - had.d) <= 1e-9 && link.passage.id < had.link.passage.id)) best.set(other, { link, d });
  }
  const order = new Map(tour.map((r, i) => [r.id, i]));
  return [...best.entries()]
    .sort(([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    .map(([to, { link }]) => {
      const target = tour.find((r) => r.id === to)!;
      // The threshold: the passage's middle, on this room's floor.
      const at: Point3 = [link.passage.mid[0], link.passage.mid[1], room.floor];
      const d = yawPitch(eye, at);
      return { to, label: target.name ?? target.id, via: link.passage.id, kind: link.passage.kind, yaw: round(d.yaw), pitch: round(d.pitch), at: [round(at[0], 4), round(at[1], 4), round(at[2], 4)] as Point3 };
    });
}

/** Rounded for the manifest: a tenth of a millidegree, or a tenth of a millimetre. */
export function round(v: number, places = 4): number {
  const k = 10 ** places;
  return Math.round(v * k) / k;
}

/** Which way a room is first looked at, from the eye: toward the far end of the room (its farthest corner). */
export function headingOf(room: SceneRoom, eye: Point3): number {
  const far = room.outer.reduce((f, p) => (Math.hypot(p[0] - eye[0], p[1] - eye[1]) > Math.hypot(f[0] - eye[0], f[1] - eye[1]) ? p : f), room.outer[0]!);
  return round(yawPitch(eye, [far[0], far[1], eye[2]]).yaw);
}
