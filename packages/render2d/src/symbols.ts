/**
 * The plan symbols of roofs and stairs (Core 0.3, chapters 16 and 17), as geometry in base units:
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
  /** Each tread and landing in walking order, with whether it is above the cut plane (drawn dashed). */
  readonly steps: readonly { readonly outline: readonly Pt[]; readonly landing: boolean; readonly above: boolean }[];
  /** The break line across the first tread above the cut, corner to corner; null when none is. */
  readonly cut: readonly [Pt, Pt] | null;
  /** The walkline from the foot to the head (Core 17.5): the UP arrow's shaft. */
  readonly arrow: readonly Pt[];
  /** Where "UP" is written: the foot. */
  readonly up: Pt;
  /** A winder or spiral stair, whose steps Core does not derive (17.7): its box in plan, and a spiral's circle. */
  readonly bounds: readonly Pt[] | null;
  readonly circle: { readonly centre: Pt; readonly radius: number } | null;
}

export function stairSymbol(stair: DerivedStair, form: string): StairSymbol {
  const { min, max } = stair.box;
  const steps = (stair.steps ?? []).map((s) => ({ outline: s.outline, landing: s.landing === true, above: s.top - stair.bottom > CUT_HEIGHT }));
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
    circle: form === 'spiral' ? { centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2], radius: (max[0] - min[0]) / 2 } : null,
  };
}
