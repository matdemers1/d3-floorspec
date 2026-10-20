/**
 * The sky a house is seen under (FLR-T-13.4, FLR-T-13.9): one module that the editor's 3D view,
 * the headless render, the worker's path tracer and the editor's GPU still all read, so a preset
 * looks — and lights — the same everywhere.
 *
 * - **Presets:** clear day, overcast, dusk, night and studio (`SKY_PRESETS`).
 * - **The sky dome** is a CC0 HDRI (Poly Haven; `sky/SOURCES.json`, `sky/NOTICE.md`) with its sun
 *   taken out (scripts/prepare-sky.ts), turned about the vertical so the glow its sun left sits
 *   where the real sun is, and scaled to a calibrated illuminance for the sun's altitude — so the
 *   sky is image-based light in photometric units, cd/m².
 * - **The sun** is analytic: its place from the NOAA algorithm (solar.ts) for the site's latitude,
 *   longitude and true north at a date and time, or a preset's default; its illuminance through an
 *   air mass (Kasten and Young) and its colour reddened the same way. A clear sky follows it: past
 *   sunset it fades into the dusk sky and then into night, so a timelapse runs from dawn to dark.
 * - **Night** has a moon: a weak cool key light opposite the sun, and the night map's own glow
 *   turned to sit under it.
 * - **The ground** below the horizon is the lawn, lit by the sun and sky, fading into the haze at
 *   the horizon — what a view that has no ground of its own (an environment map's lower half) sees.
 * - **Studio** is no sky at all: an even, bright dome over a pale floor, the way a model is
 *   photographed — no sun, no lawn.
 *
 * Directions are in the project's frame: x east, y project north, z up (Core 2.4), turned to true
 * north by `trueNorth` (Core 1.8). Each view converts to its own frame. Pure arithmetic on plain
 * data: a `SkyLight` and the decoded maps cross a worker thread's boundary as they are.
 */
import { EXPOSURE_PER_NIT } from '../exposure.js';
import { lawnAlbedo, type Rgb } from './grass.js';
import { decodeHdr, type HdrImage } from './hdr.js';
import { sunAt, sunDay, type SunDay } from './solar.js';
import { DEFAULT_SEASON, groundLook, lookSkyTint, weatherOfSky, WEATHER_SKY, type Look, type LookRequest } from './weather.js';

export type Vec3 = [number, number, number];

/** The sky presets, in the order a picker shows them (FLR-T-13.4). */
export const SKY_PRESETS = ['clear', 'overcast', 'dusk', 'night', 'studio'] as const;
export type SkyPreset = (typeof SKY_PRESETS)[number];
export const SKY_LABELS: Readonly<Record<SkyPreset, string>> = { clear: 'Clear day', overcast: 'Overcast', dusk: 'Dusk', night: 'Night', studio: 'Studio' };
/** The preset a project starts with: a clear day, on a lawn. */
export const DEFAULT_SKY: SkyPreset = 'clear';

export function isSkyPreset(v: unknown): v is SkyPreset {
  return typeof v === 'string' && (SKY_PRESETS as readonly string[]).includes(v);
}

/** The HDRI maps (sky/*.hdr). */
export const SKY_MAP_IDS = ['clear', 'overcast', 'dusk', 'night'] as const;
export type SkyMapId = (typeof SKY_MAP_IDS)[number];

/**
 * Where each map's own sun (the night map's moon) was, as prepare-sky.ts found it: its u across the
 * map (0 at the left edge, clockwise) and its elevation, degrees. The overcast map has none to
 * speak of: its brightest cloud stands for it.
 */
export const SKY_MAP_SUNS: Readonly<Record<SkyMapId, { readonly u: number; readonly elevation: number }>> = {
  clear: { u: 0.59497, elevation: 47.9 },
  overcast: { u: 0.58179, elevation: 23.12 },
  dusk: { u: 0.60474, elevation: 2.02 },
  night: { u: 0.59888, elevation: 16.96 },
};

/** A decoded map, ready to look up: the sky from the zenith down to a little under the horizon. */
export interface SkyMap {
  readonly id: SkyMapId;
  readonly width: number;
  readonly height: number;
  /** Linear RGB, three floats a texel, rows from the zenith down. */
  readonly data: Float32Array;
  /** Its upper hemisphere's illuminance on a level surface, in its own units. */
  readonly illuminance: number;
}

export type SkyMaps = Partial<Record<SkyMapId, SkyMap>>;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Rows per degree of elevation in a map `width` wide (an equirectangular map is twice as wide as tall). */
const rowsPerDegree = (width: number): number => width / 2 / 180;

/** A map from its decoded `.hdr` (or the file's bytes). */
export function skyMapOf(id: SkyMapId, image: HdrImage | Uint8Array): SkyMap {
  const img = image instanceof Uint8Array ? decodeHdr(image) : image;
  const { width, height, data } = img;
  // E = Σ L cos θ dω over the rows above the horizon.
  const perRow = rowsPerDegree(width);
  const dPhi = (2 * Math.PI) / width;
  let e = 0;
  for (let y = 0; y < height; y++) {
    const elevation = 90 - (y + 0.5) / perRow;
    if (elevation <= 0) break;
    const s = Math.sin(elevation * RAD);
    const dTheta = RAD / perRow;
    const dOmega = Math.cos(elevation * RAD) * dTheta * dPhi;
    let row = 0;
    for (let x = 0; x < width; x++) {
      const o = 3 * (y * width + x);
      row += 0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!;
    }
    e += row * s * dOmega;
  }
  return { id, width, height, data, illuminance: e };
}

// ─── The sun ─────────────────────────────────────────────────────────────────────────────────

/** A place in the sky, degrees: azimuth clockwise from true north, altitude above the horizon. */
export interface SkyPlace {
  readonly azimuth: number;
  readonly altitude: number;
}

/** Mid-afternoon from the south-west: the sun when nothing places it. */
export const DEFAULT_SUN: SkyPlace = { azimuth: 225, altitude: 35 };
/** Where the sun is assumed to have set on a dusk with no date: west-north-west. */
const DEFAULT_DUSK: SkyPlace = { azimuth: 290, altitude: -3 };

/**
 * The site assumed when a document records no location (Core 1.8 makes it optional): 40° N, 75° W —
 * a temperate latitude, so the sun's path is a typical one. Every view that uses it says so.
 */
export const DEFAULT_SITE = { latitude: 40, longitude: -75 } as const;

/** Unit vector toward a place in the sky, in the project's frame, given true north (Core 1.8). */
export function placeVector(place: SkyPlace, trueNorth: number): Vec3 {
  const b = (place.azimuth - trueNorth) * RAD;
  const h = place.altitude * RAD;
  return [Math.sin(b) * Math.cos(h), Math.cos(b) * Math.cos(h), Math.sin(h)];
}

/** The relative optical air mass at an apparent altitude (Kasten and Young 1989). */
export function airMass(altitude: number): number {
  const h = Math.max(-0.5, altitude);
  return 1 / (Math.sin(h * RAD) + 0.50572 * (h + 6.07995) ** -1.6364);
}

/**
 * Sunlight above the atmosphere as a level of daylight, lux, and the broadband extinction that
 * leaves about 93 klx at noon and 50 klx 15° up; the colour is reddened through each channel's own
 * optical depth (Rayleigh and aerosol, roughly), so a low sun is warm and a setting one orange.
 */
const SOLAR_LUX = 115_000;
const EXTINCTION = 0.21;
const DEPTH: Vec3 = [0.05, 0.08, 0.15];
const LUM = (c: Vec3 | Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Direct sunlight at an altitude: illuminance on a surface square to it (lux) and its colour (luminance 1). */
export function sunlight(altitude: number): { lux: number; color: Vec3 } {
  if (altitude <= -0.5) return { lux: 0, color: [1, 0.55, 0.25] };
  const m = airMass(altitude);
  const t: Vec3 = [Math.exp(-DEPTH[0] * m), Math.exp(-DEPTH[1] * m), Math.exp(-DEPTH[2] * m)];
  const l = LUM(t);
  // The upper limb sets last: fade over the half degree the disc takes to go.
  const fade = Math.min(1, (altitude + 0.5) / 1.0);
  return { lux: SOLAR_LUX * Math.exp(-EXTINCTION * m) * fade, color: [t[0] / l, t[1] / l, t[2] / l] };
}

/** The sun's place at an instant from a latitude and longitude (degrees, east positive). */
export function sunPlaceAt(ms: number, latitude: number, longitude: number): SkyPlace {
  const p = sunAt(ms, latitude, longitude);
  return { azimuth: p.azimuth, altitude: p.altitude };
}

/** Sunrise, noon and sunset on the day starting at `midnight` (UTC ms) — the dusk sky's sun. */
export function sunsetPlace(day: SunDay, latitude: number, longitude: number): SkyPlace | null {
  if (day.sunset === null) return null;
  return { azimuth: sunAt(day.sunset, latitude, longitude).azimuth, altitude: DEFAULT_DUSK.altitude };
}

export { sunDay };

// ─── The sky ─────────────────────────────────────────────────────────────────────────────────

/** A light from one direction: the sun, or the moon. */
export interface DirectLight {
  readonly kind: 'sun' | 'moon';
  readonly place: SkyPlace;
  /** Unit, toward it, in the project's frame. */
  readonly dir: Vec3;
  /** Illuminance on a surface square to it, lux. */
  readonly lux: number;
  /** Linear RGB, luminance 1. */
  readonly color: Vec3;
  /** Half the angle its disc subtends, radians: the softness of its shadows. */
  readonly radius: number;
}

/** One map in the dome: how much of it, scaled to cd/m², and turned so u = `u0` + azimuth/360. */
export interface SkyLayer {
  readonly map: SkyMapId;
  readonly weight: number;
  /** The illuminance its upper hemisphere gives a level surface, lux: its scale, with the map's own. */
  readonly lux: number;
  readonly u0: number;
  /** A colour it is seen through (luminance 1): night's moonlit blue, the photograph's grey taken out. */
  readonly tint: Vec3;
}

/** What a sky preset is at a moment: everything a view needs to draw and light with it. */
export interface SkyLight {
  readonly preset: SkyPreset;
  /** The exposure band it is seen in (FLR-T-13.1, `EXPOSURE_PER_NIT`): day, or after dark. */
  readonly band: 'day' | 'dusk' | 'night';
  /** The sun's place (true azimuth), after dark too; null for studio. */
  readonly sun: SkyPlace | null;
  /** The sun by day, the moon at night, a soft key in the studio; null at dusk. */
  readonly direct: DirectLight | null;
  readonly layers: readonly SkyLayer[];
  /** Studio: an even dome (cd/m² at the zenith) instead of maps. */
  readonly studio: number | null;
  /**
   * What lies on the ground: the lawn — `tint` a multiplier on its grass (linear RGB) for the look's
   * season and wetness, `albedo` its average — or a plain floor (`grass` false): the studio's pale
   * one, or light snow (FLR-T-15.4).
   */
  readonly ground: { readonly grass: boolean; readonly albedo: Vec3; readonly tint: Vec3 };
  /** The season and the weather it is seen in (FLR-T-15.4): a look, never the model's. */
  readonly look: Look;
  /**
   * The haze, metres: nothing is lost in it nearer than `near`, everything past `far`, smoothly
   * between — so the house is clear and the lawn fades into the horizon's colour well before its edge.
   */
  readonly haze: { readonly near: number; readonly far: number };
  readonly trueNorth: number;
}

/** Clear-sky illuminance on a level surface from the sky alone (no sun), lux, by the sun's altitude. */
function clearSkyLux(altitude: number): number {
  return 2500 + 21_000 * Math.max(0, Math.sin(Math.max(0.5, altitude) * RAD)) ** 0.8;
}
/** Overcast: everything comes from the sky. */
function overcastLux(altitude: number): number {
  return 500 + 20_000 * Math.max(0, Math.sin(Math.max(0.5, altitude) * RAD)) ** 1.1;
}
/** Twilight's sky, lux, by the sun's (negative) altitude: about a decade every 2.5° (civil twilight ends near 3 lux). */
function twilightLux(altitude: number): number {
  return 400 * 10 ** (0.4 * Math.min(0, altitude));
}
/** A moonlit night's sky, lux (and the moon's own, square to it). */
const NIGHT_SKY_LUX = 0.8;
/** Night's sky is seen blue — the Purkinje shift, and every night photograph of a house. */
const NIGHT_TINT: Vec3 = (() => {
  const c: Vec3 = [0.5, 0.72, 1.45];
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [c[0] / l, c[1] / l, c[2] / l];
})();
const MOON_LUX = 0.6;
const MOON_COLOR: Vec3 = (() => {
  const c: Vec3 = [0.72, 0.85, 1];
  const l = LUM(c);
  return [c[0] / l, c[1] / l, c[2] / l];
})();
/** The studio's dome at the zenith, cd/m², and its soft key. */
const STUDIO_ZENITH = 4000;
const STUDIO_FLOOR: Vec3 = [0.55, 0.55, 0.56];
const STUDIO_KEY: SkyPlace = { azimuth: 225, altitude: 50 };
const STUDIO_KEY_LUX = 25_000;
/** The haze, metres: clear to a couple of hundred metres, gone by two and a half kilometres. */
const HAZE = { near: 200, far: 2400 } as const;
/** Degrees over the horizon in which the sky fades into the haze's colour, as a real horizon does. */
export const HORIZON_BAND = 4;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A map layer at a weight and an illuminance, turned so its sun's glow is at `azimuth` (true). */
function layer(map: SkyMapId, weight: number, lux: number, azimuth: number): SkyLayer {
  return { map, weight, lux, u0: SKY_MAP_SUNS[map].u - azimuth / 360, tint: map === 'night' ? NIGHT_TINT : [1, 1, 1] };
}

/**
 * The sky for a preset, with the sun at `sun` (true azimuth and apparent altitude; null for the
 * preset's own) and the site's true north (degrees, Core 1.8).
 *
 * - `clear`: the sun where it is; its sky follows it — past 6° the clear sky, through sunset into the
 *   dusk sky, past 2° under into night's.
 * - `overcast`: no direct sun; the cloud's brightness follows the sun's altitude, and it darkens into
 *   night the same way.
 * - `dusk`: the sky just after sunset, the sun 3° under the horizon at its bearing (the date's
 *   sunset, from the caller), no direct light.
 * - `night`: moonlight, the moon opposite the sun.
 * - `studio`: an even bright dome, a soft key from the south-west, a pale floor.
 */
export function skyLight(preset: SkyPreset, sun: SkyPlace | null, trueNorth = 0, request: LookRequest = {}): SkyLight {
  // FLR-T-15.4: the season and the weather; by default summer and the weather the preset is, which
  // change nothing — every multiplier below is exactly 1 — so a view that names neither is as it was.
  const look: Look = { season: request.season ?? DEFAULT_SEASON, weather: request.weather ?? weatherOfSky(preset) };
  const weather = WEATHER_SKY[look.weather];
  const tint = lookSkyTint(look);
  const lawn = groundLook(look, lawnAlbedo());
  const base = { preset, trueNorth, haze: weather.haze ?? HAZE, ground: lawn, studio: null, look } as const;
  const tinted = (l: SkyLayer): SkyLayer => ({ ...l, tint: [l.tint[0] * tint[0], l.tint[1] * tint[1], l.tint[2] * tint[2]] });
  const moonFor = (s: SkyPlace, weight: number): DirectLight | null => {
    if (weight <= 0) return null;
    const place = { azimuth: (s.azimuth + 180) % 360, altitude: 35 };
    return { kind: 'moon', place, dir: placeVector(place, trueNorth), lux: MOON_LUX * weight, color: MOON_COLOR, radius: 0.26 * RAD };
  };
  const night = (s: SkyPlace, weight: number): SkyLayer => layer('night', weight, NIGHT_SKY_LUX, (s.azimuth + 180) % 360);
  switch (preset) {
    case 'studio': {
      const dir = placeVector(STUDIO_KEY, trueNorth);
      return { ...base, haze: HAZE, ground: { grass: false, albedo: STUDIO_FLOOR, tint: [1, 1, 1] }, studio: STUDIO_ZENITH, band: 'day', sun: null, layers: [], direct: { kind: 'sun', place: STUDIO_KEY, dir, lux: STUDIO_KEY_LUX, color: [1, 1, 1], radius: 8 * RAD } };
    }
    case 'night': {
      const s = sun ?? DEFAULT_SUN;
      return { ...base, band: 'night', sun: s, direct: moonFor(s, 1), layers: [night(s, 1)].map(tinted) };
    }
    case 'dusk': {
      const s = { azimuth: (sun ?? DEFAULT_DUSK).azimuth, altitude: DEFAULT_DUSK.altitude };
      return { ...base, band: 'dusk', sun: s, direct: null, layers: [layer('dusk', 1, twilightLux(s.altitude), s.azimuth)].map(tinted) };
    }
    case 'overcast':
    case 'clear': {
      const s = sun ?? DEFAULT_SUN;
      const a = s.altitude;
      const layers: SkyLayer[] = [];
      // The day's own sky, fading out from 6° to 2° under the horizon.
      const dayW = smoothstep(-2, 6, a);
      const darkW = smoothstep(-2, -10, a) * (1 - dayW);
      const duskW = Math.max(0, 1 - dayW - darkW);
      if (preset === 'clear') {
        if (dayW > 0) layers.push(layer('clear', dayW, clearSkyLux(a), s.azimuth));
        if (duskW > 0) layers.push(layer('dusk', duskW, twilightLux(Math.min(a, 0)), s.azimuth));
      } else {
        const overcast = dayW + duskW;
        // Rain's cloud is darker than an overcast day's, snow's a little brighter (WEATHER_SKY).
        if (overcast > 0) layers.push(layer('overcast', overcast, (a > 0 ? overcastLux(a) : 0.5 * twilightLux(a)) * weather.lux, s.azimuth));
      }
      if (darkW > 0) layers.push(night(s, darkW));
      const light = preset === 'clear' ? sunlight(a) : { lux: 0, color: [1, 1, 1] as Vec3 };
      const direct: DirectLight | null =
        light.lux > 0 ? { kind: 'sun', place: s, dir: placeVector(s, trueNorth), lux: light.lux, color: light.color, radius: 0.27 * RAD } : moonFor(s, darkW);
      const band = a > 0 ? 'day' : a > -10 ? 'dusk' : 'night';
      return { ...base, band, sun: s, direct, layers: layers.map(tinted) };
    }
  }
}

/** A map's radiance (its own units) along a true azimuth (degrees) and elevation (degrees, ≥ −6), bilinear, into `out`. */
function lookup(m: SkyMap, u: number, elevation: number, out: Float64Array, k: number): void {
  const W = m.width;
  const fx = (u - Math.floor(u)) * W - 0.5;
  const fy = Math.min(m.height - 1, Math.max(0, (90 - elevation) * rowsPerDegree(W) - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;
  const xa = ((x0 % W) + W) % W;
  const xb = (xa + 1) % W;
  const yb = Math.min(m.height - 1, y0 + 1);
  const d = m.data;
  for (let c = 0; c < 3; c++) {
    const top = d[3 * (y0 * W + xa) + c]! * (1 - ax) + d[3 * (y0 * W + xb) + c]! * ax;
    const bottom = d[3 * (yb * W + xa) + c]! * (1 - ax) + d[3 * (yb * W + xb) + c]! * ax;
    out[c] = out[c]! + (top * (1 - ay) + bottom * ay) * k;
  }
}

const scratch = new Float64Array(3);

/** The dome alone (no ground) along a direction above the horizon, cd/m², into `out`. */
function dome(light: SkyLight, maps: SkyMaps, azimuth: number, elevation: number, out: Float64Array): void {
  out[0] = out[1] = out[2] = 0;
  if (light.studio !== null) {
    // Bright overhead, a little less toward the horizon: a softbox dome.
    const k = light.studio * (0.62 + 0.38 * Math.sin(Math.max(0, elevation) * RAD));
    out[0] = out[1] = out[2] = k;
    return;
  }
  for (const l of light.layers) {
    const m = maps[l.map];
    if (m === undefined || l.weight <= 0 || m.illuminance <= 0) continue;
    const k = (l.lux / m.illuminance) * l.weight;
    const r: number = out[0];
    const g: number = out[1];
    const b: number = out[2];
    out[0] = out[1] = out[2] = 0;
    lookup(m, l.u0 + azimuth / 360, Math.max(0, elevation), out, k);
    out[0] = r + out[0] * l.tint[0];
    out[1] = g + out[1] * l.tint[1];
    out[2] = b + out[2] * l.tint[2];
  }
}

/** The horizon's radiance (cd/m²): the dome's, averaged round the horizon at the top of its band — the haze's colour. */
export function horizonRadiance(light: SkyLight, maps: SkyMaps): Vec3 {
  const sum: Vec3 = [0, 0, 0];
  const n = 72;
  for (let i = 0; i < n; i++) {
    dome(light, maps, (i * 360) / n, HORIZON_BAND, scratch);
    sum[0] += scratch[0]!;
    sum[1] += scratch[1]!;
    sum[2] += scratch[2]!;
  }
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

/** Illuminance on a level surface, lux: from the dome (summed over it) and from the direct light. */
export function skyIlluminance(light: SkyLight, maps: SkyMaps): { sky: number; direct: number } {
  let sky = 0;
  const rows = 24;
  const cols = 48;
  for (let j = 0; j < rows; j++) {
    const el = ((j + 0.5) / rows) * 90;
    const dOmega = Math.cos(el * RAD) * ((90 / rows) * RAD) * ((2 * Math.PI) / cols);
    for (let i = 0; i < cols; i++) {
      dome(light, maps, ((i + 0.5) * 360) / cols, el, scratch);
      sky += LUM([scratch[0]!, scratch[1]!, scratch[2]!]) * Math.sin(el * RAD) * dOmega;
    }
  }
  const d = light.direct;
  return { sky, direct: d === null ? 0 : d.lux * Math.max(0, d.dir[2]) };
}

/** The ground's radiance far off (cd/m²): its albedo under the sun and sky. */
export function groundRadiance(light: SkyLight, maps: SkyMaps): Vec3 {
  const e = skyIlluminance(light, maps);
  const d = light.direct;
  const a = light.ground.albedo;
  const tint: Vec3 = d === null ? [1, 1, 1] : d.color;
  const sky = e.sky / Math.PI;
  const sun = e.direct / Math.PI;
  return [a[0] * (sky + sun * tint[0]), a[1] * (sky + sun * tint[1]), a[2] * (sky + sun * tint[2])];
}

export interface SkyField {
  readonly light: SkyLight;
  readonly maps: SkyMaps;
  /** The haze's colour: the horizon's radiance. */
  readonly horizon: Vec3;
  /** The lawn (or floor) far off, lit. */
  readonly ground: Vec3;
}

/** Everything `skyRadiance` needs, worked out once. */
export function skyField(light: SkyLight, maps: SkyMaps): SkyField {
  return { light, maps, horizon: horizonRadiance(light, maps), ground: groundRadiance(light, maps) };
}

/**
 * The sky's radiance along a direction in the project's frame (unit), cd/m², into `out` — the sun's
 * disc excluded (every view adds the direct light itself). Below the horizon, the ground far off,
 * lost in the haze as it nears the horizon.
 */
export function skyRadiance(field: SkyField, d: readonly [number, number, number] | Float64Array, out: Float64Array): void {
  const z = Math.max(-1, Math.min(1, d[2]));
  const elevation = Math.asin(z) * DEG;
  if (elevation >= 0) {
    const azimuth = Math.atan2(d[0], d[1]) * DEG + field.light.trueNorth;
    dome(field.light, field.maps, azimuth, elevation, out);
    // Low over the horizon, the sky fades into the haze, which the far ground fades into too.
    if (elevation < HORIZON_BAND) {
      const w = smoothstep(0, HORIZON_BAND, elevation);
      const h = field.horizon;
      out[0] = h[0] + (out[0]! - h[0]) * w;
      out[1] = h[1] + (out[1]! - h[1]) * w;
      out[2] = h[2] + (out[2]! - h[2]) * w;
    }
    return;
  }
  // The ground far off, lost in the haze as it nears the horizon: past a view's own ground (a lawn
  // a few kilometres across), all haze.
  const t = 1 - smoothstep(0.5, 8, -elevation);
  const g = field.ground;
  const h = field.horizon;
  out[0] = g[0] + (h[0] - g[0]) * t;
  out[1] = g[1] + (h[1] - g[1]) * t;
  out[2] = g[2] + (h[2] - g[2]) * t;
}

/** How much of what lies `distance` metres off is lost in the haze (0 near, 1 far): three.js's linear fog's smoothstep. */
export function hazeAt(light: SkyLight, distance: number): number {
  return smoothstep(light.haze.near, light.haze.far, distance);
}

/**
 * For a view that does not bounce light (the editor's, the headless render's): an even fill for what
 * a sunlit lawn and the house's own sunlit walls bounce about — a twelfth of the sun's light on a
 * level surface, in its colour, lux. The path tracers bounce it for real and add none.
 */
export function skyBounce(light: SkyLight): { lux: number; color: Vec3 } {
  const d = light.direct;
  if (d === null || d.kind !== 'sun' || light.studio !== null) return { lux: 0, color: [1, 1, 1] };
  return { lux: (d.lux * Math.max(0, d.dir[2])) / 12, color: d.color };
}

// ─── Image-based light: spherical harmonics ──────────────────────────────────────────────────

/**
 * The sky's radiance projected onto the first nine spherical harmonics, in the project's frame (its
 * ground's bounce greyed),
 * nine RGB triples — three.js's `SphericalHarmonics3` convention, so a `LightProbe` given these
 * lights a surface with the sky's irradiance in lux (`irradianceAt`).
 */
export function skyHarmonics(field: SkyField): Float64Array {
  const sh = new Float64Array(27);
  const rows = 32;
  const cols = 64;
  const d = new Float64Array(3);
  const L = new Float64Array(3);
  for (let j = 0; j < rows; j++) {
    const theta = ((j + 0.5) / rows) * Math.PI; // from straight up
    const z = Math.cos(theta);
    const r = Math.sin(theta);
    const dOmega = r * (Math.PI / rows) * ((2 * Math.PI) / cols);
    for (let i = 0; i < cols; i++) {
      const phi = ((i + 0.5) / cols) * 2 * Math.PI;
      d[0] = r * Math.cos(phi);
      d[1] = r * Math.sin(phi);
      d[2] = z;
      skyRadiance(field, d, L);
      // From below, a neutral bounce of the ground's brightness, not its green: in a view without
      // occlusion every ceiling sees the ground, and a lawn-green ceiling indoors reads as wrong.
      if (z < 0) {
        const g = LUM([L[0]!, L[1]!, L[2]!]);
        L[0] = L[1] = L[2] = g;
      }
      const x = d[0];
      const y = d[1];
      const basis = [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
      for (let k = 0; k < 9; k++) {
        const w = basis[k]! * dOmega;
        sh[3 * k] = sh[3 * k]! + L[0]! * w;
        sh[3 * k + 1] = sh[3 * k + 1]! + L[1]! * w;
        sh[3 * k + 2] = sh[3 * k + 2]! + L[2]! * w;
      }
    }
  }
  return sh;
}

/** Irradiance (lux, RGB) on a surface with normal `n` from harmonics: three.js's `shGetIrradianceAt`. */
export function irradianceAt(sh: Float64Array, n: readonly [number, number, number] | Float64Array, out: Float64Array): void {
  const x = n[0];
  const y = n[1];
  const z = n[2];
  const k = [0.886227, 2 * 0.511664 * y, 2 * 0.511664 * z, 2 * 0.511664 * x, 2 * 0.429043 * x * y, 2 * 0.429043 * y * z, 0.743125 * z * z - 0.247708, 2 * 0.429043 * x * z, 0.429043 * (x * x - y * y)];
  for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let i = 0; i < 9; i++) s += sh[3 * i + c]! * k[i]!;
    out[c] = Math.max(0, s);
  }
}

// ─── Exposure ────────────────────────────────────────────────────────────────────────────────

/** The exposure band a sky is seen in (per cd/m²): FLR-T-13.1's day band, or its after-dark one. */
export function exposureBand(light: SkyLight): { readonly min: number; readonly max: number } {
  return light.band === 'day' ? { min: EXPOSURE_PER_NIT.day, max: EXPOSURE_PER_NIT.dayMax } : { min: EXPOSURE_PER_NIT.night, max: EXPOSURE_PER_NIT.nightMax };
}

/**
 * How far an outside view after dark may be opened up, per cd/m²: a moonlit night reads as a dim,
 * blue picture of the house — the long exposure a night photograph of a house is — rather than black.
 * A view with its lamps on is exposed for them instead (FLR-T-13.1's night band), and the night
 * outside it stays dark.
 */
export const NIGHT_SKY_EXPOSURE_MAX = 0.3;

/**
 * What a view that does not meter its picture gives the tone curve per cd/m² under a sky: the key
 * (0.18) on a surface of reflectance 0.2 under the sky's and the sun's light on a level surface —
 * what a camera metering an outdoor scene does — held within the day band by day; after dark, the
 * key 0.08, between the night band's least and `NIGHT_SKY_EXPOSURE_MAX`.
 */
export function skyExposure(light: SkyLight, maps: SkyMaps): number {
  const e = skyIlluminance(light, maps);
  const nits = (0.2 * (e.sky + e.direct)) / Math.PI;
  const band = light.band === 'day' ? exposureBand(light) : { min: EXPOSURE_PER_NIT.night, max: NIGHT_SKY_EXPOSURE_MAX };
  // After dark, a stop and more under the day's key: dusk and night read as dusk and night. Rain
  // reads darker than a meter would make it, snow brighter (FLR-T-15.4); exactly the key otherwise.
  const key = (light.band === 'day' ? 0.18 : 0.08) * (light.look.weather === 'rain' ? 0.72 : light.look.weather === 'snow' ? 1.3 : 1);
  return Math.min(band.max, Math.max(band.min, key / Math.max(1e-9, nits)));
}

/** A sky preset's swatch for a picker: its zenith, its horizon and its ground, as linear RGB at its own exposure. */
export function skySwatch(field: SkyField, exposure: number): { zenith: Vec3; horizon: Vec3; ground: Vec3 } {
  const up = new Float64Array(3);
  skyRadiance(field, [0, 0, 1], up);
  const k = exposure;
  return {
    zenith: [up[0]! * k, up[1]! * k, up[2]! * k],
    horizon: [field.horizon[0] * k, field.horizon[1] * k, field.horizon[2] * k],
    ground: [field.ground[0] * k, field.ground[1] * k, field.ground[2] * k],
  };
}

/** The maps a preset's sky draws on: what a view must load before it can show it. */
export function mapsFor(light: SkyLight): SkyMapId[] {
  return [...new Set(light.layers.filter((l) => l.weight > 0).map((l) => l.map))];
}
