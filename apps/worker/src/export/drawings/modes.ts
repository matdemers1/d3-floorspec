/**
 * Drawings in a trade's view (FLR-T-18.3): an electrical plan, a furniture plan, a construction plan.
 * A mode's layer states (`@floorspec/render2d`'s MODES) split a level's plan into what is drawn as
 * usual and what is drawn as a ghost — screened, in grey, under it — and leave out what is off.
 */
import { layerOfElement, layerStates, MODES, type LayerState, type LayerStates, type ModeId, type PlanLayer } from '@floorspec/render2d';
import type { LevelPlan } from './plan.js';

/** What a drawing is asked to show: a mode, and a person's own states over it. */
export interface DrawingMode {
  readonly mode?: ModeId;
  readonly layers?: Readonly<Partial<Record<PlanLayer, LayerState>>>;
}

/** The states a drawing is made with, or null for a drawing of everything, as before modes. */
export function statesOf(asked: DrawingMode): LayerStates | null {
  return asked.mode === undefined && asked.layers === undefined ? null : layerStates(asked.mode, asked.layers);
}

/** What the drawing is called, in a sheet's title: `Electrical plan`; a person's own layers, `Plan`. */
export function modePlanName(asked: DrawingMode): string | undefined {
  if (asked.mode !== undefined) return MODES[asked.mode].plan;
  return asked.layers === undefined ? undefined : 'Plan';
}

/** A level's plan with only the layers `keep` says: walls, openings, rooms, devices by trade, stairs and roofs. */
export function planWith(plan: LevelPlan, keep: (layer: PlanLayer) => boolean): LevelPlan {
  const walls = keep('walls');
  const openings = keep('openings');
  const rooms = keep('rooms');
  const roof = keep('roof');
  return {
    ...plan,
    pieces: walls ? plan.pieces : [],
    cuts: walls ? plan.cuts : [],
    outline: walls ? plan.outline : [],
    wallLines: walls ? plan.wallLines : [],
    separators: walls ? plan.separators : [],
    doors: openings ? plan.doors : [],
    windows: openings ? plan.windows : [],
    tags: openings ? plan.tags : [],
    rooms: rooms ? plan.rooms : [],
    slabs: rooms ? plan.slabs : [],
    unanchored: rooms ? plan.unanchored : [],
    devices: plan.devices.filter((d) => {
      const layer = layerOfElement(d.extension, d.collection);
      // An element of an extension no mode knows goes with the building it stands in.
      return keep(layer ?? 'walls');
    }),
    stairs: roof ? plan.stairs : [],
    roofs: roof ? plan.roofs : [],
  };
}

/** A level's plan in a mode: the part drawn as usual and the part drawn as a ghost (null when there is none). */
export function splitPlan(plan: LevelPlan, states: LayerStates | null): { on: LevelPlan; ghost: LevelPlan | null } {
  if (states === null) return { on: plan, ghost: null };
  const on = planWith(plan, (l) => states[l] === 'on');
  const ghosted = Object.values(states).includes('ghost');
  return { on, ghost: ghosted ? planWith(plan, (l) => states[l] === 'ghost') : null };
}

/** A level's plan with what is off left out — the DXF's, where a ghost stays on its own layer for CAD to screen. */
export function shownPlan(plan: LevelPlan, states: LayerStates | null): LevelPlan {
  return states === null ? plan : planWith(plan, (l) => states[l] !== 'off');
}
