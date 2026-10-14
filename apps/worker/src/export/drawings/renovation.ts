/**
 * Renovation plans in the drawings (FLR-T-18.13, FS_renovation 3.1 and 3.3): a sheet of the Existing,
 * Demolition, Proposed or Combined plan. The plan is drawn from the filter's state; its existing work
 * is screened under what changes, as a trade's other layers are (FLR-T-18.3), new work is drawn as
 * usual — the poché solid — and demolished work is drawn over it dashed in red, with no poché. In a
 * DXF the changes go on NCS status layers: `A-WALL-DEMO`, `A-DOOR-DEMO`, `I-FURN-DEMO`, `A-FLOR-DEMO`
 * and `A-WALL-NEWW`.
 */
import type { RenovationFilter, RenovationStyle } from '@floorspec/render2d';
import type { LevelPlan, PlanDevice, PlanDoor, PlanWindow } from './plan.js';
import type { Pt } from '@floorspec/render2d';

/** What a plan shows as demolished: wall bodies, doors, windows, items and slabs. */
export interface Demolished {
  readonly rings: readonly (readonly Pt[])[];
  readonly doors: readonly PlanDoor[];
  readonly windows: readonly PlanWindow[];
  readonly devices: readonly PlanDevice[];
  readonly slabs: readonly { readonly id: string; readonly outline: readonly Pt[] }[];
}

/** What a renovation sheet is made of. */
export interface RenovationSplit {
  /** New work, and the rooms' labels: drawn as usual. */
  readonly on: LevelPlan;
  /** Existing work: screened under it. Null for the Existing plan, which is drawn plainly. */
  readonly ghost: LevelPlan | null;
  readonly demolished: Demolished | null;
}

export const DEMOLISH_INK = '#c8372d';

/** A level's plan split by its elements' renovation styles (3.1). */
export function renovationSplit(plan: LevelPlan, filter: RenovationFilter, styles: ReadonlyMap<string, RenovationStyle>): RenovationSplit {
  if (filter === 'existing') return { on: plan, ghost: null, demolished: null };
  const style = (id: string | undefined): RenovationStyle => (id === undefined ? 'existing' : (styles.get(id) ?? 'existing'));
  const is = (s: RenovationStyle) => (x: { readonly id?: string | undefined }): boolean => style(x.id) === s || (s === 'existing' && style(x.id) === 'plain');
  const ghost: LevelPlan = {
    ...plan,
    pieces: plan.pieces.filter(is('existing')),
    doors: plan.doors.filter(is('existing')),
    windows: plan.windows.filter(is('existing')),
    devices: plan.devices.filter(is('existing')),
    slabs: plan.slabs.filter(is('existing')),
    tags: plan.tags.filter(is('existing')),
    rooms: [],
  };
  const on: LevelPlan = {
    ...plan,
    pieces: plan.pieces.filter(is('new')),
    wallLines: [],
    outline: [],
    separators: [],
    unanchored: [],
    doors: plan.doors.filter(is('new')),
    windows: plan.windows.filter(is('new')),
    devices: plan.devices.filter(is('new')),
    slabs: plan.slabs.filter(is('new')),
    tags: plan.tags.filter(is('new')),
    stairs: [],
    roofs: [],
  };
  const demolished: Demolished = {
    rings: plan.pieces.filter(is('demolished')).map((p) => p.ring),
    doors: plan.doors.filter(is('demolished')),
    windows: plan.windows.filter(is('demolished')),
    devices: plan.devices.filter(is('demolished')),
    slabs: plan.slabs.filter(is('demolished')),
  };
  return { on, ghost, demolished };
}

/** A level's plan for a DXF under a filter: demolished doors, windows and items moved to their status layers. */
export function dxfPlan(plan: LevelPlan, filter: RenovationFilter, styles: ReadonlyMap<string, RenovationStyle>): { plan: LevelPlan; demolished: Demolished | null; fresh: readonly (readonly Pt[])[] } {
  if (filter === 'existing') return { plan, demolished: null, fresh: [] };
  const split = renovationSplit(plan, filter, styles);
  const gone = (x: { readonly id?: string | undefined }): boolean => x.id !== undefined && styles.get(x.id) === 'demolished';
  return {
    plan: { ...plan, doors: plan.doors.filter((d) => !gone(d)), windows: plan.windows.filter((w) => !gone(w)), devices: plan.devices.filter((d) => !gone(d)), slabs: plan.slabs.filter((s) => !gone(s)), tags: plan.tags.filter((t) => !gone(t)) },
    demolished: split.demolished,
    fresh: split.on.pieces.map((p) => p.ring),
  };
}
