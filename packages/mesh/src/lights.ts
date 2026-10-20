/**
 * The light FS_electrical's luminaires give (FLR-T-12.22): where each one shines from, which way,
 * how much and how warm — read from what the engine derives, for every view that lights a room with
 * its lamps: the editor's 3D view (three.js lights), the headless render and the path tracer.
 *
 * Like a model (models/), this is a view's picture, not the standard's: FS_electrical records a
 * light's kind, its watts, its box and its switches, not its photometry. So:
 *
 * - **Where:** a hung light (pendant, fan, track, under-cabinet) shines from just under its box's
 *   bottom at the centre of its footprint — under its lens; a ceiling light from inside the dome of
 *   its diffuser, where its lamps are (FLR-T-13.16: the dome is shallower than its box, and a lamp
 *   under the box hung in the air under the fitting it is the light of); a recessed light from just
 *   under the trim at its box's top; a wall light (a sconce, an exterior lantern) from just in front
 *   of the middle of its box's front face.
 * - **Which way:** recessed, track and under-cabinet lights are spots pointing straight down, each
 *   with a cone, and so is a pendant — under its shade, which throws its light down (FLR-T-13.1) —
 *   and a ceiling light, whose dome sends its light down and out to a little above the horizontal
 *   and none up into its canopy (FLR-T-13.16); a fan's light kit, a sconce and a lantern shine
 *   every way.
 * - **How much** (FLR-T-13.1, photometric and the same in every view): its `watts` at an LED's 90
 *   lumens a watt, else a typical lamp of its kind (`DEFAULT_LUMENS`). Each view spreads the lumens
 *   over the sphere (a light that shines every way) or over its cone (a spot) as candela, and lights
 *   a surface by the inverse square of its distance in metres — lux, with no other scale.
 * - **How warm:** 2700 K inside, 3000 K for an exterior light; the colour a camera white-balanced for
 *   warm-white lamps sees (`kelvinColor`).
 * - **What FS_lighting says** (FLR-T-13.12, FLR-ADR-043): a luminaire's own `lumens` and `cct` take
 *   the place of the typical lamp's, and a lighting scene (scenes.ts) says which lights are on, at
 *   what output and colour temperature: a light it turns off is not in the list, and one it dims gives
 *   its output's share of its lumens.
 * - **How it is seen** (FLR-T-13.1): `EXPOSURE_PER_NIT`, the calibration every view's tone curve
 *   shares — a room lit to 150–300 lux reads as a normally lit room at night, and a daylit interior
 *   as bright as a camera metering it would show it.
 *
 * Exact integers in base units (the document's frame, z up) except the colour; deterministic, and
 * no trigonometry — a spot's cone is the cosines of its angles, written out.
 */
import { extElements, type Derived, type FloorspecDocument } from '@floorspec/engine';
import { decorFamily, LAMP_SHADES, libraryItemOf } from './models/decor.js';
import { ceilingDome } from './models/electrical.js';
import { corners } from './models/sketch.js';
import { elementKind } from './models/kinds.js';
import { ALL_ON, luminairesOf, settingOf, type Lighting } from './scenes.js';
import { bulbCount, EXTERIOR_DEFS, exteriorOf } from '@floorspec/render2d/exterior';
import { exteriorLamps } from './exterior.js';
import type { Vec3 } from './types.js';

/** One luminaire's light. */
export interface FixtureLight {
  /** The light's element ID. */
  readonly id: string;
  readonly level: string;
  /** Its FS_electrical `fixture` (a light without one is a ceiling light). */
  readonly fixture: string;
  /** Where it shines from: base units, the document's frame (x east, y north, z up), integers. */
  readonly position: Vec3;
  /** The size of what shines, base units: its shadows' softness. */
  readonly radius: number;
  /**
   * `down`: a spot, pointing straight down (−z), lit fully inside `cone.inner` and fading to dark
   * at `cone.outer` (each the cosine of the angle from straight down); `aimed`: a spot along `aim`
   * (an exterior light's, FLR-T-15.5), its cone's cosines from that axis; `omni`: every way.
   */
  readonly direction: 'down' | 'aimed' | 'omni';
  readonly cone?: { readonly inner: number; readonly outer: number };
  /** An aimed spot's axis: a unit vector in the document's frame (z up). */
  readonly aim?: Vec3;
  /** Which of a light's lamps this is, for a light with more than one (a string light's bulbs); absent for one. */
  readonly part?: number;
  /** Luminous flux: the light it gives, in lumens — at its output. */
  readonly lumens: number;
  /** What it gives at full output, lumens: FS_lighting's `lumens`, else its watts', else a typical lamp's. */
  readonly fullLumens: number;
  /** Its output, percent of full (FS_lighting 3.1): 100 unless a scene dims it. */
  readonly output: number;
  /** Correlated colour temperature, kelvin: the scene's, else its own. */
  readonly kelvin: number;
  /** Its own colour temperature: FS_lighting's `cct`, else a typical lamp's (2700 K inside, 3000 K outside). */
  readonly ownKelvin: number;
  /** Its colour: linear RGB, scaled so its luminance is 1. */
  readonly color: readonly [number, number, number];
  /** The room it is in, as FS_electrical derives (each light's room); null when it is in none. */
  readonly room: string | null;
  /** The switches that control it, as FS_electrical derives; sorted, empty when none does. */
  readonly switches: readonly string[];
}

const MM = 1280;

/** Lumens a watt: an LED lamp's. */
export const LUMENS_PER_WATT = 90;

/**
 * A typical lamp of each kind, lumens: what a light without `watts` gives (FLR-T-13.1).
 *
 * - `ceiling` 1500: a flush or semi-flush fitting with two A19 lamps of about 750 lm each — what a
 *   bedroom's one ceiling light is bought with. It lights a 4 m × 4 m room to about 50–60 lux.
 * - `recessed` 800: a 4″–6″ LED downlight (about 9 W). `pendant` 800: one lamp under a shade.
 * - `wall` 400: a sconce. `track` 900: a short track of heads. `underCabinet` 300: a strip.
 * - `fan` 1200: a fan's light kit. `exterior` 600: a porch lantern.
 */
export const DEFAULT_LUMENS: Readonly<Record<string, number>> = {
  ceiling: 1500,
  recessed: 800,
  pendant: 800,
  wall: 400,
  track: 900,
  underCabinet: 300,
  fan: 1200,
  exterior: 600,
};
const FALLBACK_LUMENS = 800;

/**
 * A decor lamp's light (FLR-T-13.11): a floor lamp with a 1100 lm bulb (a 75 W incandescent's), a
 * table lamp with 450 lm (a 40 W one's) — warm, under a shade, the light a staged room is lit by.
 */
export const LAMP_LUMENS: Readonly<Record<string, number>> = { floorLamp: 1100, tableLamp: 450 };

export { EXPOSURE_PER_NIT } from './exposure.js';

/** Where each kind shines from: under its box, under its trim at the box's top, or in front of its face. */
const EMITS: Readonly<Record<string, 'bottom' | 'top' | 'front'>> = { recessed: 'top', wall: 'front', exterior: 'front' };

/** Spots: the cosines of the angle from straight down within which each is fully lit, and past which it is dark. */
const CONES: Readonly<Record<string, { inner: number; outer: number }>> = {
  // 35° and 55°: a downlight's wide beam, which scallops the walls near it.
  recessed: { inner: 0.8192, outer: 0.5736 },
  // 25° and 40°: a track head's narrower beam.
  track: { inner: 0.9063, outer: 0.766 },
  // 50° and 75°: a strip's wash over the counter under it.
  underCabinet: { inner: 0.6428, outer: 0.2588 },
  // 55° and 85°: a pendant's shade throws its light down and out, and keeps it off the ceiling.
  pendant: { inner: 0.5736, outer: 0.0872 },
  // 70° and 110° (FLR-T-13.16): a flush fitting's dome lights the room under it and, from its sides,
  // grazes the ceiling around it — a glow brightest by the fitting, not the 3000-lux blaze a bare
  // lamp a hand's breadth under a white ceiling gives it, in which the fitting itself was lost. Its
  // canopy, against the ceiling, lets nothing straight up.
  ceiling: { inner: 0.342, outer: -0.342 },
};

/**
 * A black body's colour at each temperature, linear sRGB with red at 1 (Mitchell Charity's table,
 * the sRGB values linearised).
 */
const KELVIN: readonly (readonly [number, number, number, number])[] = [
  [2200, 1, 0.291, 0.025],
  [2700, 1, 0.397, 0.095],
  [3000, 1, 0.456, 0.147],
  [3500, 1, 0.552, 0.25],
  [4000, 1, 0.638, 0.366],
  [5000, 1, 0.776, 0.617],
  [6500, 1, 0.948, 0.982],
];

/**
 * The white balance every view's camera is set to (FLR-T-13.1): a warm-white lamp's 3000 K, as a
 * photograph of a lamp-lit room is taken — so a 2700 K lamp reads warm white and a 3000 K one white,
 * where a camera balanced for daylight shows both orange.
 */
export const WHITE_BALANCE = 3000;

const blackbody = (kelvin: number): [number, number, number] => {
  const k = Math.min(Math.max(kelvin, KELVIN[0]![0]), KELVIN[KELVIN.length - 1]![0]);
  let i = 0;
  while (i < KELVIN.length - 2 && KELVIN[i + 1]![0] < k) i++;
  const a = KELVIN[i]!;
  const b = KELVIN[i + 1]!;
  const t = (k - a[0]) / (b[0] - a[0]);
  return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
};

/**
 * The colour of a colour temperature as the views' camera sees it: the black body's, over the white
 * balance's (`WHITE_BALANCE`), linear RGB scaled so its luminance is 1.
 */
export function kelvinColor(kelvin: number): [number, number, number] {
  const c = blackbody(kelvin);
  const w = blackbody(WHITE_BALANCE);
  const rgb: [number, number, number] = [c[0] / w[0], c[1] / w[1], c[2] / w[2]];
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return [rgb[0] / lum, rgb[1] / lum, rgb[2] / lum];
}

/** A luminaire's own colour temperature: FS_lighting's `cct`, else the typical lamp's, within its tunable range. */
function ownCct(l: { cct?: number; cctRange?: readonly [number, number] } | undefined, typical: number): number {
  if (l?.cct !== undefined) return l.cct;
  const r = l?.cctRange;
  return r === undefined ? typical : Math.min(Math.max(typical, r[0]), r[1]);
}

/** How far in front of or under what shines a light's sphere is put, so it is not inside its own lens. */
const CLEAR = 5 * MM;
/** Under a recessed light's trim, from its box's top. */
const TRIM = 15 * MM;

/** A light's lumens and colour as a lighting sets them; null when it turns the light off. */
function asLit(lighting: Lighting, id: string, full: number, own: number): Pick<FixtureLight, 'lumens' | 'fullLumens' | 'output' | 'kelvin' | 'ownKelvin' | 'color'> | null {
  const s = settingOf(lighting, id);
  if (s === null) return null;
  const kelvin = s.cct ?? own;
  return { lumens: Math.max(1, Math.round((full * s.output) / 100)), fullLumens: full, output: s.output, kelvin, ownKelvin: own, color: kelvinColor(kelvin) };
}

/**
 * Every FS_electrical light's light, in ID order; then every decor lamp's (FLR-T-13.11) — those
 * `lighting` turns on (every one, by default), at its output and colour temperature (FLR-T-13.12).
 */
export function lightsOf(doc: FloorspecDocument, derived: Derived, lighting: Lighting = ALL_ON): FixtureLight[] {
  const out: FixtureLight[] = [];
  const own = luminairesOf(doc);
  const electrical = derived.extensions?.FS_electrical;
  const roomOf = new Map<string, string>();
  for (const [room, ids] of Object.entries(electrical?.rooms ?? {})) for (const id of ids) roomOf.set(id, room);
  for (const e of extElements(doc)) {
    if (e.extension !== 'FS_electrical' || e.collection !== 'lights') continue;
    const f = derived.fallbacks?.[e.id];
    if (f === undefined || f.top <= f.bottom) continue;
    const element = e.element as unknown as Record<string, unknown>;
    const fixture = elementKind(e.extension, e.collection, element);
    // FLR-T-15.5: an exterior light of a kind — a path light, an uplight, a wall-washer, a step light, a string.
    const ext = exteriorOf(element);
    if (ext !== null) {
      out.push(...exteriorLights(e.id, element, ext, f, derived, own.get(e.id), lighting, roomOf.get(e.id) ?? null, [...(electrical?.controls[e.id] ?? [])].sort()));
      continue;
    }
    const ring = f.footprint;
    const cx = (ring[0]![0] + ring[1]![0] + ring[2]![0] + ring[3]![0]) / 4;
    const cy = (ring[0]![1] + ring[1]![1] + ring[2]![1] + ring[3]![1]) / 4;
    const sides = [0, 1].map((k) => Math.hypot(ring[k + 1]![0] - ring[k]![0], ring[k + 1]![1] - ring[k]![1]));
    const half = Math.min(sides[0]!, sides[1]!) / 2;
    const emits = EMITS[fixture] ?? 'bottom';
    // Small: a lamp, not the fixture — and clear of its own trim and canopy.
    const dome = fixture === 'ceiling' ? ceilingDome(sides[0]!, sides[1]!, f.top - f.bottom) : undefined;
    const radius = Math.round(Math.min(emits === 'top' ? TRIM - 3 * MM : 30 * MM, Math.max(8 * MM, half * 0.3), dome === undefined ? Infinity : Math.max(3 * MM, dome.depth * 0.35)));
    let position: Vec3;
    if (dome !== undefined) {
      // Inside its dome, just under its canopy: the lamps a flush fitting's diffuser covers.
      position = [Math.round(cx), Math.round(cy), Math.round(f.top - dome.canopy - radius)];
    } else if (emits === 'front') {
      // The middle of the front face (the frame's x = X), a little in front of it.
      const [c00, c10, c11] = corners(f, derived.placements?.[e.id]?.facing);
      const [fx, fy] = [c10[0] - c00[0], c10[1] - c00[1]];
      const l = Math.hypot(fx, fy) || 1;
      const out = CLEAR + radius;
      position = [Math.round((c10[0] + c11[0]) / 2 + (fx / l) * out), Math.round((c10[1] + c11[1]) / 2 + (fy / l) * out), Math.round((f.bottom + f.top) / 2)];
    } else {
      const z = emits === 'top' ? Math.max(f.bottom, f.top - TRIM) : f.bottom - CLEAR - radius;
      position = [Math.round(cx), Math.round(cy), z];
    }
    const watts = typeof element['watts'] === 'number' && element['watts'] > 0 ? element['watts'] : undefined;
    const lum = own.get(e.id);
    const full = lum?.lumens ?? (watts === undefined ? (DEFAULT_LUMENS[fixture] ?? FALLBACK_LUMENS) : Math.min(20_000, Math.max(50, Math.round(watts * LUMENS_PER_WATT))));
    const lit = asLit(lighting, e.id, full, ownCct(lum, fixture === 'exterior' ? 3000 : 2700));
    if (lit === null) continue;
    const cone = CONES[fixture];
    out.push({
      id: e.id,
      level: f.level,
      fixture,
      position,
      radius,
      direction: cone === undefined ? 'omni' : 'down',
      ...(cone === undefined ? {} : { cone }),
      ...lit,
      room: roomOf.get(e.id) ?? null,
      switches: [...(electrical?.controls[e.id] ?? [])].sort(),
    });
  }
  // The floor and table lamps of FS_furniture's starter library (FLR-T-13.11): plugged in, not wired,
  // so no switch; each shines every way from the middle of its shade, which glows and, like a
  // luminaire's own fixture, never shadows its lamp.
  const furnitureItems = derived.extensions?.FS_furniture?.items;
  for (const e of extElements(doc)) {
    if (e.extension !== 'FS_furniture' || e.collection !== 'pieces') continue;
    const element = e.element as unknown as Record<string, unknown>;
    if (element['category'] !== 'other') continue;
    const family = decorFamily(libraryItemOf(doc, element));
    const shade = family === undefined ? undefined : LAMP_SHADES[family];
    const f = derived.fallbacks?.[e.id];
    if (shade === undefined || f === undefined || f.top <= f.bottom) continue;
    const ring = f.footprint;
    const cx = (ring[0]![0] + ring[1]![0] + ring[2]![0] + ring[3]![0]) / 4;
    const cy = (ring[0]![1] + ring[1]![1] + ring[2]![1] + ring[3]![1]) / 4;
    const fixture = family === 'lamp-floor' ? 'floorLamp' : 'tableLamp';
    const lum = own.get(e.id);
    const lit = asLit(lighting, e.id, lum?.lumens ?? LAMP_LUMENS[fixture]!, ownCct(lum, 2700));
    if (lit === null) continue;
    out.push({
      id: e.id,
      level: f.level,
      fixture,
      position: [Math.round(cx), Math.round(cy), Math.round(f.bottom + ((f.top - f.bottom) * (shade[0] + shade[1])) / 2)],
      radius: 25 * MM,
      direction: 'omni',
      ...lit,
      room: furnitureItems?.[e.id]?.room ?? null,
      switches: [],
    });
  }
  return out;
}

/** An exterior light's lamps (FLR-T-15.5): its kind's, carried from its frame to the plan, sharing its light. */
function exteriorLights(
  id: string,
  element: Record<string, unknown>,
  ext: NonNullable<ReturnType<typeof exteriorOf>>,
  f: { level: string; top: number; bottom: number },
  derived: Derived,
  lum: ReturnType<ReturnType<typeof luminairesOf>['get']>,
  lighting: Lighting,
  room: string | null,
  switches: string[],
): FixtureLight[] {
  const def = EXTERIOR_DEFS[ext.kind];
  const box = (element['fallback'] as { box?: { min?: number[]; max?: number[] } } | undefined)?.box;
  const min = Array.isArray(box?.min) ? box.min : [...def.box.min];
  const max = Array.isArray(box?.max) ? box.max : [...def.box.max];
  const pl = derived.placements?.[id];
  const o = pl?.point ?? [0, 0, f.bottom - (min[2] ?? 0)];
  const [ux, uy] = (() => {
    const rad = ((pl?.facing ?? 0) / 1_000_000) * (Math.PI / 180);
    return [Math.cos(rad), Math.sin(rad)];
  })();
  const toPlan = (x: number, y: number): [number, number] => [x * ux - y * uy, x * uy + y * ux];
  // A string's light is its bulbs'; the rest one lamp's.
  const bulbs = ext.kind === 'string' ? bulbCount((max[0] ?? 0) - (min[0] ?? 0)) : 1;
  const full = lum?.lumens ?? def.lumens * bulbs;
  const lit = asLit(lighting, id, full, ownCct(lum, def.cct));
  if (lit === null) return [];
  const lamps = exteriorLamps(ext, min, max);
  return lamps.map((lamp, i): FixtureLight => {
    const [px, py] = toPlan(lamp.local[0], lamp.local[1]);
    const position: Vec3 = [Math.round(o[0] + px), Math.round(o[1] + py), Math.round(o[2] + lamp.local[2])];
    const aim = lamp.aim === undefined ? undefined : ((): Vec3 => {
      const [ax, ay] = toPlan(lamp.aim[0], lamp.aim[1]);
      return [Number(ax.toFixed(4)), Number(ay.toFixed(4)), lamp.aim[2]];
    })();
    const share = (n: number) => Math.max(1, Math.round(n * lamp.share));
    return {
      id,
      level: f.level,
      fixture: 'exterior',
      position,
      radius: lamp.radius,
      direction: aim === undefined ? 'omni' : 'aimed',
      ...(lamp.cone === undefined ? {} : { cone: lamp.cone }),
      ...(aim === undefined ? {} : { aim }),
      ...(lamps.length > 1 ? { part: i } : {}),
      ...lit,
      lumens: share(lit.lumens),
      fullLumens: share(lit.fullLumens),
      room,
      switches,
    };
  });
}

/** How a fixture's glowing pieces (a lens, a shade) are drawn under a lighting: off (null), or scaled per channel. */
export type LensGlow = readonly [number, number, number] | null;

/**
 * Each fixture whose lens a lighting changes (FLR-T-13.12): null for one it turns off; else its glow
 * scaled by its output and tinted from its own colour temperature to the lighting's. `all` is every
 * light (`lightsOf` with every one on), `lit` the lighting's. A fixture at full and its own colour is
 * left out: its lens is drawn as it always is. Every view that draws a lit lens reads this.
 */
export function lensGlows(all: readonly FixtureLight[], lit: readonly FixtureLight[]): Map<string, LensGlow> {
  const on = new Map(lit.map((l) => [l.id, l]));
  const out = new Map<string, LensGlow>();
  for (const l of all) {
    const now = on.get(l.id);
    if (now === undefined) {
      out.set(l.id, null);
      continue;
    }
    if (now.output === 100 && now.kelvin === now.ownKelvin) continue;
    const k = now.output / 100;
    const to = kelvinColor(now.kelvin);
    const from = kelvinColor(now.ownKelvin);
    out.set(l.id, [(k * to[0]) / from[0], (k * to[1]) / from[1], (k * to[2]) / from[2]]);
  }
  return out;
}
