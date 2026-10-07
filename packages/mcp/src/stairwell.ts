/* eslint-disable @typescript-eslint/no-non-null-assertion -- indices into a hull, a ring and a step list
   each walked within its own length; lookups into the engine's derived values of a valid document. */
import { deriveEvaluation, evaluate, OFFICIAL_READER, type FloorspecDocument } from '@floorspec/engine';
import type { Op } from './client.js';

/**
 * A stair's well, as operations (FLR-T-12.11). Core 17.6 derives which of a stair's steps the floor
 * above must be open over — `opening.first` — and a well is a bounded face of the `to` level with no
 * room anchored in it. Nothing turns the one into the other: the first live house drew it by hand,
 * working the headroom out from the spec. This draws the separators round those steps' outline — the
 * convex hull of their outlines — with each edge that runs beside a wall moved onto the wall's
 * location line, where the wall already bounds the face; and moves a room's anchor out of the well
 * first, so the well is not that room.
 *
 * Advice, as a diagnostic's fix is (Core 10.5): the tools offer it, an agent sends it. Non-normative.
 */

type Pt = readonly [number, number];

export interface Well {
  readonly stair: string;
  /** The level the well is cut in: the stair's `to`. */
  readonly level: string;
  /** The well's outline, counter-clockwise, in base units. */
  readonly outline: readonly Pt[];
  /** The operations that make it: anchor moves, then per side no wall bounds a guard wall, or a separator where the stair arrives. */
  readonly batch: readonly Op[];
  readonly notes: readonly string[];
}

/** How far beside a wall's face a stair edge may stand and still be moved onto the wall's line: 2". */
const BESIDE = 65024;
/** How far inside a room, and clear of the well, an anchor is moved to: 6". */
const CLEAR = 195072;

const cross = (a: Pt, b: Pt): number => a[0] * b[1] - a[1] * b[0];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];

/** The convex hull, counter-clockwise, of a set of points (Andrew's monotone chain). */
function hull(points: readonly Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(sub(lower.at(-1)!, lower.at(-2)!), sub(q, lower.at(-2)!)) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(sub(upper.at(-1)!, upper.at(-2)!), sub(q, upper.at(-2)!)) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Even-odd inside test; points on the boundary count as outside. */
function inside(poly: readonly Pt[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The least distance from a point to a polygon's boundary. */
function toBoundary(poly: readonly Pt[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j]!;
    const [bx, by] = poly[i]!;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const u = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(x - (ax + u * dx), y - (ay + u * dy)));
  }
  return best;
}

interface StraightWall {
  readonly id: string;
  readonly S: Pt;
  readonly E: Pt;
  readonly half: number;
}

/** The level's straight walls: their location lines and half thickness, from the derived faces. */
function wallsOn(doc: FloorspecDocument, derived: ReturnType<typeof deriveEvaluation>, level: string): StraightWall[] {
  const out: StraightWall[] = [];
  for (const [id, w] of Object.entries(doc.walls ?? {})) {
    if (w === undefined || w.level !== level || w.arc !== undefined) continue;
    const d = derived.walls[id];
    const S = doc.junctions?.[w.start]?.position;
    const E = doc.junctions?.[w.end]?.position;
    if (d === undefined || S === undefined || E === undefined) continue;
    out.push({ id, S: [S[0], S[1]], E: [E[0], E[1]], half: Math.hypot(d.startRight[0] - d.startLeft[0], d.startRight[1] - d.startLeft[1]) / 2 });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The wells of every stair whose derived opening (17.6) the floor above does not have yet, or of the stairs named. */
export function wells(document: object, only?: ReadonlySet<string>): Well[] {
  const ev = evaluate(document, OFFICIAL_READER);
  if (!ev.valid) return [];
  const doc = (ev.view ?? ev.document)!;
  const derived = deriveEvaluation(ev);
  const out: Well[] = [];
  for (const [id, st] of Object.entries(doc.stairs ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (st === undefined || (only !== undefined && !only.has(id))) continue;
    const d = derived.stairs?.[id];
    const steps = d?.steps;
    if (d === undefined || steps === undefined || st.minHeadroom === undefined) continue;
    // Asked for none in particular: only the stairs whose headroom is short now.
    if (only === undefined && d.headroom !== undefined && d.headroom >= st.minHeadroom) continue;
    // Core 17.6 derives where the opening starts as the headroom measures it (FLR-T-12.14).
    if (d.opening === undefined) continue;
    const corners = steps.slice(d.opening.first).flatMap((s) => s.outline.map(([x, y]): Pt => [x, y]));
    const h = hull(corners);
    if (h.length < 3) continue;
    out.push(wellOf(doc, derived, id, st.to, h, [d.head[0], d.head[1]]));
  }
  return out;
}

/** The guard round a well's open sides: 36" high, its body outside the well (FLR-T-12.11). */
const GUARD_HEIGHT = 1170432;
const GUARD_TYPE = 'wall-2x4-interior';

/** The distance from a point to a segment. */
function toSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const u = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + u * dx), p[1] - (a[1] + u * dy));
}

function wellOf(doc: FloorspecDocument, derived: ReturnType<typeof deriveEvaluation>, stair: string, level: string, h: readonly Pt[], head: Pt): Well {
  const walls = wallsOn(doc, derived, level);
  const notes: string[] = [];
  // Each edge as a line n·x = c, n its outward normal (the hull runs counter-clockwise: outward is right).
  const edges = h.map((a, i) => {
    const b = h[(i + 1) % h.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const n: Pt = [u[1], -u[0]];
    let c = n[0] * a[0] + n[1] * a[1];
    let onWall: string | null = null;
    let best = Infinity;
    for (const w of walls) {
      const wl = Math.hypot(w.E[0] - w.S[0], w.E[1] - w.S[1]);
      if (wl === 0 || Math.abs(cross(u, [(w.E[0] - w.S[0]) / wl, (w.E[1] - w.S[1]) / wl])) > 1e-9) continue;
      const delta = n[0] * w.S[0] + n[1] * w.S[1] - c;
      // The wall stands just outside the edge, and alongside it for its whole length.
      if (delta < 0 || delta > w.half + BESIDE || delta >= best) continue;
      const along = (p: Pt): number => u[0] * p[0] + u[1] * p[1];
      const [w0, w1] = [along(w.S), along(w.E)].sort((x, y) => x - y) as [number, number];
      if (w0 > along(a) + 1 || w1 < along(b) - 1) continue;
      best = delta;
      onWall = w.id;
    }
    if (onWall !== null) c += best;
    return { n, c, onWall };
  });
  // The corners again, where consecutive edge lines meet.
  const outline = edges.map((e, i) => {
    const f = edges[(i + edges.length - 1) % edges.length]!;
    const det = f.n[0] * e.n[1] - f.n[1] * e.n[0];
    if (Math.abs(det) < 1e-12) return h[i]!;
    return [Math.round((f.c * e.n[1] - e.c * f.n[1]) / det), Math.round((f.n[0] * e.c - e.n[0] * f.c) / det)] as Pt;
  });
  const batch: Op[] = [];
  // A room anchored in the well would become the well: move its anchor out first.
  for (const [rid, r] of Object.entries(doc.rooms ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (r === undefined || r.level !== level || !(inside(outline, r.anchor[0], r.anchor[1]) || toBoundary(outline, r.anchor[0], r.anchor[1]) < CLEAR)) continue;
    const poly = derived.rooms[rid]?.outer.map(([x, y]): Pt => [x, y]);
    const to = poly === undefined ? undefined : freePoint(poly, outline, r.anchor);
    if (to === undefined) {
      notes.push(`${rid}${r.name === undefined ? '' : ` ("${r.name}")`} is anchored where the well goes, and no point of it is clear of the well: the well would take the room's place.`);
      continue;
    }
    batch.push({ op: 'setProperty', id: rid, path: '/anchor', value: [to[0], to[1]] });
    notes.push(`${rid}${r.name === undefined ? '' : ` ("${r.name}")`} was anchored where the well goes; its anchor moves clear of it first.`);
  }
  // outline[i] starts edge i: it is where edge i − 1 meets it. The side the stair arrives at stays open
  // — a separator; every other side no wall bounds gets a guard: a 36" wall drawn round the well
  // counter-clockwise, so its left face is the well's edge and its body stands outside it
  // (justification exteriorFace, Core 5.4) — a centred one would take half its thickness from the well.
  const sides = outline.map((a, i) => [a, outline[(i + 1) % outline.length]!] as const);
  const arrival = sides.reduce((best, [a, b], i) => (edges[i]!.onWall === null && (best < 0 || toSegment(head, a, b) < toSegment(head, ...sides[best]!)) ? i : best), -1);
  sides.forEach(([a, b], i) => {
    if (edges[i]!.onWall !== null) return;
    if (i === arrival) batch.push({ op: 'drawSeparator', level, from: [a[0], a[1]], to: [b[0], b[1]] });
    else batch.push({ op: 'drawWall', level, from: [a[0], a[1]], to: [b[0], b[1]], type: GUARD_TYPE, justification: 'exteriorFace', top: { height: GUARD_HEIGHT }, name: `Guard at ${stair}'s well` });
  });
  notes.push(`The well is a face with no room in it (Core 17.6). Its open sides get 36" guards (${GUARD_TYPE}, from the US starter library); the side ${stair} arrives at is left open.`);
  return { stair, level, outline, batch, notes };
}

/** The point of a room nearest its old anchor that is CLEAR inside the room and CLEAR of the well, on a 6" grid. */
function freePoint(room: readonly Pt[], well: readonly Pt[], anchor: readonly number[]): Pt | undefined {
  const xs = room.map((p) => p[0]);
  const ys = room.map((p) => p[1]);
  let best: Pt | undefined;
  let bestD = Infinity;
  for (let x = Math.min(...xs) + CLEAR; x <= Math.max(...xs) - CLEAR; x += CLEAR)
    for (let y = Math.min(...ys) + CLEAR; y <= Math.max(...ys) - CLEAR; y += CLEAR) {
      if (!inside(room, x, y) || toBoundary(room, x, y) < CLEAR || inside(well, x, y) || toBoundary(well, x, y) < CLEAR) continue;
      const dd = Math.hypot(x - anchor[0]!, y - anchor[1]!);
      if (dd < bestD) {
        bestD = dd;
        best = [Math.round(x), Math.round(y)];
      }
    }
  return best;
}

/** A clear distance at a stair's foot or head: how far its own level's floor runs before a wall. */
export interface Landing {
  readonly stair: string;
  /** Clear floor beyond the head on the `to` level, and before the foot on the stair's level, along the way it is walked; absent where no wall is met. */
  readonly head?: number;
  readonly foot?: number;
}

/** The distance along a ray from `o` in direction `u` to the first wall outline of a level; Infinity when none is met. */
function toWall(doc: FloorspecDocument, derived: ReturnType<typeof deriveEvaluation>, level: string, o: Pt, u: Pt): number {
  let best = Infinity;
  for (const [id, w] of Object.entries(doc.walls ?? {})) {
    if (w === undefined || w.level !== level) continue;
    const d = derived.walls[id];
    if (d === undefined) continue;
    const ring: Pt[] = [d.startRight, ...(d.right ?? []), d.endRight, d.endLeft, ...[...(d.left ?? [])].reverse(), d.startLeft].map(([x, y]): Pt => [x, y]);
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j]!;
      const b = ring[i]!;
      const e = sub(b, a);
      const den = cross(u, e);
      if (Math.abs(den) < 1e-12) continue;
      const ao = sub(a, o);
      const t = cross(ao, e) / den;
      const s = cross(ao, u) / den;
      if (t > 1 && s >= 0 && s <= 1) best = Math.min(best, t);
    }
  }
  return best;
}

/** The clear floor at each stair's foot and head, along its walkline's first and last directions. */
export function landings(document: object): Landing[] {
  const ev = evaluate(document, OFFICIAL_READER);
  if (!ev.valid) return [];
  const doc = (ev.view ?? ev.document)!;
  const derived = deriveEvaluation(ev);
  const out: Landing[] = [];
  for (const [id, st] of Object.entries(doc.stairs ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const d = derived.stairs?.[id];
    if (st === undefined || d === undefined) continue;
    const path: Pt[] = (d.walkline?.points ?? [d.foot, d.head]).map(([x, y]): Pt => [x, y]);
    if (path.length < 2) continue;
    const unit = (a: Pt, b: Pt): Pt => {
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    };
    const up = unit(path.at(-2)!, path.at(-1)!);
    const first = unit(path[0]!, path[1]!);
    const head = toWall(doc, derived, st.to, [d.head[0], d.head[1]], up);
    const foot = toWall(doc, derived, st.level, [d.foot[0], d.foot[1]], [-first[0], -first[1]]);
    out.push({ stair: id, ...(Number.isFinite(head) && { head: Math.round(head) }), ...(Number.isFinite(foot) && { foot: Math.round(foot) }) });
  }
  return out;
}
