/**
 * Exterior dimension strings (FLR-T-9.3), computed from the derived wall outline.
 *
 * Each side of the building gets up to three strings, nearest first:
 *   0. openings — the outside corners on that side and the centre line of every door and window in
 *      an exterior wall that faces it (only when there are some);
 *   1. wall segments — every corner of the outline seen from that side (only when there is a jog);
 *   2. overall — the building's extent.
 *
 * A point is on a side's string when it is the end of an outline edge that faces that side and
 * that nothing else on the outline hides (a ray from its midpoint outwards crosses no other edge).
 * Coordinates are the engine's integers; every printed length is their difference, formatted once.
 */
import type { Pt } from '@floorspec/render2d';
import type { Box, LevelPlan, OutlineEdge, XY } from './plan.js';
import { axes, insideRings } from './plan.js';

export type Side = 'N' | 'S' | 'E' | 'W';

export interface DimString {
  readonly side: Side;
  /** 0 nearest the building. Consecutive per side, from 0. */
  readonly tier: number;
  readonly kind: 'openings' | 'segments' | 'overall';
  /** The building face this string is measured off: max y for N, min y for S, max x for E, min x for W. */
  readonly base: number;
  /** Positions along the string's axis (x for N and S, y for E and W), ascending, distinct, integers. */
  readonly points: readonly number[];
  /**
   * For each point, where its feature is across the axis (y for N and S, x for E and W): the
   * extension line runs from there out to the string.
   */
  readonly reach: readonly number[];
}

const SIDES: readonly Side[] = ['N', 'S', 'E', 'W'];

/** The outward normal's direction a side faces, and which coordinate its string runs along. */
const OUT: Readonly<Record<Side, XY>> = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] };

function crosses(o: XY, d: XY, a: Pt, b: Pt): boolean {
  // Ray o + t·d (t > 0) against segment ab.
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const den = d[0] * ey - d[1] * ex;
  if (den === 0) return false;
  const t = ((a[0] - o[0]) * ey - (a[1] - o[1]) * ex) / den;
  const s = ((a[0] - o[0]) * d[1] - (a[1] - o[1]) * d[0]) / den;
  return t > 1e-6 && s >= 0 && s <= 1;
}

/** The outline edges seen from a side: facing it, and not hidden by another part of the outline. */
export function visibleEdges(outline: readonly OutlineEdge[], side: Side): OutlineEdge[] {
  const d = OUT[side];
  return outline.filter((e) => {
    const dx = e.b[0] - e.a[0];
    const dy = e.b[1] - e.a[1];
    // Material on the left of a→b: outward is the right normal (dy, −dx).
    if (dy * d[0] - dx * d[1] <= 0) return false;
    const m: XY = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    return !outline.some((f) => f !== e && crosses(m, d, f.a, f.b));
  });
}

/**
 * The outline's corners: vertices where it turns. A vertex where two collinear edges meet — a
 * junction along a straight face — is not a corner and is not dimensioned.
 */
export function corners(outline: readonly OutlineEdge[]): Set<string> {
  const k = (p: XY): string => `${p[0]},${p[1]}`;
  const incoming = new Map<string, OutlineEdge>();
  for (const e of outline) incoming.set(k(e.b), e);
  const out = new Set<string>();
  for (const e of outline) {
    const prev = incoming.get(k(e.a));
    if (prev === undefined) {
      out.add(k(e.a));
      continue;
    }
    const cross = (BigInt(prev.b[0]) - BigInt(prev.a[0])) * (BigInt(e.b[1]) - BigInt(e.a[1])) - (BigInt(prev.b[1]) - BigInt(prev.a[1])) * (BigInt(e.b[0]) - BigInt(e.a[0]));
    if (cross !== 0n) out.add(k(e.a));
  }
  return out;
}

const along = (side: Side, p: XY): number => (side === 'N' || side === 'S' ? p[0] : p[1]);

function distinct(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** The dimension strings of one level's plan: per side, nearest the building first. */
export function dimensionStrings(plan: LevelPlan): DimString[] {
  const body: Box | undefined = plan.body;
  if (body === undefined || plan.outline.length === 0) return [];
  const rooms = plan.rooms.map((r) => [r.outer, ...r.holes]);
  const inside = (p: XY): boolean => rooms.some((rings) => insideRings(p[0], p[1], rings));

  // Exterior openings, by the side their outside faces.
  const openingCentres = new Map<Side, number[]>(SIDES.map((s) => [s, []]));
  // Per side: along → the across coordinate of the outermost feature there.
  const reach = new Map<Side, Map<number, number>>(SIDES.map((s) => [s, new Map()]));
  const across = (side: Side, p: XY): number => (side === 'N' || side === 'S' ? p[1] : p[0]);
  const note = (side: Side, at: number, value: number): void => {
    const m = reach.get(side)!;
    const prior = m.get(at);
    const outward = side === 'N' || side === 'E';
    if (prior === undefined || (outward ? value > prior : value < prior)) m.set(at, value);
  };
  for (const o of plan.scene.openings.values()) {
    if (o.kind === 'opening') continue;
    const w = plan.scene.walls.get(o.wall);
    if (!w) continue;
    const { n } = axes(w.start, w.end);
    const mid: XY = [(o.start[0] + o.end[0]) / 2, (o.start[1] + o.end[1]) / 2];
    const outL: XY = [mid[0] + n[0] * (w.a + 97_536), mid[1] + n[1] * (w.a + 97_536)];
    const outR: XY = [mid[0] - n[0] * (w.b + 97_536), mid[1] - n[1] * (w.b + 97_536)];
    const leftOut = !inside(outL);
    const rightOut = !inside(outR);
    if (leftOut === rightOut) continue; // interior, or a wall standing free
    const out: XY = leftOut ? n : [-n[0], -n[1]];
    const side: Side = Math.abs(out[0]) > Math.abs(out[1]) ? (out[0] > 0 ? 'E' : 'W') : out[1] > 0 ? 'N' : 'S';
    // The opening must also be on the visible face: the ray outward from it meets no other wall.
    const face: XY = leftOut ? outL : outR;
    if (plan.outline.some((f) => crosses(face, OUT[side], f.a, f.b))) continue;
    const at = Math.round(along(side, mid));
    openingCentres.get(side)!.push(at);
    const wallFace: XY = leftOut ? [mid[0] + n[0] * w.a, mid[1] + n[1] * w.a] : [mid[0] - n[0] * w.b, mid[1] - n[1] * w.b];
    note(side, at, Math.round(across(side, wallFace)));
  }

  const turns = corners(plan.outline);
  const out: DimString[] = [];
  for (const side of SIDES) {
    const lo = side === 'N' || side === 'S' ? body.minX : body.minY;
    const hi = side === 'N' || side === 'S' ? body.maxX : body.maxY;
    const base = side === 'N' ? body.maxY : side === 'S' ? body.minY : side === 'E' ? body.maxX : body.minX;
    const seen = visibleEdges(plan.outline, side).flatMap((e) => [e.a, e.b].filter((p) => turns.has(`${p[0]},${p[1]}`)));
    for (const p of seen) note(side, along(side, p), across(side, p));
    const points = distinct([lo, hi, ...seen.map((p) => along(side, p))]);
    const centres = openingCentres.get(side)!;
    const m = reach.get(side)!;
    const with_ = (pts: number[]): { points: number[]; reach: number[] } => ({ points: pts, reach: pts.map((v) => m.get(v) ?? base) });
    const strings: Omit<DimString, 'tier'>[] = [];
    if (centres.length > 0) strings.push({ side, kind: 'openings', base, ...with_(distinct([...points, ...centres])) });
    if (points.length > 2) strings.push({ side, kind: 'segments', base, ...with_(points) });
    if (hi > lo) strings.push({ side, kind: 'overall', base, ...with_([lo, hi]) });
    strings.forEach((s, tier) => out.push({ ...s, tier }));
  }
  return out;
}
