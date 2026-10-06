/**
 * The plan symbols of roofs and stairs (Core 0.3 and 0.4, chapters 16 and 17), as geometry in base units:
 * what the SVG renderer and the editor's canvas both draw, so the two never disagree. Every point
 * is one the engine derived exactly and rounded once; the only arithmetic here is choosing which
 * of them to join, and the midpoints of a few of them for an arrowhead and a label.
 */
import { facingVector, type DerivedRoof, type DerivedStair } from '@floorspec/engine';
import type { Pt } from './scene.js';

/** The plan's cut plane, 4 ft above the floor a stair rises from (1,560,576 base units). */
export const CUT_HEIGHT = 1_560_576;

export interface RoofSymbol {
  /** The eave outline (Core 16.3): drawn dashed — it is above the plan's cut. */
  readonly eave: readonly Pt[];
  /** Ridges, hips, valleys and, from Core 0.4, breaks (Core 16.5), in plan. */
  readonly lines: readonly { readonly kind: 'ridge' | 'break' | 'hip' | 'valley'; readonly from: Pt; readonly to: Pt }[];
  /** The eave edge of every gable end, drawn heavier: the roof stops above it in a vertical end. */
  readonly gables: readonly (readonly [Pt, Pt])[];
  /** False when Core does not derive this roof's surface (FS-LINT-015): only its eave outline is drawn. */
  readonly derived: boolean;
}

export function roofSymbol(roof: DerivedRoof): RoofSymbol {
  const surface = roof.surface;
  return {
    eave: roof.outline,
    lines: (surface?.lines ?? []).map((l) => ({ kind: l.kind, from: [l.from[0], l.from[1]] as Pt, to: [l.to[0], l.to[1]] as Pt })),
    gables: (surface?.gables ?? []).map((g) => [[g.polygon[0]![0], g.polygon[0]![1]], [g.polygon[1]![0], g.polygon[1]![1]]] as const),
    derived: surface !== null,
  };
}

export interface StairSymbol {
  /**
   * Each tread and landing in walking order, with whether it is above the cut plane (drawn dashed) —
   * a winder stair's winders and a spiral's tapered treads among them (Core 0.4, 17.7), each marked.
   */
  readonly steps: readonly { readonly outline: readonly Pt[]; readonly landing: boolean; readonly above: boolean; readonly winder: boolean }[];
  /** The break line across the first tread above the cut, corner to corner; null when none is. */
  readonly cut: readonly [Pt, Pt] | null;
  /** The walkline from the foot to the head (Core 17.5): the UP arrow's shaft. */
  readonly arrow: readonly Pt[];
  /** Where "UP" is written: the foot. */
  readonly up: Pt;
  /** A winder or spiral stair whose steps are not derived (read as Core 0.3 reads it, 17.7): its box in plan. */
  readonly bounds: readonly Pt[] | null;
  /** A spiral stair's outer circle — its treads' outer sides are chords of it — about its centre. */
  readonly circle: { readonly centre: Pt; readonly radius: number } | null;
  /** A spiral stair's centre column, when its treads leave one (a radius > 0): drawn solid. */
  readonly column: { readonly centre: Pt; readonly radius: number } | null;
  /** A winder stair's newel (Core 0.4, 17.7), when it has one and its steps are derived: drawn solid. */
  readonly newel: readonly Pt[] | null;
  /**
   * Where the floor above must be open from (Core 0.4, 17.6): the front edge of the first step that
   * needs the opening, across the stair; null when the stair declares no design headroom or no step needs it.
   */
  readonly opening: readonly [Pt, Pt] | null;
  /**
   * The way out of the stair from its foot, a unit vector in plan (back down its first flight), and
   * how far along it, in base units, the stair and its box still reach: "UP" is written beyond that,
   * so it never sits on the stair or its box — a half-turn winder's second flight can run past the foot.
   */
  readonly away: Pt;
  readonly clear: number;
  /**
   * Every way out of the stair "UP" may be written along, best first: back down the first flight
   * (`away`, `clear`), then to its left and its right, then past its head — each with how far the
   * stair and its box reach along it. A drawing takes the first whose label lands clear of the walls.
   */
  readonly ups: readonly { readonly away: Pt; readonly clear: number }[];
}

/** The plan rectangle of a winder stair's newel (Core 0.4, 17.7), or null when it has none. */
export interface NewelSource {
  readonly position: readonly [number, number];
  readonly rotation?: number | undefined;
  readonly width: number;
  readonly tread: number;
  readonly form?: { readonly kind: string; readonly turn?: string; readonly angle?: string; readonly risersBeforeTurn?: number; readonly gap?: number; readonly newel?: number } | undefined;
}

/**
 * A winder stair's newel in plan (Core 0.4, 17.7): the rectangle N, `P ≤ p ≤ P + a`,
 * `w/2 − a ≤ q ≤ k` in the stair's frame (17.3) — `k` is `w/2` for a quarter turn and `w/2 + g + a`
 * for a half — mirrored for a stair that turns right. Null for any other stair, or a winder without
 * one. Its corners are placed with the frame's exact facing vector (13.1) and are only drawn.
 */
export function newelOutline(stair: NewelSource): readonly Pt[] | null {
  const f = stair.form;
  if (f?.kind !== 'winder' || f.newel === undefined || !(f.newel > 0)) return null;
  const [fx, fy] = facingVector(stair.rotation ?? 0);
  const k = Math.sqrt(Number(fx) * Number(fx) + Number(fy) * Number(fy));
  const u: Pt = [Number(fx) / k, Number(fy) / k];
  const v: Pt = [-u[1], u[0]];
  const w = stair.width;
  const a = f.newel;
  const g = f.angle === 'half' ? (f.gap ?? 0) : 0;
  const P = ((f.risersBeforeTurn ?? 1) - 1) * stair.tread;
  const side = f.turn === 'right' ? -1 : 1;
  const top = f.angle === 'half' ? w / 2 + g + a : w / 2;
  const at = (p: number, q: number): Pt => [stair.position[0] + p * u[0] + side * q * v[0], stair.position[1] + p * u[1] + side * q * v[1]];
  return [at(P, w / 2 - a), at(P + a, w / 2 - a), at(P + a, top), at(P, top)];
}

/**
 * The plan symbol of a stair. `column` is a spiral stair's column radius, its diameter / 2 less its
 * width (Core 17.7): what the steps leave at its centre.
 */
export function stairSymbol(stair: DerivedStair, form: string, column = 0, newel: readonly Pt[] | null = null): StairSymbol {
  const { min, max } = stair.box;
  const steps = (stair.steps ?? []).map((s) => ({ outline: s.outline, landing: s.landing === true, above: s.top - stair.bottom > CUT_HEIGHT, winder: s.winder === true || form === 'spiral' }));
  const first = steps.find((s) => s.above && !s.landing);
  const cut: readonly [Pt, Pt] | null = first === undefined ? null : [first.outline[0]!, first.outline[2]!];
  const box: Pt[] = [
    [min[0], min[1]],
    [max[0], min[1]],
    [max[0], max[1]],
    [min[0], max[1]],
  ];
  const derived = stair.steps !== undefined;
  const arrow = stair.walkline?.points ?? [stair.foot, stair.head];
  const circle = form === 'spiral' ? { centre: stair.centre ?? ([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2] as Pt), radius: (max[0] - min[0]) / 2 } : null;
  const bounds = derived ? null : box;
  const back = awayFrom(stair, arrow);
  // Beyond every corner of the stair's box (what its selection outlines) and every step.
  const ups = ([back, [-back[1], back[0]], [back[1], -back[0]], [-back[0], -back[1]]] as Pt[]).map((d) => {
    let reach = 0;
    const along = (p: Pt): number => (p[0] - stair.foot[0]) * d[0] + (p[1] - stair.foot[1]) * d[1];
    for (const p of box) reach = Math.max(reach, along(p));
    for (const s of steps) for (const p of s.outline) reach = Math.max(reach, along(p));
    return { away: d, clear: reach };
  });
  const { away, clear } = ups[0]!;
  return {
    steps,
    cut,
    arrow,
    up: stair.foot,
    bounds,
    circle,
    column: form === 'spiral' && column > 0 ? { centre: circle?.centre ?? stair.foot, radius: column } : null,
    newel: derived ? newel : null,
    opening: openingEdge(stair),
    away,
    clear,
    ups,
  };
}

/**
 * Where "UP" is written for a stair, in plan: its centre, a few pixels beyond the stair along the
 * first of its `ups` whose label — about 16 × 10 px, `px` base units to the pixel — lies on none of
 * `solids` (the level's wall and junction pieces); else along the first. So a spiral against a wall
 * writes it beside the stair rather than on the wall.
 */
export function upPlacement(sym: Pick<StairSymbol, 'up' | 'ups'>, solids: readonly (readonly Pt[])[], px: number): { readonly at: Pt; readonly away: Pt } {
  const inside = (x: number, y: number): boolean =>
    solids.some((r) => {
      let hit = false;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i]!;
        const [xj, yj] = r[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    });
  const hx = 8 * px;
  const hy = 5 * px;
  const place = (u: { readonly away: Pt; readonly clear: number }): Pt => {
    // Past the stair by a gap, and by the label's half-width or half-height, whichever it faces.
    const d = u.clear + (5 + 8 * Math.abs(u.away[0]) + 6 * Math.abs(u.away[1])) * px;
    return [sym.up[0] + u.away[0] * d, sym.up[1] + u.away[1] * d];
  };
  for (const u of sym.ups) {
    const [x, y] = place(u);
    const corners: Pt[] = [[x, y], [x - hx, y - hy], [x + hx, y - hy], [x + hx, y + hy], [x - hx, y + hy]];
    if (!corners.some(([cx, cy]) => inside(cx, cy))) return { at: [x, y], away: u.away };
  }
  const first = sym.ups[0] ?? { away: [0, -1] as Pt, clear: 0 };
  return { at: place(first), away: first.away };
}

/** Back down the stair's first flight from its foot: against the walkline's first leg, else the foot-to-head line. */
function awayFrom(stair: DerivedStair, arrow: readonly Pt[]): Pt {
  for (const [a, b] of [[arrow[0], arrow[1]], [stair.foot, stair.head]] as const) {
    if (a === undefined || b === undefined) continue;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) return [-dx / len, -dy / len];
  }
  return [0, -1];
}

/**
 * The front edge of the first step the floor above must be open over (Core 0.4, 17.6): the two
 * corners it shares with the step below it, farthest apart; for the first step, its edge nearest the foot.
 */
function openingEdge(stair: DerivedStair): readonly [Pt, Pt] | null {
  const i = stair.opening?.first;
  const steps = stair.steps;
  if (i === undefined || steps === undefined || i >= steps.length) return null;
  const ring = steps[i]!.outline;
  const below = i > 0 ? steps[i - 1]!.outline : null;
  if (below !== null) {
    const shared = ring.filter((p) => below.some((q) => q[0] === p[0] && q[1] === p[1]));
    let best: [Pt, Pt] | null = null;
    let far = -1;
    for (let a = 0; a < shared.length; a++)
      for (let b = a + 1; b < shared.length; b++) {
        const d = (shared[a]![0] - shared[b]![0]) ** 2 + (shared[a]![1] - shared[b]![1]) ** 2;
        if (d > far) [far, best] = [d, [shared[a]!, shared[b]!]];
      }
    if (best !== null && far > 0) return best;
  }
  // The edge whose middle is nearest the step below (or, for the first step, the foot).
  const to: Pt = below === null ? stair.foot : centroid(below);
  let edge: [Pt, Pt] | null = null;
  let near = Infinity;
  for (let a = 0; a < ring.length; a++) {
    const p = ring[a]!;
    const q = ring[(a + 1) % ring.length]!;
    const d = ((p[0] + q[0]) / 2 - to[0]) ** 2 + ((p[1] + q[1]) / 2 - to[1]) ** 2;
    if (d < near) [near, edge] = [d, [p, q]];
  }
  return edge;
}

function centroid(ring: readonly Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) [x, y] = [x + p[0], y + p[1]];
  return [x / ring.length, y / ring.length];
}

/** A spiral stair's column radius (Core 17.7): its diameter / 2 less its width; 0 for every other stair. */
export function columnRadius(stair: { readonly width: number; readonly form?: { readonly kind: string; readonly diameter?: number } }): number {
  const f = stair.form;
  return f?.kind === 'spiral' && f.diameter !== undefined ? Math.max(0, f.diameter / 2 - stair.width) : 0;
}
