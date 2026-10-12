/**
 * Plan geometry for staging: frames, rectangles and the interference test FS_furniture 4.5 uses —
 * the interiors of two footprints intersect and their vertical ranges overlap by a positive length
 * — on convex footprints by separating axes. Everything is in base units (1/1280 mm), in the
 * document's frame; the arithmetic is + − × ÷ and square roots, each correctly rounded in every
 * JavaScript engine, and a position written to a batch is rounded once, so the same plan gives the
 * same batch everywhere.
 */
import { facingVector } from '@floorspec/engine';

export const MM = 1280;

export type P = readonly [number, number];

/** A frame on the plan: its origin, and its facing as a unit vector and in microdegrees (Core 13.1). */
export interface Frame {
  readonly origin: P;
  /** Microdegrees, as a host's `rotation` takes it. */
  readonly facing: number;
  /** cos and sin of the facing. */
  readonly f: P;
}

/** The frame at a point facing an angle (microdegrees). */
export function frameAt(origin: P, facing: number): Frame {
  const [c, s] = facingVector(facing);
  return { origin, facing, f: [Number(c) / 1e9, Number(s) / 1e9] };
}

/** A local point (u forward, v to the left) of a frame, on the plan. */
export function toPlan(fr: Frame, u: number, v: number): P {
  const [fx, fy] = fr.f;
  return [fr.origin[0] + u * fx - v * fy, fr.origin[1] + u * fy + v * fx];
}

/** A plan point in a frame's local (u, v). */
export function toLocal(fr: Frame, p: P): P {
  const [fx, fy] = fr.f;
  const dx = p[0] - fr.origin[0];
  const dy = p[1] - fr.origin[1];
  return [dx * fx + dy * fy, -dx * fy + dy * fx];
}

/** The four corners on the plan of a local rectangle [u0, u1] × [v0, v1]. */
export function rectIn(fr: Frame, u0: number, v0: number, u1: number, v1: number): P[] {
  return [toPlan(fr, u0, v0), toPlan(fr, u1, v0), toPlan(fr, u1, v1), toPlan(fr, u0, v1)];
}

/** A solid's plan outline and its vertical range: what interference is tested on. */
export interface Solid {
  readonly poly: readonly P[];
  readonly bottom: number;
  readonly top: number;
}

const project = (poly: readonly P[], ax: number, ay: number): [number, number] => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of poly) {
    const d = p[0] * ax + p[1] * ay;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
};

/** Whether two convex outlines' interiors intersect by more than `slack` (base units): touching is not. */
export function polysOverlap(a: readonly P[], b: readonly P[], slack = 2): boolean {
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const ex = q[0] - p[0];
      const ey = q[1] - p[1];
      const l = Math.sqrt(ex * ex + ey * ey);
      if (l === 0) continue;
      const [a0, a1] = project(a, -ey / l, ex / l);
      const [b0, b1] = project(b, -ey / l, ex / l);
      if (Math.min(a1, b1) - Math.max(a0, b0) <= slack) return false;
    }
  return true;
}

/** FS_furniture 4.5's interference: outlines whose interiors meet, over a positive height. */
export function interferes(a: Solid, b: Solid): boolean {
  return Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom) > 0 && polysOverlap(a.poly, b.poly);
}

/** Whether a point is inside a ring (even–odd), on its edge counting as inside. */
export function inRing(p: P, ring: readonly P[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (onSegment(p, a, b)) return true;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function onSegment(p: P, a: P, b: P): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const len = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
  if (len === 0 || Math.abs(cross) / len > 2) return false;
  const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
  return dot >= -2 * len && dot <= len * len + 2 * len;
}

/** Whether two segments cross at a point inside both (not at their ends). */
export function crosses(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Whether an outline lies within a room's polygon: every corner inside its outer ring and outside its
 * holes, and no edge of it crossing theirs — so a rug never reaches round a corner into the next room.
 */
export function within(poly: readonly P[], outer: readonly P[], holes: readonly (readonly P[])[]): boolean {
  if (!poly.every((p) => inRing(p, outer))) return false;
  if (holes.some((h) => poly.some((p) => inRing(p, h)) || h.some((q) => inRing(q, poly)))) return false;
  for (const ring of [outer, ...holes])
    for (let i = 0; i < ring.length; i++)
      for (let j = 0; j < poly.length; j++) if (crosses(poly[j]!, poly[(j + 1) % poly.length]!, ring[i]!, ring[(i + 1) % ring.length]!)) return false;
  return true;
}

/** An outline grown outward by d about its centroid's lines: each edge moved out by d (a convex outline). */
export function grow(poly: readonly P[], d: number): P[] {
  const c = centroid(poly);
  const n = poly.length;
  const lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n]!;
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const l = Math.sqrt(ex * ex + ey * ey) || 1;
    let nx = -ey / l;
    let ny = ex / l;
    // Outward: away from the centroid.
    if ((p[0] - c[0]) * nx + (p[1] - c[1]) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { p: [p[0] + nx * d, p[1] + ny * d] as P, e: [ex, ey] as P };
  });
  return lines.map((a, i) => {
    const b = lines[(i + n - 1) % n]!;
    // The point where line b meets line a.
    const det = b.e[0] * a.e[1] - b.e[1] * a.e[0];
    if (det === 0) return a.p;
    const t = ((a.p[0] - b.p[0]) * a.e[1] - (a.p[1] - b.p[1]) * a.e[0]) / det;
    return [b.p[0] + b.e[0] * t, b.p[1] + b.e[1] * t] as P;
  });
}

export const centroid = (poly: readonly P[]): P => [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];

export const dist = (a: P, b: P): number => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);

/** A polygon's area (absolute), base units squared. */
export function area(poly: readonly P[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(s) / 2;
}

/** An integer plan point: what a host's `at` is written as. */
export const roundP = (p: P): [number, number] => [Math.round(p[0]), Math.round(p[1])];
