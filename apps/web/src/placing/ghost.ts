import type { LevelView, Point, Ring, RoomView, WallView } from '../editor/model';
import { add, dist, dot, faceAt, leftNormal, project, scale, signedArea, sub } from '../editor/geometry';
import { alignOpening, snapOpeningOn, snapPoint, unitAt, type SnapSettings } from '../editor/snap';
import { angleOf, hoverFor, BACK_GAP } from '../editor/systems/placement';
import type { HostRef } from '../editor/systems/ops';
import { footprintAt, overlaps } from '../furniture/placement';
import type { Entry } from './catalog';

/**
 * The ghost (FLR-T-18.7): where an entry of the library would go under the pointer, worked out from
 * the level as the engine derived it, and the host reference that puts it there — the applier
 * resolves it exactly (Ops 0.2 4.10); the editor never stores a position it computed.
 *
 * It snaps, in order:
 *  - an item that backs onto a wall (a sofa, a fridge, a bed) to the nearest wall face of the room
 *    it is in, facing into the room — along that face to its middle, into either corner, beside
 *    another item already against it, else to the grid measured from the corner;
 *  - an item that stands free (a table, a rug, a plant) flush to the room's faces and to other
 *    items' sides, lined up with their sides and middles — each axis of its own frame by itself, so
 *    two flush faces make a corner — else to the shared snap engine's grid and junction alignment;
 *  - a wall mount, a ceiling or floor device, as the device tool places it (systems/placement.ts);
 *  - a door or a window onto the wall under the pointer, centred when near the middle (snap.ts).
 *
 * With each comes what a person needs to see while placing: the footprint and its envelopes, the
 * guides it snapped to, the clear distances to the faces around it, and a sentence saying where it is.
 */

export interface GhostOptions {
  /** How near counts, base units (the pointer's tolerance). */
  tol: number;
  grid: number;
  /** Turned by hand, degrees counter-clockwise; with `turned`, a backed item keeps it rather than facing the room. */
  rotation: number;
  turned: boolean;
  /** ⌥: no snapping but the grid. */
  free?: boolean;
  /**
   * Which snaps are on — the snap menu's toggles (FLR-T-18.9's SnapSettings, read structurally):
   * all off, it snaps to nothing but the grid; walls off, nothing backs onto a wall; items off,
   * nothing lines up with an item; the grid off, nothing rounds to it. Absent, all on.
   */
  snaps?: SnapSettings | undefined;
  /** The room names, for the sentence. */
  roomName?: (id: string) => string;
  wallName?: (id: string) => string;
}

export interface Gap {
  from: Point;
  to: Point;
  length: number;
}

export interface OpeningAim {
  wall: string;
  offset: number;
  centered: boolean;
  width: number;
  side: 'left' | 'right';
  nearer: 'start' | 'end';
  fits: boolean;
}

export interface Ghost {
  /** The raw point the ghost is for (the pointer, or a keyboard's), so a turn recomputes it in place. */
  at: Point;
  /** The frame's origin in plan and the way it faces (a unit vector). */
  origin: Point;
  facing: Point;
  footprint: Ring;
  envelopes: { name: string; ring: Ring }[];
  host: HostRef | null;
  opening: OpeningAim | null;
  guides: [Point, Point][];
  gaps: Gap[];
  /** "Against the south wall · centred on the Den". */
  label: string;
  /** Its footprint or an envelope runs into something, or it is not where it can stand. */
  blocked: boolean;
  /** Why it cannot be placed here; undefined when it can. */
  problem?: string;
}

const MM = 1_280;
/** How far from a face the pointer may be for a backed item to go against it, beyond half its depth: 600 mm. */
const BACK_REACH = 600 * MM;
/** How far apart two items may be along a face and still line up: 1.5 m. */
const NEAR = 1_500 * MM;

const round = (p: Point): [number, number] => [Math.round(p[0]), Math.round(p[1])];
const perp = (u: Point): Point => [-u[1], u[0]];

/** The direction a face looks from the room's side, as a person names a wall: the wall to the south. */
export function compassOf(towardsWall: Point): string | null {
  const deg = ((Math.atan2(towardsWall[1], towardsWall[0]) * 180) / Math.PI + 360) % 360;
  const names = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  const i = Math.round(deg / 45) % 8;
  if (Math.abs(deg - i * 45) > 10 && Math.abs(deg - 360 - i * 45) > 10) return null;
  return names[i] ?? null;
}

/** A room's faces as edges with their inward normals: its outer ring, and each hole's. */
function facesOf(room: { outer: Ring; holes: readonly Ring[] }): { a: Point; b: Point; n: Point; L: number }[] {
  const out: { a: Point; b: Point; n: Point; L: number }[] = [];
  const add1 = (ring: Ring, inwardLeft: boolean) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as Point;
      const b = ring[(i + 1) % ring.length] as Point;
      const L = dist(a, b);
      if (L === 0) continue;
      const left = leftNormal(a, b);
      out.push({ a, b, L, n: inwardLeft ? left : scale(left, -1) });
    }
  };
  // The room is on the left of a counter-clockwise outer ring, and outside each hole.
  add1(room.outer, signedArea(room.outer) > 0);
  for (const h of room.holes) add1(h, signedArea(h) < 0);
  return out;
}

/** Where a ray from `p` along `u` first meets a ring, at a distance > 0. */
function rayHit(p: Point, u: Point, rings: readonly Ring[]): number | null {
  let best: number | null = null;
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as Point;
      const b = ring[(i + 1) % ring.length] as Point;
      const d = sub(b, a);
      const denom = u[0] * d[1] - u[1] * d[0];
      if (Math.abs(denom) < 1e-9) continue;
      const w = sub(a, p);
      const t = (w[0] * d[1] - w[1] * d[0]) / denom;
      const s = (w[0] * u[1] - w[1] * u[0]) / denom;
      if (t > 1 && s >= -1e-9 && s <= 1 + 1e-9 && (best === null || t < best)) best = t;
    }
  return best;
}

/** The other footprints on the level an item lines up with and keeps clear of. */
function others(level: LevelView): { id: string; ring: Ring; clearances: Ring[] }[] {
  return level.devices.map((d) => ({ id: d.id, ring: d.footprint, clearances: d.clearances.map((c) => c.ring) }));
}

const roomOf = (level: LevelView, p: Point): RoomView | undefined => {
  const id = faceAt(level, p)?.room ?? null;
  return id === null ? undefined : level.rooms.find((r) => r.id === id);
};

/** Whether every corner of a ring is in the room (nudged 1 mm towards its middle). */
function within(room: { outer: Ring; holes: readonly Ring[] }, ring: Ring, level: LevelView): boolean {
  const c: Point = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  return ring.every((p) => {
    const d = dist(c, p) || 1;
    const q: Point = [p[0] + ((c[0] - p[0]) / d) * MM, p[1] + ((c[1] - p[1]) / d) * MM];
    const f = faceAt(level, q);
    return f !== undefined && f.outer === room.outer;
  });
}

function finish(entry: Entry, level: LevelView, g: Omit<Ghost, 'envelopes' | 'blocked'>, room: RoomView | undefined): Ghost {
  const envelopes = entry.clearances.map((e) => ({ name: e.name, ring: footprintAt(g.origin, g.facing, e) }));
  const mine = [g.footprint, ...envelopes.map((e) => e.ring)];
  const theirs = others(level).flatMap((o) => [o.ring, ...o.clearances]);
  const clash = mine.some((r) => theirs.some((x) => overlaps(r, x)));
  const out = g.host?.mode === 'surface' && room !== undefined && !within(room, g.footprint, level);
  return { ...g, envelopes, blocked: clash || out };
}

// ─── Backed onto a wall ────────────────────────────────────────────────────────────────────────

function backed(level: LevelView, entry: Entry, p: Point, room: RoomView, o: GhostOptions): Ghost | null {
  const b = entry.box;
  const depth = b.max[0] - b.min[0];
  const width = b.max[1] - b.min[1];
  const half = width / 2;
  const qc = (b.min[1] + b.max[1]) / 2;
  let face: { a: Point; b: Point; n: Point; L: number; s: number; d: number } | null = null;
  for (const f of facesOf(room)) {
    if (f.L < width) continue;
    const pr = project(p, f.a, f.b);
    if (pr.t < 0 || pr.t > 1) continue;
    if (dot(sub(p, f.a), f.n) < -MM) continue;
    if (pr.distance > depth / 2 + BACK_REACH) continue;
    if (face === null || pr.distance < face.d) face = { ...f, s: pr.t * f.L, d: pr.distance };
  }
  if (face === null) return null;
  const t = scale(sub(face.b, face.a), 1 / face.L);
  const n = face.n;
  const v = perp(n);
  // Where along the face its middle goes: the face's middle, a corner, beside an item, else the grid from the corner.
  let s: number;
  let how = 'in';
  const guides: [Point, Point][] = [];
  const at = (k: number, off = 0): Point => add(add(face.a, scale(t, k)), scale(n, off));
  const candidates: { s: number; how: string; guide?: [Point, Point] }[] = [];
  if (!o.free) {
    candidates.push({ s: face.L / 2, how: 'centred on', guide: [at(face.L / 2), at(face.L / 2, depth + BACK_GAP)] });
    candidates.push({ s: half, how: 'in the corner of' });
    candidates.push({ s: face.L - half, how: 'in the corner of' });
    // Items against the same face: abut either side, or line up their middles.
    for (const x of o.snaps?.items === false ? [] : others(level)) {
      const near = x.ring.some((q) => {
        const off = dot(sub(q, face.a), n);
        return off > -MM && off < depth + NEAR / 3;
      });
      if (!near) continue;
      const ks = x.ring.map((q) => dot(sub(q, face.a), t));
      const [lo, hi] = [Math.min(...ks), Math.max(...ks)];
      if (hi < -NEAR || lo > face.L + NEAR) continue;
      candidates.push({ s: hi + half, how: 'beside an item in' }, { s: lo - half, how: 'beside an item in' }, { s: (lo + hi) / 2, how: 'lined up with an item in', guide: [at((lo + hi) / 2), at((lo + hi) / 2, depth + BACK_GAP)] });
    }
  }
  let best: { s: number; how: string; guide?: [Point, Point] } | null = null;
  for (const c of candidates) {
    if (c.s < half - 1 || c.s > face.L - half + 1) continue;
    if (Math.abs(c.s - face.s) <= o.tol && (best === null || Math.abs(c.s - face.s) < Math.abs(best.s - face.s))) best = c;
  }
  if (best !== null) {
    s = best.s;
    how = best.how;
    if (best.guide !== undefined) guides.push(best.guide);
  } else {
    // The gap from the corner on the grid.
    s = half + Math.round((face.s - half) / o.grid) * o.grid;
  }
  s = Math.min(face.L - half, Math.max(half, s));
  // Turned by hand to face some other way, it stands free instead.
  if (o.turned && Math.abs(dot(unitAt(o.rotation), n) - 1) > 1e-6) return null;
  // Its back (least x) BACK_GAP off the face, its middle (y) at s.
  const origin = round(add(add(at(s), scale(n, BACK_GAP - b.min[0])), scale(v, -qc)));
  const footprint = footprintAt(origin, n, b);
  const mid = BACK_GAP + depth / 2;
  const gaps: Gap[] = [];
  if (s - half > MM) gaps.push({ from: at(0, mid), to: at(s - half, mid), length: s - half });
  if (face.L - s - half > MM) gaps.push({ from: at(s + half, mid), to: at(face.L, mid), length: face.L - s - half });
  const wallWord = compassOf(scale(n, -1));
  const roomName = o.roomName?.(room.id) ?? room.name;
  const host: HostRef = { mode: 'surface', room: room.id, surface: 'floor', at: origin, rotation: angleOf(n) };
  return finish(entry, level, { at: p, origin, facing: n, footprint, host, opening: null, guides, gaps, label: `Against the ${wallWord === null ? '' : `${wallWord} `}wall · ${how} the ${roomName}` }, room);
}

// ─── Free on a floor, or on the level ─────────────────────────────────────────────────────────

interface Line {
  /** A point on it and its direction (unit). */
  p: Point;
  d: Point;
  /** Its extent along `d`, from `p`. */
  lo: number;
  hi: number;
  kind: 'face' | 'item';
}

function linesOf(level: LevelView, room: RoomView | undefined, snaps: GhostOptions['snaps']): Line[] {
  const out: Line[] = [];
  if (room !== undefined && snaps?.walls !== false) for (const f of facesOf(room)) out.push({ p: f.a, d: scale(sub(f.b, f.a), 1 / f.L), lo: 0, hi: f.L, kind: 'face' });
  for (const x of snaps?.items === false ? [] : others(level)) {
    const r = x.ring;
    for (let i = 0; i < r.length; i++) {
      const a = r[i] as Point;
      const b = r[(i + 1) % r.length] as Point;
      const L = dist(a, b);
      if (L > 0) out.push({ p: a, d: scale(sub(b, a), 1 / L), lo: 0, hi: L, kind: 'item' });
    }
  }
  return out;
}

function free(level: LevelView, entry: Entry, p: Point, o: GhostOptions, onLevel: boolean): Ghost {
  const room = roomOf(level, p);
  const b = entry.box;
  const u = unitAt(o.rotation);
  const v = perp(u);
  const dx = (b.max[0] - b.min[0]) / 2;
  const dy = (b.max[1] - b.min[1]) / 2;
  // The shared snap engine first: the grid and alignment with junctions, unless ⌥.
  // FLR-T-18.9's engine with the person's settings — its grid and smart-guide alignment; the faces,
  // items and walls this ghost snaps to itself below, so not those (an item's middle never lands on a wall's line).
  const base: Point = o.snaps?.grid === false && !o.snaps.guides ? p : snapPoint(level, p, { tol: o.tol, grid: o.grid, free: o.free === true, ...(o.snaps === undefined ? {} : { settings: { ...o.snaps, junctions: false, walls: false, midpoints: false, items: false, ghosts: false } }) }).point;
  let centre: Point = base;
  const guides: [Point, Point][] = [];
  const flush: string[] = [];
  if (o.free !== true) {
    // Each axis of the item's frame by itself: a side flush to a face or to an item's side, or its
    // middle lined up with an item's middle.
    const lines = linesOf(level, room, o.snaps);
    const middles = (o.snaps?.items === false || o.snaps?.guides === false ? [] : others(level)).map((x) => x.ring.reduce<Point>((s, q) => [s[0] + q[0] / x.ring.length, s[1] + q[1] / x.ring.length], [0, 0]));
    for (const [axis, half] of [[u, dx], [v, dy]] as const) {
      const across = axis === u ? v : u;
      const extentAcross = axis === u ? dy : dx;
      let best: { delta: number; side: -1 | 0 | 1; to: Point; kind: Line['kind'] } | null = null;
      const consider = (delta: number, side: -1 | 0 | 1, to: Point, kind: Line['kind']) => {
        if (Math.abs(delta) <= o.tol && (best === null || Math.abs(delta) < Math.abs(best.delta))) best = { delta, side, to, kind };
      };
      for (const line of lines) {
        // Only lines square to this axis, whose extent comes within NEAR of the item's across it.
        if (Math.abs(dot(line.d, axis)) > 1e-3) continue;
        const k0 = dot(sub(line.p, p), across);
        const k1 = k0 + dot(line.d, across) * line.hi;
        if (Math.max(k0, k1) < -extentAcross - NEAR || Math.min(k0, k1) > extentAcross + NEAR) continue;
        const k = dot(sub(line.p, p), axis);
        // The nearest point of the line to the item's middle, for the guide.
        const along = Math.max(line.lo, Math.min(line.hi, dot(sub(p, line.p), line.d)));
        const to = add(line.p, scale(line.d, along));
        // A face is met 10 mm short, as a backed item's back is, so the host's point is strictly
        // inside the room (Core 13.3.4); an item's side is met exactly.
        const inset = line.kind === 'face' ? BACK_GAP : 0;
        consider(k - half - inset, 1, to, line.kind);
        consider(k + half + inset, -1, to, line.kind);
      }
      for (const m of middles) {
        const off = dot(sub(m, p), across);
        if (Math.abs(off) > extentAcross + NEAR * 2) continue;
        consider(dot(sub(m, p), axis), 0, m, 'item');
      }
      const hit = best as { delta: number; side: -1 | 0 | 1; to: Point; kind: Line['kind'] } | null;
      if (hit !== null) {
        // This axis's part of the snapped point becomes the flush (or lined-up) one.
        centre = add(centre, scale(axis, hit.delta - dot(sub(base, p), axis)));
        const from = add(add(p, scale(axis, hit.delta)), scale(axis, hit.side * half));
        guides.push([from, hit.to]);
        flush.push(hit.side === 0 ? 'middle' : hit.kind);
      }
    }
  }
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  const origin = round(sub(centre, add(scale(u, cx), scale(v, cy))));
  const footprint = footprintAt(origin, u, b);
  const rotation = angleOf(u);
  const at = origin;
  const mid: Point = add(origin, add(scale(u, cx), scale(v, cy)));
  // Clear distances from each side's middle to the room's faces.
  const gaps: Gap[] = [];
  if (room !== undefined)
    for (const [dir, half] of [[u, dx], [scale(u, -1), dx], [v, dy], [scale(v, -1), dy]] as const) {
      const from = add(mid, scale(dir, half));
      const hit = rayHit(from, dir, [room.outer, ...room.holes]);
      if (hit !== null && hit < 6_000 * MM) gaps.push({ from, to: add(from, scale(dir, hit)), length: hit });
    }
  const roomName = room === undefined ? null : (o.roomName?.(room.id) ?? room.name);
  let host: HostRef;
  let label: string;
  if (onLevel || room === undefined) {
    host = { mode: 'free', level: level.id, at, rotation };
    label = room === undefined ? 'Free on the level' : `Free on the level · in the ${roomName ?? ''}`;
  } else {
    host = { mode: 'surface', room: room.id, surface: 'floor', at, rotation };
    const faces = flush.filter((k) => k === 'face').length;
    label = faces >= 2 ? `In a corner of the ${roomName ?? ''}` : faces === 1 ? `Against a wall of the ${roomName ?? ''}` : flush.length > 0 ? `Lined up with an item in the ${roomName ?? ''}` : `In the ${roomName ?? ''}`;
  }
  return finish(entry, level, { at: p, origin, facing: u, footprint, host, opening: null, guides, gaps: gaps.sort((a, c) => a.length - c.length).slice(0, 2), label }, onLevel ? undefined : room);
}

// ─── Wall mounts and devices ──────────────────────────────────────────────────────────────────

function mounted(level: LevelView, entry: Entry, p: Point, o: GhostOptions): Ghost | null {
  const kind = entry.source.kind === 'device' ? entry.source.device : null;
  const mount = kind?.mount ?? (entry.placement === 'wall' ? 'wall' : 'floor');
  const depth = entry.box.max[0] - entry.box.min[0];
  const hover = hoverFor(level, mount, p, {
    grid: o.grid,
    // A wall mount is found from inside the room, within its depth and the pointer's reach.
    tol: Math.max(o.tol, depth),
    height: entry.height,
    ...(mount === 'wall' || mount === 'floorWall' ? {} : { rotation: angleOf(unitAt(o.rotation)) }),
  });
  if (hover === null) return null;
  const footprint = footprintAt(hover.point, hover.facing, entry.box);
  const room = roomOf(level, add(hover.point, scale(hover.facing, MM * 20)));
  const roomName = room === undefined ? null : (o.roomName?.(room.id) ?? room.name);
  const host = hover.host;
  const label =
    host.mode === 'wallFace'
      ? `On ${o.wallName?.(host.wall) ?? host.wall}${roomName === null ? '' : ` · ${roomName}`}`
      : host.mode === 'surface'
        ? `On the ${host.surface} of the ${roomName ?? 'room'}`
        : 'Free on the level';
  const gaps: Gap[] = [];
  if (host.mode === 'wallFace') {
    const wall = level.walls.find((w) => w.id === host.wall);
    if (wall !== undefined && wall.line.length <= 2) {
      const L = dist(wall.a, wall.b);
      const at = typeof host.at === 'number' ? host.at : 0;
      const t = scale(sub(wall.b, wall.a), 1 / L);
      const off = add(hover.point, scale(hover.facing, depth + 120 * MM));
      const base = sub(off, scale(t, at));
      const half = (entry.box.max[1] - entry.box.min[1]) / 2;
      if (at - half > MM) gaps.push({ from: base, to: add(base, scale(t, at - half)), length: at - half });
      if (L - at - half > MM) gaps.push({ from: add(base, scale(t, at + half)), to: add(base, scale(t, L)), length: L - at - half });
    }
  }
  return finish(entry, level, { at: p, origin: hover.point, facing: hover.facing, footprint, host, opening: null, guides: [], gaps, label, ...(hover.problem === undefined ? {} : { problem: hover.problem }) }, undefined);
}

// ─── Openings ─────────────────────────────────────────────────────────────────────────────────

/** A door's hinge and swing for a quarter turn of the ghost: R walks it round the four. */
const QUARTERS: readonly [('start' | 'end'), ('left' | 'right')][] = [['start', 'right'], ['end', 'right'], ['end', 'left'], ['start', 'left']];

function nearestWall(level: LevelView, p: Point, reach: number): WallView | null {
  let best: { w: WallView; d: number } | null = null;
  for (const w of level.walls) {
    let d: number;
    if (w.line.length > 2) {
      d = Infinity;
      for (let i = 0; i + 1 < w.line.length; i++) d = Math.min(d, project(p, w.line[i] as Point, w.line[i + 1] as Point).distance);
    } else {
      const pr = project(p, w.a, w.b);
      if (pr.t < 0 || pr.t > 1) continue;
      d = pr.distance;
    }
    const limit = w.thickness / 2 + reach;
    if (d <= limit && (best === null || d < best.d)) best = { w, d };
  }
  return best?.w ?? null;
}

function opening(level: LevelView, entry: Entry, p: Point, o: GhostOptions): Ghost | null {
  const width = entry.box.max[1] - entry.box.min[1];
  const wall = nearestWall(level, p, Math.max(o.tol * 2, 300 * MM));
  if (wall === null) return null;
  const snap = snapOpeningOn(wall, width, p, { tol: o.tol, grid: o.grid });
  // FLR-T-18.9's smart guides: its centre or an edge in line with another opening, a junction or an item.
  const aligned = snap.centered || o.free === true ? null : alignOpening(level, wall, { offset: snap.offset, width }, { tol: o.tol, settings: o.snaps, name: o.wallName });
  if (aligned !== null) snap.offset = aligned.offset;
  const quarter = QUARTERS[(((Math.round(o.rotation / 90) % 4) + 4) % 4)] as [('start' | 'end'), ('left' | 'right')];
  const [nearer, side] = o.turned ? quarter : [snap.nearer, snap.side];
  const aim: OpeningAim = { wall: wall.id, offset: snap.offset, centered: snap.centered, width, side, nearer, fits: snap.fits };
  const straight = wall.line.length <= 2;
  const L = wall.arc?.length ?? dist(wall.a, wall.b);
  const t = straight ? scale(sub(wall.b, wall.a), 1 / (dist(wall.a, wall.b) || 1)) : ([1, 0] as Point);
  const n = straight ? leftNormal(wall.a, wall.b) : ([0, 1] as Point);
  const p0 = add(wall.a, scale(t, snap.offset));
  const p1 = add(wall.a, scale(t, snap.offset + width));
  const footprint: Ring = straight ? [add(p0, scale(n, wall.left)), add(p1, scale(n, wall.left)), sub(p1, scale(n, wall.right)), sub(p0, scale(n, wall.right))] : [];
  const gaps: Gap[] = [];
  if (straight) {
    const off = scale(n, (side === 'left' ? 1 : -1) * (Math.max(wall.left, wall.right) + 200 * MM));
    if (snap.offset > MM) gaps.push({ from: add(wall.a, off), to: add(p0, off), length: snap.offset });
    if (L - snap.offset - width > MM) gaps.push({ from: add(p1, off), to: add(wall.b, off), length: L - snap.offset - width });
  }
  const room = roomOf(level, add(scale(add(p0, p1), 0.5), scale(n, (side === 'left' ? 1 : -1) * (wall.thickness / 2 + 100 * MM))));
  const roomName = room === undefined ? null : (o.roomName?.(room.id) ?? room.name);
  const label = `In ${o.wallName?.(wall.id) ?? wall.id}${roomName === null ? '' : ` · ${roomName}`}${snap.centered ? ' · centred' : ''}`;
  // Another opening in the way (Core 7.3: openings in one wall do not overlap).
  const clash = level.openings.find((x) => x.wall === wall.id && x.offset < snap.offset + width && snap.offset < x.offset + x.width);
  const problem = !snap.fits ? 'That wall is shorter than the opening. Pick a narrower type, or a longer wall.' : clash !== undefined ? `It would overlap ${o.wallName?.(clash.id) ?? clash.id}: slide it along the wall.` : undefined;
  const g: Ghost = {
    at: p,
    origin: p0,
    facing: side === 'left' ? n : scale(n, -1),
    footprint,
    envelopes: [],
    host: null,
    opening: aim,
    guides: snap.centered && straight ? [[add(wall.a, scale(t, L / 2)), add(add(wall.a, scale(t, L / 2)), scale(n, (side === 'left' ? 1 : -1) * 600 * MM))]] : (aligned?.guides ?? []),
    gaps,
    label,
    blocked: problem !== undefined,
    ...(problem === undefined ? {} : { problem }),
  };
  return g;
}

// ─── The ghost ─────────────────────────────────────────────────────────────────────────────────

/** The ghost of an entry at a point on a level, or null when it has nowhere to go there. */
export function ghostOf(level: LevelView, entry: Entry, p: Point, options: GhostOptions): Ghost | null {
  // The snap menu's master switch off is ⌥ held for good.
  const o: GhostOptions = options.snaps !== undefined && !options.snaps.on ? { ...options, free: true } : options;
  switch (entry.placement) {
    case 'opening':
      return opening(level, entry, p, o);
    case 'device':
    case 'wall':
      return mounted(level, entry, p, o);
    case 'level':
      return free(level, entry, p, o, true);
    case 'backed': {
      const room = roomOf(level, p);
      if (room !== undefined && o.free !== true && o.snaps?.walls !== false) {
        const g = backed(level, entry, p, room, o);
        if (g !== null) return g;
      }
      return free(level, entry, p, o, false);
    }
    case 'floor':
      return free(level, entry, p, o, false);
  }
}
