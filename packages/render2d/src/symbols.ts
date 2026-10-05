/**
 * The plan symbols of roofs and stairs (Core 0.3 and 0.4, chapters 16 and 17), as geometry in base units:
 * what the SVG renderer and the editor's canvas both draw, so the two never disagree. Every point
 * is one the engine derived exactly and rounded once; the only arithmetic here is choosing which
 * of them to join, and the midpoints of a few of them for an arrowhead and a label.
 */
import type { DerivedRoof, DerivedStair } from '@floorspec/engine';
import type { Pt } from './scene.js';

/** The plan's cut plane, 4 ft above the floor a stair rises from (1,560,576 base units). */
export const CUT_HEIGHT = 1_560_576;

export interface RoofSymbol {
  /** The eave outline (Core 16.3): drawn dashed — it is above the plan's cut. */
  readonly eave: readonly Pt[];
  /** Ridges, hips and valleys (Core 16.5), in plan. */
  readonly lines: readonly { readonly kind: 'ridge' | 'hip' | 'valley'; readonly from: Pt; readonly to: Pt }[];
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
}

/**
 * The plan symbol of a stair. `column` is a spiral stair's column radius, its diameter / 2 less its
 * width (Core 17.7): what the steps leave at its centre.
 */
export function stairSymbol(stair: DerivedStair, form: string, column = 0): StairSymbol {
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
  return {
    steps,
    cut,
    arrow: stair.walkline?.points ?? [stair.foot, stair.head],
    up: stair.foot,
    bounds: derived ? null : box,
    circle: form === 'spiral' ? { centre: stair.centre ?? [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2], radius: (max[0] - min[0]) / 2 } : null,
    column: form === 'spiral' && column > 0 ? { centre: stair.centre ?? [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2], radius: column } : null,
  };
}

/** A spiral stair's column radius (Core 17.7): its diameter / 2 less its width; 0 for every other stair. */
export function columnRadius(stair: { readonly width: number; readonly form?: { readonly kind: string; readonly diameter?: number } }): number {
  const f = stair.form;
  return f?.kind === 'spiral' && f.diameter !== undefined ? Math.max(0, f.diameter / 2 - stair.width) : 0;
}
