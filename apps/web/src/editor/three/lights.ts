import { lightsOf, type FixtureLight, type HouseMesh, type Vec3 } from '@floorspec/mesh';
import type { EditorModel } from '../model';

/**
 * The 3D view's lamps (FLR-T-12.22): which of the house's FS_electrical lights the view turns on
 * when its Lights toggle is, where, how bright, and which cast shadows — worked out here, without
 * three.js, so it can be tested; FixtureLights draws them.
 *
 * - Only lights on the levels shown: in a cutaway, the current level and those below it.
 * - Shadows are what keep a lamp's light in its room (a wall between is a wall in its shadow map),
 *   and a point light's shadow is six renders: so only the current level's lights cast them, at most
 *   `MAX_SHADOWED`. A light without a shadow is kept short (`SHORT`), so what it leaks through a wall
 *   fades within a step of it.
 * - At most `MAX_LIGHTS` in all (three.js compiles a shader per light count): the current level's
 *   first, then by ID.
 */

/** three.js's candela for a lumen spread over a steradian: the view's exposure, not physics. */
export const CANDELA_SCALE = 0.035;
export const MAX_LIGHTS = 16;
export const MAX_SHADOWED = 8;
/** Metres: how far a shadowed lamp reaches, and an unshadowed one. */
export const REACH = 9;
export const SHORT = 3.5;

export interface ViewLight {
  readonly id: string;
  readonly level: string;
  readonly kind: 'point' | 'spot';
  /** Metres, relative to the mesh's origin, z up. */
  readonly position: Vec3;
  /** three.js intensity: candela, scaled (CANDELA_SCALE). */
  readonly intensity: number;
  /** sRGB-ish `#rrggbb` of its colour temperature. */
  readonly color: string;
  readonly distance: number;
  readonly shadow: boolean;
  /** A spot's half-angle (radians) and penumbra (0–1, three.js's). */
  readonly angle?: number;
  readonly penumbra?: number;
}

const hex = (c: readonly [number, number, number]): string => {
  const m = Math.max(c[0], c[1], c[2]);
  // Linear RGB to sRGB, its brightest channel at 1: a light's colour, its strength is its intensity.
  const s = (x: number) => {
    const v = x / m;
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  };
  return `#${[s(c[0]), s(c[1]), s(c[2])].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

/** A fixture light as the view draws it. */
function viewLight(l: FixtureLight, mesh: HouseMesh, shadow: boolean): ViewLight {
  const k = mesh.unitsPerMetre;
  const o = mesh.origin;
  const position: Vec3 = [(l.position[0] - o[0]) / k, (l.position[1] - o[1]) / k, (l.position[2] - o[2]) / k];
  const base = { id: l.id, level: l.level, position, color: hex(l.color), distance: shadow ? REACH : SHORT, shadow };
  if (l.cone === undefined) return { ...base, kind: 'point', intensity: (l.lumens / (4 * Math.PI)) * CANDELA_SCALE };
  const outer = Math.acos(l.cone.outer);
  const inner = Math.acos(l.cone.inner);
  const sr = 2 * Math.PI * (1 - (l.cone.inner + l.cone.outer) / 2);
  return { ...base, kind: 'spot', intensity: (l.lumens / sr) * CANDELA_SCALE, angle: outer, penumbra: Math.min(1, Math.max(0, 1 - inner / outer)) };
}

/** The lamps to draw for a model's mesh, seen at `level` (null: none chosen), cut away or not. */
export function viewLights(model: EditorModel, mesh: HouseMesh, v: { level: string | null; cutaway: boolean; order: ReadonlyMap<string, number> }): ViewLight[] {
  if (model.derived === null) return [];
  const all = lightsOf(model.view, model.derived);
  const current = v.level === null ? undefined : v.order.get(v.level);
  const shown = all.filter((l) => {
    if (!v.cutaway || current === undefined) return true;
    const at = v.order.get(l.level);
    return at === undefined || at <= current;
  });
  const here = (l: FixtureLight) => (v.level !== null && l.level === v.level) || (v.level === null && current === undefined);
  const ordered = [...shown.filter(here), ...shown.filter((l) => !here(l))].slice(0, MAX_LIGHTS);
  let shadows = 0;
  return ordered.map((l) => viewLight(l, mesh, here(l) && shadows++ < MAX_SHADOWED));
}
