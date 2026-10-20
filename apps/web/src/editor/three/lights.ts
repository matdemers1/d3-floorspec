import { ALL_ON, EXPOSURE_PER_NIT, lightsOf, type FixtureLight, type HouseMesh, type Lighting, type Vec3 } from '@floorspec/mesh';
import type { EditorModel } from '../model';

/**
 * The 3D view's lamps (FLR-T-12.22): which of the house's FS_electrical lights the view turns on
 * when its Lights toggle is, where, how bright, and which cast shadows — worked out here, without
 * three.js, so it can be tested; FixtureLights draws them.
 *
 * Photometric (FLR-T-13.1), as the path tracer is: a lamp's intensity is candela — its lumens over
 * the sphere, or over its cone for a spot — and three.js (r186, physically based lights only) lights
 * a surface to I cos θ / d² lux with d in metres (decay 2). The view's exposure, not the lamps, says
 * how bright that looks (`LIT_EXPOSURE`, SunRig).
 *
 * - Only lights the lighting turns on (FLR-T-13.12: a scene, a switch, a dimmer — at its output and
 *   colour temperature, @floorspec/mesh `lightsOf`), on the levels shown: in a cutaway, the current
 *   level and those below it.
 * - Every room first (FLR-T-13.1): the current level's rooms take turns — each room's brightest
 *   lamp, then each room's next — before a light in no room (an exterior lantern) or on another
 *   level, so no room is left dark because its light's ID sorts late. At most `MAX_LIGHTS` in all
 *   (three.js compiles a shader per light count).
 * - Shadows are what keep a lamp's light in its room (a wall between is a wall in its shadow map),
 *   and a point light's shadow is six renders and a texture unit: so only the first `MAX_SHADOWED`
 *   in that order cast them — fewer where the GPU has too few texture units for them beside a
 *   surface's maps (`shadowBudget`) — one a room before any room has two. A shadowed lamp reaches as far as inverse-square takes it; a lamp
 *   without a shadow is cut off past its own room — at `SPILL` times the distance to its room's
 *   farthest corner (`OUTSIDE` for a light in none) — so what it leaks through a wall fades within a
 *   room of it.
 */

/**
 * The view's exposure with its lights on, per cd/m² (FLR-T-13.1): fixed — the view meters nothing —
 * at the open end of the path tracer's night band, @floorspec/mesh's `EXPOSURE_PER_NIT`: where the
 * tracer exposes a room lit by its one ceiling light, which is most rooms. A kitchen lit to 400 lux
 * reads bright here, as it is.
 */
export const LIT_EXPOSURE = EXPOSURE_PER_NIT.nightMax;
/**
 * three.js's `toneMappingExposure` for an exposure: its ACES curve divides what it is given by 0.6,
 * where the path tracer's fit of the same curve does not.
 */
export const toneMappingExposure = (exposure: number): number => exposure * 0.6;
/**
 * Lux: what the view's lamps, which do not bounce, are given back as an even fill — about what a
 * lamp-lit room's walls and ceiling bounce about it — and the night sky's, over the house.
 */
export const BOUNCE_LUX = 10;
export const NIGHT_SKY_LUX = 12;

export const MAX_LIGHTS = 24;
export const MAX_SHADOWED = 12;
/**
 * WebGL 2's least `MAX_TEXTURE_IMAGE_UNITS`, and what most GPUs give: the budget is planned for it
 * on every GPU, so a view with more (SwiftShader's 32) draws the same shadows as the owner's laptop.
 */
export const GUARANTEED_TEXTURE_UNITS = 16;
/** Texture units a fragment shader spends on the scene rather than its surface: the sun's shadow map. */
export const SCENE_TEXTURE_UNITS = 1;
/**
 * In Presentation (FLR-T-13.7) a lit surface also samples the sky's reflection map (three.js's
 * prefiltered environment): one unit more, so one shadowed lamp fewer.
 */
export const PRESENTATION_SCENE_TEXTURE_UNITS = SCENE_TEXTURE_UNITS + 1;

/**
 * How many lamps may cast shadows on a GPU with `units` texture units a fragment shader can sample
 * (FLR-T-13.17): each shadowed lamp's shadow map is a sampler in every lit surface's shader, beside
 * the surface's own maps (`materialUnits`) and the sun's shadow. Over the limit a program fails to
 * link and three.js silently draws nothing with it — every textured floor and wall vanished with
 * "All on" on a 16-unit GPU once the house was dressed in the material library. Planned for at most
 * `GUARANTEED_TEXTURE_UNITS`.
 */
export const shadowBudget = (units: number, materialUnits: number, sceneUnits: number = SCENE_TEXTURE_UNITS): number => Math.max(0, Math.min(MAX_SHADOWED, Math.min(units, GUARANTEED_TEXTURE_UNITS) - materialUnits - sceneUnits));
/** Metres: how far a shadowed lamp's shadow camera sees. */
export const REACH = 15;
/** An unshadowed lamp's cut-off, over the distance to its room's farthest corner. */
export const SPILL = 1.6;
/** Metres: an unshadowed lamp's cut-off when it is in no room. */
export const OUTSIDE = 6;
/**
 * The widest half-angle a spot is drawn with, radians (85°): a three.js spot's shadow camera spans
 * twice it, and cannot reach 180°. A ceiling light's dome shines to 110° (FLR-T-13.16); here it
 * stops at this, with the same candela, and its ceiling is lit by the bounce fill.
 */
export const MAX_SPOT_ANGLE = (85 * Math.PI) / 180;

export interface ViewLight {
  readonly id: string;
  readonly level: string;
  readonly kind: 'point' | 'spot';
  /** Metres, relative to the mesh's origin, z up. */
  readonly position: Vec3;
  /** three.js intensity: candela. */
  readonly intensity: number;
  /** Its luminous flux, lumens: three.js's `power` for a point light. */
  readonly lumens: number;
  /** sRGB-ish `#rrggbb` of its colour temperature. */
  readonly color: string;
  /** Metres: three.js's cut-off — 0 for none, inverse-square all the way. */
  readonly distance: number;
  readonly shadow: boolean;
  /** Metres: the radius of what shines (a lens, a shade, a bulb) — how soft its shadows are in Presentation (FLR-T-13.7). */
  readonly size: number;
  /** A spot's half-angle (radians) and penumbra (0–1, three.js's). */
  readonly angle?: number;
  readonly penumbra?: number;
  /** An aimed spot's axis (an exterior light's, FLR-T-15.5), unit, z up; a spot without one points straight down. */
  readonly aim?: Vec3;
  /** A key unique among the lamps: a light with several (a string's bulbs) gives each its part. */
  readonly key: string;
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

/** Metres from a light to the farthest corner of its room, floor or ceiling; undefined in none. */
function roomReach(l: FixtureLight, model: EditorModel, k: number): number | undefined {
  const room = l.room === null ? undefined : model.derived?.rooms[l.room];
  if (room === undefined || room.outer.length === 0) return undefined;
  let far = 0;
  for (const p of room.outer) far = Math.max(far, Math.hypot(p[0] - l.position[0], p[1] - l.position[1]));
  // The floor, about a storey under a ceiling light: the corner's height below it.
  return Math.hypot(far / k, 2.7);
}

/** A fixture light as the view draws it: candela, inverse-square, cut off past its room when it has no shadow. */
function viewLight(l: FixtureLight, model: EditorModel, mesh: HouseMesh, shadow: boolean): ViewLight {
  const k = mesh.unitsPerMetre;
  const o = mesh.origin;
  const position: Vec3 = [(l.position[0] - o[0]) / k, (l.position[1] - o[1]) / k, (l.position[2] - o[2]) / k];
  const distance = shadow ? 0 : Math.round(SPILL * (roomReach(l, model, k) ?? OUTSIDE / SPILL) * 100) / 100;
  const base = { id: l.id, key: l.part === undefined ? l.id : `${l.id}:${String(l.part)}`, level: l.level, position, color: hex(l.color), lumens: l.lumens, distance, shadow, size: Math.max(0.01, l.radius / k), ...(l.aim === undefined ? {} : { aim: l.aim }) };
  if (l.cone === undefined) return { ...base, kind: 'point', intensity: l.lumens / (4 * Math.PI) };
  const outer = Math.min(MAX_SPOT_ANGLE, Math.acos(l.cone.outer));
  const inner = Math.acos(l.cone.inner);
  const sr = 2 * Math.PI * (1 - (l.cone.inner + l.cone.outer) / 2);
  return { ...base, kind: 'spot', intensity: l.lumens / sr, angle: outer, penumbra: Math.min(1, Math.max(0, 1 - inner / outer)) };
}

/** Lights in rooms taking turns, each room's brightest first, rooms in ID order; then lights in none. */
function byRoom(lights: readonly FixtureLight[]): FixtureLight[] {
  const rooms = new Map<string, FixtureLight[]>();
  const none: FixtureLight[] = [];
  for (const l of lights) {
    if (l.room === null) none.push(l);
    else rooms.set(l.room, [...(rooms.get(l.room) ?? []), l]);
  }
  const queues = [...rooms.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, ls]) => [...ls].sort((a, b) => b.lumens - a.lumens || (a.id < b.id ? -1 : 1)));
  const out: FixtureLight[] = [];
  for (let turn = 0; queues.some((q) => q.length > turn); turn++)
    for (const q of queues) {
      const l = q[turn];
      if (l !== undefined) out.push(l);
    }
  return [...out, ...none];
}

/**
 * Whether a lighting is an exterior one (FLR-T-15.5): it turns on more of the lights in no room — the
 * path lights, uplights, wall-washers and lanterns — than of those in rooms. The view then lights the
 * grounds first, so a night exterior is not left dark because the rooms took every lamp.
 */
export function exteriorFirst(lights: readonly FixtureLight[]): boolean {
  const outside = lights.filter((l) => l.room === null).length;
  return outside > 0 && outside >= lights.length - outside;
}

/** The lamps to draw for a model's mesh, seen at `level` (null: none chosen), cut away or not, under a lighting. */
export function viewLights(model: EditorModel, mesh: HouseMesh, v: { level: string | null; cutaway: boolean; order: ReadonlyMap<string, number> }, lighting: Lighting = ALL_ON, shadowed = MAX_SHADOWED): ViewLight[] {
  if (model.derived === null) return [];
  const all = lightsOf(model.view, model.derived, lighting);
  const current = v.level === null ? undefined : v.order.get(v.level);
  const shown = all.filter((l) => {
    if (!v.cutaway || current === undefined) return true;
    const at = v.order.get(l.level);
    return at === undefined || at <= current;
  });
  const here = (l: FixtureLight) => (v.level !== null && l.level === v.level) || (v.level === null && current === undefined);
  const rooms = [...byRoom(shown.filter(here)), ...byRoom(shown.filter((l) => !here(l)))];
  if (exteriorFirst(shown)) {
    // FLR-T-15.5: the grounds' lamps first, unshadowed — a lamp outside has no room to keep its light
    // in, and its shadow map would spend a texture unit the surfaces need (shadowBudget) — then the rooms'.
    const outside = rooms.filter((l) => l.room === null);
    const inside = rooms.filter((l) => l.room !== null);
    const ordered = [...outside, ...inside].slice(0, MAX_LIGHTS);
    let shadows = 0;
    return ordered.map((l) => viewLight(l, model, mesh, l.room !== null && shadows++ < Math.min(shadowed, MAX_SHADOWED)));
  }
  const ordered = rooms.slice(0, MAX_LIGHTS);
  return ordered.map((l, i) => viewLight(l, model, mesh, i < Math.min(shadowed, MAX_SHADOWED)));
}
