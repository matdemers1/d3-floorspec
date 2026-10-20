import { xrayPlan, XRAY_SYSTEMS, type XrayPlan, type XraySystem } from '@floorspec/mesh';
import type { Derived, FloorspecDocument } from '@floorspec/engine';
import type { ModeId } from '@floorspec/render2d';

/**
 * X-ray (FLR-T-14.5, the board's "14.5 · X-ray — inside the kitchen wall"): the house's finishes faded
 * and what is inside its walls, floors and ceilings drawn — framing, insulation, supply, drain and
 * vent, wiring and ducts, each toggled on its own — as @floorspec/mesh derives them (xrayPlan).
 *
 * **One colour per system, in 2D and in 3D.** Each system is drawn in the colour its trade has in the
 * plan's trade modes (FLR-T-18.3, modes.css, Okabe-Ito based and tested for colour-blind people in
 * test/colourblind.test.ts): framing in Construction's orange, plumbing — supply and drain alike — in
 * Plumbing's sky blue, wiring in Electrical's yellow, ducts in Mechanical's vermillion. Insulation has no
 * trade of its own in the plan; it takes the reddish purple (the Okabe-Ito colour no X-ray system
 * otherwise uses; the plan's Decorator). The designer's per-system colours (warning, pink, info, muted,
 * danger, success) gave way to these, so a colour means one thing everywhere (FLR-ADR-056).
 *
 * **Colour is never the only cue.** Every system has its own shape in 3D and its own pattern in the
 * legend, and its name: studs are boxes (a solid bar), batts translucent sheets (a zigzag), supply a
 * thin pipe (a line), drains a thicker pipe in 6″ dashes with the muted colour (a dashed line) — which
 * is what tells supply from drain, both being plumbing's blue — wiring a thin cable to a box at each
 * device (a line with dots), ducts rectangular (a double line).
 */

export interface XrayState {
  /** X-ray is on: the finishes fade, the systems are drawn, and its panel is open. */
  readonly on: boolean;
  /** How far the finishes fade, 0–1: the panel's "Fade finishes". */
  readonly fade: number;
  /** Which systems are drawn. */
  readonly systems: Readonly<Record<XraySystem, boolean>>;
}

export const DEFAULT_XRAY: XrayState = {
  on: false,
  fade: 0.7,
  systems: { framing: true, insulation: true, supply: true, drain: true, electrical: true, ducts: true },
};

/** How a system's swatch is drawn in the legend: its non-colour cue. */
export type XrayPattern = 'bar' | 'zigzag' | 'line' | 'dash' | 'dots' | 'double';

export interface XraySystemLook {
  readonly label: string;
  /** The trade mode whose colour it is drawn in (modes.css `--fs-mode-<trade>`). */
  readonly trade: ModeId;
  readonly pattern: XrayPattern;
}

export const XRAY_LOOKS: Readonly<Record<XraySystem, XraySystemLook>> = {
  framing: { label: 'Framing', trade: 'construction', pattern: 'bar' },
  insulation: { label: 'Insulation', trade: 'decorator', pattern: 'zigzag' },
  supply: { label: 'Plumbing · supply', trade: 'plumbing', pattern: 'line' },
  drain: { label: 'Plumbing · drain and vent', trade: 'plumbing', pattern: 'dash' },
  electrical: { label: 'Electrical', trade: 'electrical', pattern: 'dots' },
  ducts: { label: 'Ducts', trade: 'mechanical', pattern: 'double' },
};

export { XRAY_SYSTEMS };

/** The CSS custom property a system's colour is in. */
export const colourVar = (system: XraySystem): string => `--fs-mode-${XRAY_LOOKS[system].trade}`;

/** What each system's row counts: "412 studs", "38 runs", "14 circuits". */
export function countOf(plan: XrayPlan, system: XraySystem): string {
  const c = plan.counts;
  const n = (k: number, one: string, many: string) => `${k.toLocaleString('en-US')} ${k === 1 ? one : many}`;
  switch (system) {
    case 'framing': return n(c.studs, 'stud', 'studs');
    case 'insulation': return n(c.batts, 'batt', 'batts');
    case 'supply': return n(c.supply, 'run', 'runs');
    case 'drain': return n(c.drain + c.vents + c.stacks, 'run', 'runs');
    case 'electrical': return n(c.circuits, 'circuit', 'circuits');
    case 'ducts': return c.ducts === 0 ? 'none' : n(c.ducts, 'run', 'runs');
  }
}

/** The plan of a derivation, made once: the 3D view and the inspector share it. */
const plans = new WeakMap<Derived, XrayPlan>();
export function planOf(doc: FloorspecDocument, derived: Derived): XrayPlan {
  let p = plans.get(derived);
  if (p === undefined) {
    p = xrayPlan(doc, derived);
    plans.set(derived, p);
  }
  return p;
}
