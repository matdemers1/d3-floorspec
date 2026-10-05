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
import { get, ipoint, openingDimensions, wallElevations, type Box, type ExtensionElement, type FloorspecDocument, type Host } from '../model/document.js';
import type { Analysis } from '../validate/invariants.js';

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

/** 13.1: the frame of a host. The document is valid, so its wall has face offsets. */
export function hostFrame(doc: FloorspecDocument, analysis: Analysis, host: Host): Frame {
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
    const L = get(doc.levels, get(doc.rooms, host.room)!.level)!;
    const z = BigInt(L.elevation) + (host.surface === 'ceiling' ? BigInt(L.height) : 0n);
    return { ox: Surd.of(x), oy: Surd.of(y), oz: z, f };
  }
  return { ox: Surd.of(x), oy: Surd.of(y), oz: BigInt(get(doc.levels, host.level)!.elevation), f };
}

/** 13.1: the frame of an opening — on the location line at its middle, facing the side it swings to. */
export function openingFrame(doc: FloorspecDocument, oid: string): Frame {
  const o = get(doc.openings, oid)!;
  const dim = openingDimensions(doc, o);
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
