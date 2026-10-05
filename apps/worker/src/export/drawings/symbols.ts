/**
 * Stairs and roofs on the drawings (FLR-T-9.7), in model coordinates (base units, y up), shared by
 * the PDF sheets and the DXF files so the two never disagree.
 *
 * The geometry is render2d's (`stairSymbol`, `roofSymbol`): every tread, landing, walkline point,
 * eave vertex, ridge, hip and valley is a point the engine derived exactly. What is added here is
 * drafting, as door leaves are: the break drawn across the cut line, which treads a plan shows
 * dashed, and where a roof plan's slope arrows sit and which way they point.
 *
 * - A stair is drawn on the level it rises from: the treads below the plan's cut (4 ft, Core 17's
 *   plan convention) solid, the treads above it dashed, the cut line across the first tread above
 *   it with a break in the middle, and the UP arrow along the walkline from the foot.
 * - On the level it arrives at, the whole stair is drawn below the floor's cut, looking down into
 *   the stairwell: every tread solid and the DN arrow from the head, back along the walkline.
 * - A roof is drawn on its own level's plan as its eave outline, dashed: it is above that plan's cut.
 *   The roof plan draws it from above: eave and gable ends, ridges, hips and valleys, and a slope
 *   arrow on each pitched face pointing downhill, labelled with that face's pitch.
 */
import type { DerivedRoof, DerivedStair, FloorspecDocument } from '@floorspec/engine';
import { roofSymbol, stairSymbol, type Pt } from '@floorspec/render2d';

type XY = readonly [number, number];

export interface PlanStairStep {
  readonly outline: readonly Pt[];
  readonly landing: boolean;
  /** Drawn dashed: above the plan's cut. */
  readonly hidden: boolean;
}

export interface PlanStair {
  readonly id: string;
  /** `up` on the level it rises from; `down` on the level it arrives at. */
  readonly direction: 'up' | 'down';
  readonly form: string;
  readonly steps: readonly PlanStairStep[];
  /** The cut line with its break, as a polyline; null when no tread is above the cut (or on a `down` stair). */
  readonly cut: readonly XY[] | null;
  /** The arrow's shaft, from its tail to its head (the head gets the arrowhead). */
  readonly arrow: readonly XY[];
  readonly label: 'UP' | 'DN';
  /** The model point the label sits by: the arrow's tail. */
  readonly labelAt: XY;
  /** A winder or spiral stair, whose treads Core does not derive (17.7): its box, and a spiral's circle. */
  readonly bounds: readonly Pt[] | null;
  readonly circle: { readonly centre: Pt; readonly radius: number } | null;
}

export interface RoofSlope {
  /** The face's centroid in plan. */
  readonly at: XY;
  /** Unit, in plan: downhill. */
  readonly dir: XY;
  readonly rise: number;
  readonly run: number;
}

export interface PlanRoof {
  readonly id: string;
  readonly kind: string;
  readonly name: string | undefined;
  readonly eave: readonly Pt[];
  readonly lines: readonly { readonly kind: 'ridge' | 'hip' | 'valley'; readonly from: Pt; readonly to: Pt }[];
  readonly gables: readonly (readonly [Pt, Pt])[];
  /** False when Core does not derive the roof's surface (FS-LINT-015): only its eave outline is drawn. */
  readonly derived: boolean;
  readonly slopes: readonly RoofSlope[];
}

const round = (p: XY): XY => [Math.round(p[0]), Math.round(p[1])];

/** A straight cut line with a break (a Z) across its middle. */
export function breakLine(a: XY, b: XY): XY[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return [a, b];
  const u: XY = [dx / len, dy / len];
  const n: XY = [-u[1], u[0]];
  const at = (t: number, k: number): XY => round([a[0] + dx * t + n[0] * k * len, a[1] + dy * t + n[1] * k * len]);
  return [a, at(0.44, 0), at(0.48, 0.07), at(0.52, -0.07), at(0.56, 0), b];
}

/** A stair on a plan: rising from this level (`up`) or arriving at it (`down`). */
export function planStair(id: string, stair: DerivedStair, form: string, direction: 'up' | 'down'): PlanStair {
  const sym = stairSymbol(stair, form);
  if (direction === 'up') {
    return {
      id,
      direction,
      form,
      steps: sym.steps.map((s) => ({ outline: s.outline, landing: s.landing, hidden: s.above })),
      cut: sym.cut === null ? null : breakLine(sym.cut[0], sym.cut[1]),
      arrow: sym.arrow,
      label: 'UP',
      labelAt: sym.up,
      bounds: sym.bounds,
      circle: sym.circle,
    };
  }
  const arrow = [...sym.arrow].reverse();
  return {
    id,
    direction,
    form,
    steps: sym.steps.map((s) => ({ outline: s.outline, landing: s.landing, hidden: false })),
    cut: null,
    arrow,
    label: 'DN',
    labelAt: arrow[0] ?? stair.head,
    bounds: sym.bounds,
    circle: sym.circle,
  };
}

/** Floorspec's pitch of one footprint edge (Core 16.1): its own, else the roof's; none for a gable or a flat edge. */
function pitchOf(doc: FloorspecDocument | undefined, roofId: string, edge: number): { rise: number; run: number } | undefined {
  const roof = doc?.roofs?.[roofId];
  if (roof === undefined) return undefined;
  const e = roof.edges?.[String(edge)];
  if (e?.gable === true) return undefined;
  return e?.pitch ?? roof.pitch;
}

/** A roof on a plan, with a slope arrow on every pitched face. */
export function planRoof(doc: FloorspecDocument | undefined, id: string, roof: DerivedRoof): PlanRoof {
  const sym = roofSymbol(roof);
  const slopes: RoofSlope[] = [];
  for (const face of roof.surface?.faces ?? []) {
    if (face.edge === undefined || face.polygon.length < 3) continue;
    const pitch = pitchOf(doc, id, face.edge);
    if (pitch === undefined) continue;
    // Newell's normal; for an upward face, downhill in plan is (nx, ny).
    let nx = 0;
    let ny = 0;
    let nz = 0;
    const pts = face.polygon;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    if (nz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const h = Math.hypot(nx, ny);
    if (h === 0 || nz === 0) continue;
    // The centroid of the face's plan polygon (by area), so a triangle's arrow sits inside it.
    let a2 = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[(i + 1) % pts.length]!;
      const c = p[0] * q[1] - q[0] * p[1];
      a2 += c;
      cx += (p[0] + q[0]) * c;
      cy += (p[1] + q[1]) * c;
    }
    const at: XY = a2 === 0 ? [pts[0]![0], pts[0]![1]] : [cx / (3 * a2), cy / (3 * a2)];
    slopes.push({ at: round(at), dir: [nx / h, ny / h], rise: pitch.rise, run: pitch.run });
  }
  return { id, kind: roof.kind, name: doc?.roofs?.[id]?.name, eave: sym.eave, lines: sym.lines, gables: sym.gables, derived: sym.derived, slopes };
}

/** A pitch as a drawing prints it: rise in 12 for imperial (`6:12`), degrees for metric (`26.6°`). */
export function pitchText(rise: number, run: number, units: 'imperial' | 'metric'): string {
  if (units === 'metric') return `${((Math.atan2(rise, run) * 180) / Math.PI).toFixed(1)}°`;
  const in12 = Math.round(((rise * 12) / run) * 10) / 10;
  return `${String(in12)}:12`;
}

/** Stairs arriving at a level: every stair of the document whose `to` is it. */
export function arrivingStairs(doc: FloorspecDocument, derived: { stairs?: Record<string, DerivedStair> }, level: string): Map<string, { derived: DerivedStair; form: string }> {
  const out = new Map<string, { derived: DerivedStair; form: string }>();
  for (const id of Object.keys(doc.stairs ?? {}).sort()) {
    const st = doc.stairs![id]!;
    const d = derived.stairs?.[id];
    if (st.to === level && st.level !== level && d !== undefined) out.set(id, { derived: d, form: st.form?.kind ?? 'straight' });
  }
  return out;
}
