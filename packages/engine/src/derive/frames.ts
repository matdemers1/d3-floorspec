/**
 * Frames, boxes, footprints and the overlap measure (Core 0.2, chapter 13).
 *
 * A frame has an exact origin (Surd coordinates), an integer elevation and an integer facing
 * vector f. A local point (p, q) maps to O + (p·f + q·rot90(f)) / |f|, so every footprint corner
 * is of the form a + b·√|f|² (plus the wall's radicand for a wall frame — the same one, since a
 * wall frame faces along its normal) and is rounded once, exactly (2.2). The two transcendental
 * values, F(θ) and the direction of a vector, are in exact/angle.ts.
 */
import { facingVector, direction } from '../exact/angle.js';
import { Surd } from '../exact/surd.js';
import { toSafeNumber } from '../exact/bigint.js';
import type { IPoint } from '../geometry/predicates.js';
import { startAtLeast } from './level.js';
import { get, ipoint, openingDimensions, wallArc, wallElevations, type Box, type ExtensionElement, type FloorspecDocument, type Host } from '../model/document.js';
import { pointAt, primitive, segmentAt } from '../geometry/arcs.js';
import { Q } from '../exact/rational.js';
import type { Analysis } from '../validate/invariants.js';
import { roomRings, surfaceElevation } from '../slabs/floors.js';

export interface Frame {
  readonly ox: Surd;
  readonly oy: Surd;
  readonly oz: bigint;
  /** The facing vector: integers, not both zero. */
  readonly f: IPoint;
}

/** The exact plan point of local (p, q) in a frame (13.1). */
export function planPoint(fr: Frame, p: bigint, q: bigint): { x: Surd; y: Surd } {
  const [fx, fy] = fr.f;
  const D = fx * fx + fy * fy;
  const k = Surd.sqrt(D);
  return { x: fr.ox.add(k.mulInt(p * fx - q * fy).divInt(D)), y: fr.oy.add(k.mulInt(p * fy + q * fx).divInt(D)) };
}

/** 13.4: a frame reported as a placement — its origin, rounded in plan, and the direction it faces. */
export interface Placement {
  point: [number, number, number];
  facing: number;
}

export function placementOf(fr: Frame): Placement {
  return { point: [toSafeNumber(fr.ox.round()), toSafeNumber(fr.oy.round()), toSafeNumber(fr.oz)], facing: direction(fr.f[0], fr.f[1]) };
}

export function levelFrame(doc: FloorspecDocument, level: string): Frame {
  return { ox: Surd.ZERO, oy: Surd.ZERO, oz: BigInt(get(doc.levels, level)!.elevation), f: [1n, 0n] };
}

interface WallLine {
  readonly S: IPoint;
  readonly d: IPoint;
  readonly D: bigint;
}

function wallLine(doc: FloorspecDocument, wid: string): WallLine {
  const w = get(doc.walls, wid)!;
  const S = ipoint(get(doc.junctions, w.start)!.position);
  const E = ipoint(get(doc.junctions, w.end)!.position);
  const d: IPoint = [E[0] - S[0], E[1] - S[1]];
  return { S, d, D: d[0] * d[0] + d[1] * d[1] };
}

/** S + (along2·t + normal2·m) / 2, with t and m the unit vectors along the wall and to its left. */
function wallPoint(l: WallLine, along2: bigint, normal2: bigint): { x: Surd; y: Surd } {
  const k = Surd.sqrt(l.D);
  const [dx, dy] = l.d;
  return {
    x: k.mulInt(along2 * dx - normal2 * dy).divInt(2n * l.D).addInt(l.S[0]),
    y: k.mulInt(along2 * dy + normal2 * dx).divInt(2n * l.D).addInt(l.S[1]),
  };
}

/**
 * 21.6: on an arc wall, the point at distance `along` on its polyline moved `normal2 / 2` along the unit left
 * normal of the segment that distance falls on, and that segment's left normal.
 */
function arcWallPoint(poly: readonly IPoint[], along: bigint, normal2: bigint): { x: Surd; y: Surd; n: IPoint } {
  const at = segmentAt(poly, Q.of(along))!;
  const a = poly[at.k]!;
  const b = poly[at.k + 1]!;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const D = dx * dx + dy * dy;
  const [px, py] = pointAt(poly, Q.of(along));
  const k = Surd.sqrt(D).mulInt(normal2).divInt(2n * D);
  return { x: px.toSurd().add(k.mulInt(-dy)), y: py.toSurd().add(k.mulInt(dx)), n: [-dy, dx] };
}

/** 13.1: the frame of a host. The document is valid, so its wall has face offsets. */
export function hostFrame(doc: FloorspecDocument, analysis: Analysis, host: Host): Frame {
  const arc = host.mode === 'wallFace' ? wallArc(doc, host.wall) : undefined;
  if (host.mode === 'wallFace' && arc && arc !== 'unfit') {
    const off = analysis.offsets.get(host.wall)!;
    const left = host.side === 'left';
    const o = arcWallPoint(arc, BigInt(host.offset), left ? off.a2 : -off.b2);
    const base = wallElevations(doc, get(doc.walls, host.wall)!)!.base;
    return { ox: o.x, oy: o.y, oz: base + BigInt(host.height), f: left ? o.n : [-o.n[0], -o.n[1]] };
  }
  if (host.mode === 'wallFace') {
    const l = wallLine(doc, host.wall);
    const off = analysis.offsets.get(host.wall)!;
    const [dx, dy] = l.d;
    const left = host.side === 'left';
    const o = wallPoint(l, 2n * BigInt(host.offset), left ? off.a2 : -off.b2);
    const base = wallElevations(doc, get(doc.walls, host.wall)!)!.base;
    return { ox: o.x, oy: o.y, oz: base + BigInt(host.height), f: left ? [-dy, dx] : [dy, -dx] };
  }
  const f = facingVector(host.rotation ?? 0);
  const [x, y] = host.position;
  if (host.mode === 'surface') {
    // 15.6: on the room's floor, or under its ceiling at the host's position (for a document of an
    // earlier draft: the level's elevation, or its elevation plus its height, as 13.1 said).
    const room = get(doc.rooms, host.room)!;
    const rings = () => {
      const la = analysis.levels.get(room.level);
      const face = la?.roomFaces.get(host.room);
      return la?.geometry && face !== undefined ? roomRings(la.geometry, face) : undefined;
    };
    return { ox: Surd.of(x), oy: Surd.of(y), oz: surfaceElevation(doc, room, host.surface, host.position, rings), f };
  }
  return { ox: Surd.of(x), oy: Surd.of(y), oz: BigInt(get(doc.levels, host.level)!.elevation), f };
}

/** 13.1: the frame of an opening — on the location line at its middle, facing the side it swings to. */
export function openingFrame(doc: FloorspecDocument, oid: string): Frame {
  const o = get(doc.openings, oid)!;
  const dim = openingDimensions(doc, o);
  const arc = wallArc(doc, o.wall);
  if (arc && arc !== 'unfit') {
    // 21.6: at the middle of the opening's chord, facing across it.
    const s = pointAt(arc, Q.of(BigInt(o.offset)));
    const e = pointAt(arc, Q.of(BigInt(o.offset) + BigInt(dim.width!)));
    const c = primitive([e[0].sub(s[0]), e[1].sub(s[1])]);
    const n: IPoint = [-c[1], c[0]];
    const base = wallElevations(doc, get(doc.walls, o.wall)!)!.base;
    return {
      ox: s[0].add(e[0]).div(2n).toSurd(),
      oy: s[1].add(e[1]).div(2n).toSurd(),
      oz: base + BigInt(dim.sill),
      f: (o.swing ?? 'right') === 'left' ? n : [-n[0], -n[1]],
    };
  }
  const l = wallLine(doc, o.wall);
  const p = wallPoint(l, 2n * BigInt(o.offset) + BigInt(dim.width!), 0n);
  const [dx, dy] = l.d;
  const base = wallElevations(doc, get(doc.walls, o.wall)!)!.base;
  return { ox: p.x, oy: p.y, oz: base + BigInt(dim.sill), f: (o.swing ?? 'right') === 'left' ? [-dy, dx] : [dy, -dx] };
}

/** 12.6: an extension element's frame — its host's, or its fallback level's. */
export function elementFrame(doc: FloorspecDocument, analysis: Analysis, el: ExtensionElement): Frame {
  return el.host ? hostFrame(doc, analysis, el.host) : levelFrame(doc, el.fallback.level);
}

// ── boxes (13.2) ─────────────────────────────────────────────────────────────

export const MIN_EXTENT = 1280;

/** 13.2.2: every extent of a box at least 1,280. */
export const extentsOk = (box: Box): boolean => [0, 1, 2].every((i) => box.max[i]! - box.min[i]! >= MIN_EXTENT);

export interface Footprint {
  /** Four points, least vertex first, counter-clockwise. */
  footprint: [number, number][];
  bottom: number;
  top: number;
}

/** 13.2: a box's footprint, bottom and top in a frame — each corner mapped exactly and rounded once. */
export function footprintOf(fr: Frame, box: Box): Footprint {
  const [x0, y0, z0] = box.min.map(BigInt) as [bigint, bigint, bigint];
  const [x1, y1, z1] = box.max.map(BigInt) as [bigint, bigint, bigint];
  const corners: [bigint, bigint][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const ring = startAtLeast(
    corners.map(([p, q]): IPoint => {
      const pt = planPoint(fr, p, q);
      return [pt.x.round(), pt.y.round()];
    }),
  );
  for (let i = 0; i < 4; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % 4]!;
    const c = ring[(i + 2) % 4]!;
    // 13.2: every extent ≥ 1,280 and rounding moves a point by less than one unit, so this holds.
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0n) throw new Error('footprint: not strictly convex and counter-clockwise');
  }
  return {
    footprint: ring.map((p) => [toSafeNumber(p[0]), toSafeNumber(p[1])]),
    bottom: toSafeNumber(fr.oz + z0),
    top: toSafeNumber(fr.oz + z1),
  };
}

// ── the overlap measure (13.6) ───────────────────────────────────────────────

function project(ring: readonly (readonly [number, number])[], axis: readonly [bigint, bigint]): [bigint, bigint] {
  let lo: bigint | undefined;
  let hi: bigint | undefined;
  for (const p of ring) {
    const v = BigInt(p[0]) * axis[0] + BigInt(p[1]) * axis[1];
    if (lo === undefined || v < lo) lo = v;
    if (hi === undefined || v > hi) hi = v;
  }
  return [lo!, hi!];
}

/** 13.6: do the interiors of two convex rings intersect? Separating axes on every edge normal. */
export function footprintsOverlap(r1: readonly (readonly [number, number])[], r2: readonly (readonly [number, number])[]): boolean {
  for (const ring of [r1, r2]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const axis: [bigint, bigint] = [BigInt(a[1]) - BigInt(b[1]), BigInt(b[0]) - BigInt(a[0])];
      const [lo1, hi1] = project(r1, axis);
      const [lo2, hi2] = project(r2, axis);
      if ((lo1 > lo2 ? lo1 : lo2) >= (hi1 < hi2 ? hi1 : hi2)) return false;
    }
  }
  return true;
}

/** 13.6: two envelopes overlap — footprints' interiors meet and vertical ranges overlap by a positive length. */
export function envelopesOverlap(a: Footprint, b: Footprint): boolean {
  return Math.max(a.bottom, b.bottom) < Math.min(a.top, b.top) && footprintsOverlap(a.footprint, b.footprint);
}
