import { footprintsOverlap } from '@floorspec/engine';
import type { EditorModel, LevelView, Point, Ring } from '../model';

/**
 * Clearance halos while editing (FLR-T-18.14, the board's "18.14 · Clearance halos while dragging").
 *
 * While an item is dragged, resized, turned or placed, the clearance envelopes of the moving item
 * and of what stands near it are drawn as faint halos: clear, tight (within 10 % of the envelope's
 * depth of something) or in conflict. They are worked out from the same rule data the findings are:
 *
 *  - the envelopes are the engine's derived clearance envelopes (Core 13.5) — a door type's swing,
 *    an appliance's door, a sofa's walkway, an island's working space, a fixture's clearance —
 *    exactly as a rule pack's envelope measures (Rules 7.5–7.8) and FS_furniture's lint read them;
 *  - an envelope is in conflict where it runs into an obstacle as Rules 7.6 counts one — another
 *    extension element's fallback footprint, or any wall but its owner's host wall, overlapping it
 *    vertically — with FS_furniture 4.5's grouping (`with`) respected, as FS-FURN-LINT-004 does;
 *    the overlap is the engine's own exact test (Core 13.6, `footprintsOverlap`).
 *
 * Halos advise; they never block (FLR-ADR-011): a conflicted item still drops where it is let go.
 *
 * Incremental: the level's envelopes and obstacles are indexed once per model in a coarse grid; a
 * frame asks only for what lies near the moving item, and the moving item is read from the batch
 * preview (or the placing ghost) — never a whole-document evaluation per pointer move.
 */

export type Purpose = 'workingSpace' | 'fixtureClearance' | 'swing' | 'access';
export type Tone = 'clear' | 'tight' | 'conflict';

const MM = 1_280;
/** The grid the index buckets by: 2 m. */
const CELL = 2_000 * MM;
/** How far round the moving item a neighbour's envelope is looked at: 2.5 m. */
export const NEAR = 2_500 * MM;
/** Tight: within this share of the envelope's depth of an obstacle. */
export const TIGHT = 0.1;

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A clearance envelope in plan: whose, its name and purpose, its ring and vertical range. */
export interface Zone {
  owner: string;
  name: string;
  purpose: Purpose;
  ring: Ring;
  bottom: number;
  top: number;
  box: Box;
}

/** Something an envelope can run into (Rules 7.6): an element's footprint, or a wall's outline. */
export interface Obstacle {
  id: string;
  kind: 'item' | 'wall';
  /** Convex parts: an element's footprint, a straight wall's outline, an arc wall's segments. */
  parts: Ring[];
  bottom: number;
  top: number;
  box: Box;
}

/** What an envelope's owner is in plan — its footprint, or an opening's location-line segment. */
interface Owner {
  id: string;
  /** The polygon (or segment) the envelope's depth is measured from. */
  shape: Ring;
  /** The wall it is hosted in or on: never an obstacle to its own envelopes (Rules 7.6). */
  hostWall: string | null;
  /** FS_furniture's `with` (4.3): what it is grouped with. */
  with: string | null;
}

export interface HaloIndex {
  level: string;
  zones: Zone[];
  obstacles: Obstacle[];
  owners: Map<string, Owner>;
  /** Grid cell → indexes into zones and obstacles. */
  zoneCells: Map<string, number[]>;
  obstacleCells: Map<string, number[]>;
}

/** One halo to draw, with why it has its tone. */
export interface Halo {
  owner: string;
  name: string;
  purpose: Purpose;
  ring: Ring;
  tone: Tone;
  /** It belongs to what is moving (drawn stronger) — else a neighbour. */
  moving: boolean;
  /** For a tight or conflicted halo: the obstacle, the clear distance from the owner, and the envelope's depth. */
  against?: { id: string; kind: Obstacle['kind']; clear: number; needs: number; from: Point; to: Point; spare: number };
}

/** The moving part of a frame: an element (or the placing ghost) where it would be. */
export interface Moving {
  id: string;
  footprint: Ring | null;
  bottom: number;
  top: number;
  zones: Omit<Zone, 'box'>[];
  /** For an opening, its location-line segment; else the footprint. */
  shape: Ring;
  hostWall: string | null;
  with: string | null;
}

// ─── Geometry ────────────────────────────────────────────────────────────────────────────────

export function boxOf(ring: readonly Point[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}

const grow = (b: Box, d: number): Box => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d });
const meets = (a: Box, b: Box): boolean => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
const union = (a: Box, b: Box): Box => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) });

function closestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return [a[0] + dx * t, a[1] + dy * t];
}

/** Do two segments cross (or touch)? */
function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

function inside(p: Point, ring: readonly Point[]): boolean {
  if (ring.length < 3) return false;
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point;
    const b = ring[j] as Point;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

const edges = (ring: readonly Point[]): [Point, Point][] => (ring.length === 2 ? [[ring[0] as Point, ring[1] as Point]] : ring.map((p, i) => [p, ring[(i + 1) % ring.length] as Point]));

/** The nearest points of two polygons (or segments), and their distance — 0 where they overlap. */
export function nearest(r1: readonly Point[], r2: readonly Point[]): { d: number; from: Point; to: Point } {
  let best = { d: Infinity, from: r1[0] as Point, to: r2[0] as Point };
  const e1 = edges(r1);
  const e2 = edges(r2);
  for (const [a, b] of e1)
    for (const [c, d] of e2) {
      if (crosses(a, b, c, d)) {
        const p: Point = a;
        return { d: 0, from: p, to: p };
      }
      for (const [p, s, t] of [[a, c, d], [b, c, d]] as const) {
        const q = closestOnSegment(p, s, t);
        const dd = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (dd < best.d) best = { d: dd, from: p, to: q };
      }
      for (const [p, s, t] of [[c, a, b], [d, a, b]] as const) {
        const q = closestOnSegment(p, s, t);
        const dd = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (dd < best.d) best = { d: dd, from: q, to: p };
      }
    }
  if (r2.length > 2 && inside(r1[0] as Point, r2)) return { d: 0, from: r1[0] as Point, to: r1[0] as Point };
  if (r1.length > 2 && inside(r2[0] as Point, r1)) return { d: 0, from: r2[0] as Point, to: r2[0] as Point };
  return best;
}

/** How deep an envelope reaches from its owner: the farthest of its edges' middles from the owner. */
export function depthOf(zone: readonly Point[], owner: readonly Point[]): number {
  let d = 0;
  for (const [a, b] of edges(zone)) {
    const m: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    d = Math.max(d, nearest([m, m], owner).d);
  }
  return d;
}

/** The engine's exact overlap of two convex rings' interiors (Core 13.6), with a box test first. */
function overlapsRing(a: Ring, ab: Box, b: Ring): boolean {
  if (!meets(ab, boxOf(b))) return false;
  const ia = a.map((p) => [Math.round(p[0]), Math.round(p[1])] as [number, number]);
  const ib = b.map((p) => [Math.round(p[0]), Math.round(p[1])] as [number, number]);
  return footprintsOverlap(ia, ib);
}

// ─── The index ───────────────────────────────────────────────────────────────────────────────

const cellsOf = (b: Box): string[] => {
  const out: string[] = [];
  for (let i = Math.floor(b.minX / CELL); i <= Math.floor(b.maxX / CELL); i++) for (let k = Math.floor(b.minY / CELL); k <= Math.floor(b.maxY / CELL); k++) out.push(`${String(i)}:${String(k)}`);
  return out;
};

function bucket(cells: Map<string, number[]>, box: Box, index: number): void {
  for (const c of cellsOf(box)) {
    const list = cells.get(c);
    if (list === undefined) cells.set(c, [index]);
    else list.push(index);
  }
}

function lookup(cells: Map<string, number[]>, box: Box): number[] {
  const out = new Set<number>();
  for (const c of cellsOf(box)) for (const i of cells.get(c) ?? []) out.add(i);
  return [...out].sort((a, b) => a - b);
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An arc wall's outline as quads between its face vertices; a straight wall's outline as is. */
function wallParts(ring: Ring, polyline: number): Ring[] {
  if (polyline <= 2 || ring.length !== polyline * 2) return [ring];
  const n = polyline;
  const parts: Ring[] = [];
  for (let i = 0; i + 1 < n; i++) parts.push([ring[i] as Point, ring[i + 1] as Point, ring[2 * n - 2 - i] as Point, ring[2 * n - 1 - i] as Point]);
  return parts;
}

const cache = new WeakMap<EditorModel, Map<string, HaloIndex>>();

/** The level's envelopes, obstacles and owners, indexed once per model. */
export function indexOf(model: EditorModel, levelId: string): HaloIndex | null {
  let byLevel = cache.get(model);
  const hit = byLevel?.get(levelId);
  if (hit !== undefined) return hit;
  const level = model.levels.find((l) => l.id === levelId);
  if (level === undefined) return null;
  const index = buildIndex(model, level);
  if (byLevel === undefined) {
    byLevel = new Map();
    cache.set(model, byLevel);
  }
  byLevel.set(levelId, index);
  return index;
}

function buildIndex(model: EditorModel, level: LevelView): HaloIndex {
  const derived = model.derived;
  const zones: Zone[] = [];
  const obstacles: Obstacle[] = [];
  const owners = new Map<string, Owner>();
  const clearances = derived?.clearances ?? {};
  for (const d of level.devices) {
    const host = isObj(d.element['host']) ? d.element['host'] : null;
    owners.set(d.id, {
      id: d.id,
      shape: d.footprint,
      hostWall: host?.['mode'] === 'wallFace' && typeof host['wall'] === 'string' ? host['wall'] : null,
      with: typeof d.element['with'] === 'string' ? d.element['with'] : null,
    });
    obstacles.push({ id: d.id, kind: 'item', parts: [d.footprint], bottom: d.bottom, top: d.top, box: boxOf(d.footprint) });
    for (const c of d.clearances) {
      const der = clearances[d.id]?.[c.name];
      zones.push({ owner: d.id, name: c.name, purpose: c.purpose as Purpose, ring: c.ring, bottom: der?.bottom ?? d.bottom, top: der?.top ?? d.top, box: boxOf(c.ring) });
    }
  }
  for (const o of level.openings) {
    const own = clearances[o.id];
    if (own === undefined) continue;
    owners.set(o.id, { id: o.id, shape: [o.start, o.end], hostWall: o.wall, with: null });
    for (const [name, c] of Object.entries(own)) zones.push({ owner: o.id, name, purpose: c.purpose, ring: c.footprint, bottom: c.bottom, top: c.top, box: boxOf(c.footprint) });
  }
  for (const w of level.walls) {
    const dw = derived?.walls[w.id];
    obstacles.push({ id: w.id, kind: 'wall', parts: wallParts(w.ring, w.line.length), bottom: dw?.baseElevation ?? -Infinity, top: dw?.topElevation ?? Infinity, box: boxOf(w.ring) });
  }
  const zoneCells = new Map<string, number[]>();
  const obstacleCells = new Map<string, number[]>();
  zones.forEach((z, i) => { bucket(zoneCells, z.box, i); });
  obstacles.forEach((o, i) => { bucket(obstacleCells, o.box, i); });
  return { level: level.id, zones, obstacles, owners, zoneCells, obstacleCells };
}

// ─── What moves ──────────────────────────────────────────────────────────────────────────────

/**
 * The moving elements as a previewed batch would leave them: each one's footprint and envelopes
 * from the preview's derived model — only these, looked up by ID.
 */
export function movingFrom(preview: EditorModel, levelId: string, ids: readonly string[]): Moving[] {
  const level = preview.levels.find((l) => l.id === levelId);
  if (level === undefined) return [];
  const want = new Set(ids);
  // What is with a moving item moves with it (FS_furniture 4.3: a cooktop set into an island).
  for (const d of level.devices) if (typeof d.element['with'] === 'string' && want.has(d.element['with'])) want.add(d.id);
  const clearances = preview.derived?.clearances ?? {};
  const out: Moving[] = [];
  for (const d of level.devices) {
    if (!want.has(d.id)) continue;
    const host = isObj(d.element['host']) ? d.element['host'] : null;
    out.push({
      id: d.id,
      footprint: d.footprint,
      bottom: d.bottom,
      top: d.top,
      shape: d.footprint,
      hostWall: host?.['mode'] === 'wallFace' && typeof host['wall'] === 'string' ? host['wall'] : null,
      with: typeof d.element['with'] === 'string' ? d.element['with'] : null,
      zones: d.clearances.map((c) => {
        const der = clearances[d.id]?.[c.name];
        return { owner: d.id, name: c.name, purpose: c.purpose as Purpose, ring: c.ring, bottom: der?.bottom ?? d.bottom, top: der?.top ?? d.top };
      }),
    });
  }
  for (const o of level.openings) {
    if (!want.has(o.id)) continue;
    const own = clearances[o.id] ?? {};
    out.push({
      id: o.id,
      footprint: null,
      bottom: 0,
      top: 0,
      shape: [o.start, o.end],
      hostWall: o.wall,
      with: null,
      zones: Object.entries(own).map(([name, c]) => ({ owner: o.id, name, purpose: c.purpose, ring: c.footprint, bottom: c.bottom, top: c.top })),
    });
  }
  return out;
}

// ─── A frame ─────────────────────────────────────────────────────────────────────────────────

const grouped = (a: { id: string; with: string | null }, b: { id: string; with: string | null }): boolean =>
  a.with === b.id || b.with === a.id || (a.with !== null && a.with === b.with);

interface Candidate {
  id: string;
  kind: Obstacle['kind'];
  parts: Ring[];
  bottom: number;
  top: number;
  box: Box;
  with: string | null;
}

/** The tone of one envelope against the obstacles near it, and what decided it. */
function judge(zone: Omit<Zone, 'box'> & { box: Box }, owner: { id: string; shape: Ring; hostWall: string | null; with: string | null }, near: readonly Candidate[]): Pick<Halo, 'tone' | 'against'> {
  const needs = depthOf(zone.ring, owner.shape);
  const slack = needs * TIGHT;
  let worst: Halo['against'] & { tone: Tone } | undefined;
  for (const o of near) {
    if (o.id === owner.id || o.id === owner.hostWall) continue;
    if (o.kind === 'item' && grouped(owner, o)) continue;
    // Rules 7.6: only an obstacle whose vertical range overlaps the envelope's.
    if (!(Math.max(o.bottom, zone.bottom) < Math.min(o.top, zone.top))) continue;
    if (!meets(grow(zone.box, slack), o.box)) continue;
    const conflict = o.parts.some((p) => overlapsRing(zone.ring, zone.box, p));
    let spare = 0;
    if (!conflict) {
      spare = Math.min(...o.parts.map((p) => nearest(zone.ring, p).d));
      if (spare >= slack) continue;
    }
    const tone: Tone = conflict ? 'conflict' : 'tight';
    // The clear distance from the owner to the obstacle, where the envelope wants `needs`.
    let best = { d: Infinity, from: owner.shape[0] as Point, to: owner.shape[0] as Point };
    for (const p of o.parts) {
      const n = nearest(owner.shape, p);
      if (n.d < best.d) best = n;
    }
    const candidate = { tone, id: o.id, kind: o.kind, clear: best.d, needs, from: best.from, to: best.to, spare };
    if (worst === undefined || (worst.tone === 'tight' && tone === 'conflict') || (worst.tone === tone && candidate.clear < worst.clear)) worst = candidate;
  }
  if (worst === undefined) return { tone: 'clear' };
  const { tone, ...against } = worst;
  return { tone, against };
}

/**
 * The halos of one frame: the moving parts' envelopes, judged against every obstacle near them, and
 * their neighbours' envelopes within NEAR, judged against the moving parts where the frame has them.
 */
export function haloFrame(index: HaloIndex, moving: readonly Moving[]): Halo[] {
  if (moving.length === 0) return [];
  const movingIds = new Set(moving.map((m) => m.id));
  let reach: Box | null = null;
  for (const m of moving) {
    for (const r of [m.shape, ...m.zones.map((z) => z.ring)]) {
      if (r.length === 0) continue;
      const b = boxOf(r);
      reach = reach === null ? b : union(reach, b);
    }
  }
  if (reach === null) return [];
  const area = grow(reach, NEAR);
  // The obstacles near: the index's, less what moves, plus the moving parts where they are now.
  const near: Candidate[] = [];
  for (const i of lookup(index.obstacleCells, grow(area, NEAR / 2))) {
    const o = index.obstacles[i] as Obstacle;
    if (movingIds.has(o.id)) continue;
    near.push({ ...o, with: index.owners.get(o.id)?.with ?? null });
  }
  const movers: Candidate[] = [];
  for (const m of moving) if (m.footprint !== null) movers.push({ id: m.id, kind: 'item', parts: [m.footprint], bottom: m.bottom, top: m.top, box: boxOf(m.footprint), with: m.with });
  near.push(...movers);
  const halos: Halo[] = [];
  for (const m of moving)
    for (const z of m.zones) {
      const box = boxOf(z.ring);
      halos.push({ owner: m.id, name: z.name, purpose: z.purpose, ring: z.ring, moving: true, ...judge({ ...z, box }, m, near) });
    }
  for (const i of lookup(index.zoneCells, area)) {
    const z = index.zones[i] as Zone;
    if (movingIds.has(z.owner) || !meets(z.box, area)) continue;
    const owner = index.owners.get(z.owner);
    if (owner === undefined) continue;
    // A neighbour is judged against what moves: its standing conflicts are the findings' to list, not this drag's news.
    halos.push({ owner: z.owner, name: z.name, purpose: z.purpose, ring: z.ring, moving: false, ...judge(z, owner, movers) });
  }
  return halos;
}

/** The halo to speak of: the moving item's worst, else the worst a neighbour has against it. */
export function headline(halos: readonly Halo[], moving: ReadonlySet<string>): Halo | null {
  const rank = (h: Halo) => (h.tone === 'conflict' ? 2 : h.tone === 'tight' ? 1 : 0);
  let best: Halo | null = null;
  for (const h of halos) {
    if (h.tone === 'clear' || h.against === undefined) continue;
    // A neighbour's trouble is news only when what it runs into is moving.
    if (!h.moving && !moving.has(h.against.id)) continue;
    if (best === null || rank(h) > rank(best) || (rank(h) === rank(best) && h.moving && !best.moving) || (rank(h) === rank(best) && h.moving === best.moving && (h.against.clear < (best.against?.clear ?? Infinity)))) best = h;
  }
  return best;
}

/** What a person calls an envelope of each purpose. */
export function purposeLabel(purpose: Purpose, opening: boolean): string {
  switch (purpose) {
    case 'access':
      return 'Walkway';
    case 'swing':
      return opening ? 'Door swing' : 'Door clearance';
    case 'fixtureClearance':
      return 'Fixture clearance';
    case 'workingSpace':
      return 'Working space';
  }
}
