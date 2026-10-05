/**
 * Floors, ceilings and slabs (Core 0.3, chapter 15): what a room's `floor` and `ceiling` and a
 * level's `floorThickness` and `ceilingHeight` resolve to, the exact geometry of flat, tray and
 * vaulted ceilings, the invariants FS-INV-701 to FS-INV-703, the derived `floors`, `ceilings` and
 * `slabs`, and the elevation of a `surface` host (15.6).
 *
 * Everything is exact and rounded once (2.2). A vaulted ceiling's elevation at a plan point P is
 *
 *     z(P) = E + h − (rise / run) · f(P) / √D  =  E + h − rise · f(P) · √D / (run · D)
 *
 * with A, B the ridge points, d = B − A, D = |d|², c(P) = dx·(P.y − A.y) − dy·(P.x − A.x) and the
 * fall f(P) = |c(P)| ("both"), c(P) ("left") or −c(P) ("right"): one radicand. A tray's centre is the
 * room polygon with every edge moved `border` to its left — each vertex the intersection of its two
 * edges' moved lines (5.5's face lines), or, where the two edges are collinear, the vertex moved
 * along their common normal — rounded once.
 */
import { Surd } from '../exact/surd.js';
import { toSafeNumber } from '../exact/bigint.js';
import { intersect, roundPoint, type Line, type XPoint } from '../geometry/exact-point.js';
import { area2, locate, type IPoint } from '../geometry/predicates.js';
import { comparePoints, polygonDegenerate, startAtLeast, type LevelGeometry } from '../derive/level.js';
import { entries, get, type Ceiling, type FloorspecDocument, type Room, type VaultedCeiling } from '../model/document.js';

type Point = [number, number];

const FLAT: Ceiling = { kind: 'flat' };

// ── resolution (15.1, 15.2) ─────────────────────────────────────────────────────

/** 15.1: the top of a room's floor — its level's elevation plus the floor's offset. */
export function floorTop(doc: FloorspecDocument, room: Room): bigint {
  return BigInt(get(doc.levels, room.level)!.elevation) + BigInt(room.floor?.offset ?? 0);
}

/** 15.1: the room's own floor thickness, else its level's floorThickness, else 0 (not declared). */
export function floorThickness(doc: FloorspecDocument, room: Room): bigint {
  return BigInt(room.floor?.thickness ?? get(doc.levels, room.level)!.floorThickness ?? 0);
}

/** 15.2: a room's ceiling, `{ "kind": "flat" }` by default. */
export const ceilingOf = (room: Room): Ceiling => room.ceiling ?? FLAT;

/** 15.2: the ceiling's height — its own, else its level's ceilingHeight, else the level's height. */
export function ceilingHeight(doc: FloorspecDocument, room: Room): bigint {
  const L = get(doc.levels, room.level)!;
  return BigInt(ceilingOf(room).height ?? L.ceilingHeight ?? L.height);
}

/** E + h: the elevation of a flat ceiling, of a tray's border, of a vault's ridge. */
export function ceilingBase(doc: FloorspecDocument, room: Room): bigint {
  return BigInt(get(doc.levels, room.level)!.elevation) + ceilingHeight(doc, room);
}

// ── vaults (15.3) ───────────────────────────────────────────────────────────────

/** c(P): the ridge line's cross with P — its distance from the line times √D, positive to the left. */
export function vaultCross(c: VaultedCeiling, p: IPoint): bigint {
  const [[ax, ay], [bx, by]] = c.ridge;
  const dx = BigInt(bx - ax);
  const dy = BigInt(by - ay);
  return dx * (p[1] - BigInt(ay)) - dy * (p[0] - BigInt(ax));
}

/** f(P): how far the ceiling has fallen at a point whose cross is `cross` (times √D). */
function fall(c: VaultedCeiling, cross: bigint): bigint {
  const slopes = c.slopes ?? 'both';
  if (slopes === 'both') return cross < 0n ? -cross : cross;
  return slopes === 'left' ? cross : -cross;
}

/** E + h − (rise / run) · fall / √D, exactly. */
function vaultZ(base: bigint, c: VaultedCeiling, f: bigint): Surd {
  const [[ax, ay], [bx, by]] = c.ridge;
  const dx = BigInt(bx - ax);
  const dy = BigInt(by - ay);
  const D = dx * dx + dy * dy;
  return Surd.sqrt(D).mulInt(-BigInt(c.pitch.rise) * f).divInt(BigInt(c.pitch.run) * D).addInt(base);
}

/** 15.3: the vault's elevation at a plan point, exactly. */
export function vaultAt(base: bigint, c: VaultedCeiling, p: IPoint): Surd {
  return vaultZ(base, c, fall(c, vaultCross(c, p)));
}

/** 15.3: the least and greatest exact elevations of a vault over a room polygon's outer ring. */
export function vaultRange(base: bigint, c: VaultedCeiling, outer: readonly IPoint[]): { low: Surd; high: Surd } {
  const crosses = outer.map((p) => vaultCross(c, p));
  const falls = crosses.map((x) => fall(c, x));
  const max = falls.reduce((a, b) => (b > a ? b : a));
  const min = falls.reduce((a, b) => (b < a ? b : a));
  const low = vaultZ(base, c, max);
  const both = (c.slopes ?? 'both') === 'both';
  const meets = crosses.some((x) => x <= 0n) && crosses.some((x) => x >= 0n);
  return { low, high: both && meets ? Surd.of(base) : vaultZ(base, c, min) };
}

/** 15.3.1: a vault's two ridge points are the same point. */
export const ridgeCollapsed = (c: VaultedCeiling): boolean => c.ridge[0][0] === c.ridge[1][0] && c.ridge[0][1] === c.ridge[1][1];

// ── trays (15.4) ────────────────────────────────────────────────────────────────

const cross2 = (a: IPoint, b: IPoint): bigint => a[0] * b[1] - a[1] * b[0];

/** The line of an edge with direction d through p, moved w to its left: n · P = n · p + w · |d|. */
function movedLine(d: IPoint, p: IPoint, w: bigint): Line {
  const A = -d[1];
  const B = d[0];
  const D = d[0] * d[0] + d[1] * d[1];
  return { A, B, C: Surd.sqrt(D).mulInt(w).addInt(A * p[0] + B * p[1]) };
}

/** Every vertex of a ring moved: exact (5.5's corner points). */
function insetRing(ring: readonly IPoint[], w: bigint): XPoint[] {
  const n = ring.length;
  const out: XPoint[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = ring[(i - 1 + n) % n]!;
    const p1 = ring[i]!;
    const p2 = ring[(i + 1) % n]!;
    const d0: IPoint = [p1[0] - p0[0], p1[1] - p0[1]];
    const d1: IPoint = [p2[0] - p1[0], p2[1] - p1[1]];
    if (cross2(d0, d1) !== 0n) out.push(intersect(movedLine(d0, p0, w), movedLine(d1, p1, w)));
    else {
      // Collinear edges: the vertex moved w along their common left normal, p1 + w · n / |d|.
      const D = d1[0] * d1[0] + d1[1] * d1[1];
      const k = Surd.sqrt(D).mulInt(w).divInt(D);
      out.push({ x: k.mulInt(-d1[1]).addInt(p1[0]), y: k.mulInt(d1[0]).addInt(p1[1]) });
    }
  }
  return out;
}

export interface TrayCentre {
  readonly outer: IPoint[];
  readonly holes: IPoint[][];
}

/**
 * 15.4: a tray's centre — the room polygon's rings moved `border` into the room, rounded, ring for
 * ring in their walk order — or undefined when it does not fit (FS-INV-703): an edge of a rounded
 * moved ring does not run the way its edge runs, or the moved rings are degenerate (6.2).
 */
export function trayCentre(outer: readonly IPoint[], holes: readonly (readonly IPoint[])[], border: bigint): TrayCentre | undefined {
  const rings: IPoint[][] = [];
  for (const ring of [outer, ...holes]) {
    const moved = insetRing(ring, border).map(roundPoint);
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      const ma = moved[i]!;
      const mb = moved[(i + 1) % n]!;
      if ((b[0] - a[0]) * (mb[0] - ma[0]) + (b[1] - a[1]) * (mb[1] - ma[1]) <= 0n) return undefined;
    }
    rings.push(moved);
  }
  const [o, ...hs] = rings as [IPoint[], ...IPoint[][]];
  if (polygonDegenerate(o, hs)) return undefined;
  return { outer: o, holes: hs };
}

/** A plan point of the centre: inside or on its outer ring, and not strictly inside one of its holes. */
export const inTray = (p: IPoint, t: TrayCentre): boolean => locate(p, t.outer) !== 'outside' && t.holes.every((h) => locate(p, h) !== 'inside');

// ── a room's polygon ────────────────────────────────────────────────────────────

/** The rounded room polygon of a room (6.2), its rings in walk order: outer counter-clockwise, holes clockwise. */
export function roomRings(g: LevelGeometry, face: number): { outer: IPoint[]; holes: IPoint[][] } {
  const p = g.roomPolygon(g.faces[face]!);
  return { outer: p.outer, holes: p.holes };
}

// ── hosting (15.6) ──────────────────────────────────────────────────────────────

/**
 * 15.6: Oz of a `surface` host on `room` — the top of the room's floor, or the elevation of its
 * ceiling at `position`, rounded once. `rings` gives the room's polygon, needed only under a tray.
 */
export function surfaceElevation(
  doc: FloorspecDocument,
  room: Room,
  surface: 'floor' | 'ceiling',
  position: readonly [number, number],
  rings: () => { outer: IPoint[]; holes: IPoint[][] } | undefined,
): bigint {
  if (surface === 'floor') return floorTop(doc, room);
  const c = ceilingOf(room);
  const base = ceilingBase(doc, room);
  const p: IPoint = [BigInt(position[0]), BigInt(position[1])];
  if (c.kind === 'vaulted') return vaultAt(base, c, p).round();
  if (c.kind === 'tray') {
    const r = rings();
    const t = r && trayCentre(r.outer, r.holes, BigInt(c.border));
    return t && inTray(p, t) ? base + BigInt(c.depth) : base;
  }
  return base;
}

// ── invariants (15.2, 15.3, 15.4) ───────────────────────────────────────────────

export interface FloorDiagnostic {
  readonly code: 'FS-INV-701' | 'FS-INV-702' | 'FS-INV-703';
  readonly room: string;
}

/**
 * FS-INV-701 to FS-INV-703 for one room on a level where room invariants were evaluated and with
 * none of FS-INV-201 to FS-INV-204 (10.3); FS-INV-701 not for a room with FS-INV-702.
 */
export function floorInvariants(doc: FloorspecDocument, id: string, room: Room, rings: { outer: IPoint[]; holes: IPoint[][] }): FloorDiagnostic[] {
  const c = ceilingOf(room);
  if (c.kind === 'vaulted' && ridgeCollapsed(c)) return [{ code: 'FS-INV-702', room: id }];
  const base = ceilingBase(doc, room);
  const low = c.kind === 'vaulted' ? vaultRange(base, c, rings.outer).low : Surd.of(base);
  const out: FloorDiagnostic[] = [];
  if (low.sub(Surd.of(floorTop(doc, room))).sign() <= 0) out.push({ code: 'FS-INV-701', room: id });
  if (c.kind === 'tray' && trayCentre(rings.outer, rings.holes, BigInt(c.border)) === undefined) out.push({ code: 'FS-INV-703', room: id });
  return out;
}

// ── derived values (15.1, 15.5, 15.7) ───────────────────────────────────────────

export interface DerivedBox {
  min: [number, number, number];
  max: [number, number, number];
}

/** 15.1: a room's floor. */
export interface DerivedFloor {
  top: number;
  bottom: number;
  box: DerivedBox;
}

/** 15.5: a room's ceiling: its kind, low and high, box, and a tray's centre. */
export interface DerivedCeiling {
  kind: 'flat' | 'tray' | 'vaulted';
  low: number;
  high: number;
  box: DerivedBox;
  tray?: { outer: Point[]; holes: Point[][] };
}

/** 15.7: a slab's bounding geometry. */
export interface DerivedSlab {
  outline: Point[];
  top: number;
  bottom: number;
  box: DerivedBox;
}

const n = toSafeNumber;
const pt = (p: IPoint): Point => [n(p[0]), n(p[1])];

function box(ring: readonly IPoint[], z0: bigint, z1: bigint): DerivedBox {
  let [x0, y0] = ring[0]!;
  let [x1, y1] = ring[0]!;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { min: [n(x0), n(y0), n(z0)], max: [n(x1), n(y1), n(z1)] };
}

const ringValue = (r: readonly IPoint[]): Point[] => startAtLeast(r).map(pt);

const setMember = <T>(obj: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
};

/**
 * 15.1, 15.5, 15.7: every room's floor and ceiling and every slab's bounding geometry, for a valid
 * document. `ringsOf` gives a room's polygon (every room of a valid document has one).
 */
export function deriveFloors(
  doc: FloorspecDocument,
  ringsOf: (id: string, room: Room) => { outer: IPoint[]; holes: IPoint[][] },
): { floors: Record<string, DerivedFloor>; ceilings: Record<string, DerivedCeiling>; slabs: Record<string, DerivedSlab> } {
  const floors: Record<string, DerivedFloor> = {};
  const ceilings: Record<string, DerivedCeiling> = {};
  const slabs: Record<string, DerivedSlab> = {};
  for (const [id, room] of entries(doc.rooms)) {
    const { outer, holes } = ringsOf(id, room);
    const top = floorTop(doc, room);
    const bottom = top - floorThickness(doc, room);
    setMember(floors, id, { top: n(top), bottom: n(bottom), box: box(outer, bottom, top) });
    const c = ceilingOf(room);
    const base = ceilingBase(doc, room);
    let low = base;
    let high = base;
    let tray: DerivedCeiling['tray'];
    if (c.kind === 'tray') {
      high = base + BigInt(c.depth);
      const t = trayCentre(outer, holes, BigInt(c.border))!;
      tray = { outer: ringValue(t.outer), holes: t.holes.map((h) => startAtLeast(h)).sort((a, b) => comparePoints(a[0]!, b[0]!)).map((h) => h.map(pt)) };
    } else if (c.kind === 'vaulted') {
      const r = vaultRange(base, c, outer);
      low = r.low.round();
      high = r.high.round();
    }
    setMember(ceilings, id, { kind: c.kind, low: n(low), high: n(high), box: box(outer, low, high), ...(tray && { tray }) });
  }
  for (const [id, s] of entries(doc.slabs)) {
    let ring: IPoint[] = s.boundary.map((p) => [BigInt(p[0]), BigInt(p[1])]);
    if (area2(ring) < 0n) ring = [...ring].reverse();
    const top = BigInt(get(doc.levels, s.level)!.elevation) + BigInt(s.offset ?? 0);
    const bottom = top - BigInt(s.thickness);
    setMember(slabs, id, { outline: ringValue(ring), top: n(top), bottom: n(bottom), box: box(ring, bottom, top) });
  }
  return { floors, ceilings, slabs };
}
