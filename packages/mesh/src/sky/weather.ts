/**
 * Seasons and weather (FLR-T-15.4): two looks a house is seen in, beside the sky and the time — any
 * season with any weather, and the time always the sun's. Each is a LOOK, never a change to the
 * model: nothing here is written to a document, and nothing in a quantity or a finding moves.
 *
 * - **A season** changes the plants (each by its FS_landscape `foliage`: a deciduous tree is bare in
 *   winter, coloured in autumn, fresh in spring; an evergreen, or a plant whose foliage is not stated,
 *   stays as it is — looks.ts), the ground (the lawn greener in spring, yellowing in autumn, dormant in
 *   winter) and the sky (a little warmer in autumn, paler and cooler in winter).
 * - **A weather** is a sky and what it does to surfaces: `clear` and `overcast` are the two skies;
 *   `rain` is a darker overcast that wets what is outside — darker and glossier, mirroring the sky —
 *   and `snow` a bright overcast that lays a light snow on what faces up outside: roofs, lawns, beds
 *   and the evergreens, the walks left cleared.
 *
 * The defaults are what every view drew before FLR-T-15.4: summer, and the weather a sky preset is
 * (an overcast sky's overcast, any other's clear) — so a request, a saved view or a film that names
 * neither is the same picture as it was. Isomorphic, pure arithmetic on plain data.
 */
import type { SkyPreset } from './sky.js';

type Vec3 = [number, number, number];

/** The seasons a view may be seen in, in the order a picker shows them. */
export const LOOK_SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type LookSeason = (typeof LOOK_SEASONS)[number];
export const SEASON_LABELS: Readonly<Record<LookSeason, string>> = { spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter' };
/** What every view drew before seasons: full summer canopy. */
export const DEFAULT_SEASON: LookSeason = 'summer';

/** The weathers, in the order a picker shows them (the board's "P15/Weather tile"). */
export const WEATHERS = ['clear', 'overcast', 'rain', 'snow'] as const;
export type Weather = (typeof WEATHERS)[number];
export const WEATHER_LABELS: Readonly<Record<Weather, string>> = { clear: 'Clear', overcast: 'Overcast', rain: 'Rain-wet', snow: 'Light snow' };

export const isLookSeason = (v: unknown): v is LookSeason => typeof v === 'string' && (LOOK_SEASONS as readonly string[]).includes(v);
export const isWeather = (v: unknown): v is Weather => typeof v === 'string' && (WEATHERS as readonly string[]).includes(v);

/** A season and a weather: everything a look is. */
export interface Look {
  readonly season: LookSeason;
  readonly weather: Weather;
}

/** A request's look, as it names it: either, both or neither. */
export interface LookRequest {
  readonly season?: LookSeason | undefined;
  readonly weather?: Weather | undefined;
}

/** The weather a sky preset already is: an overcast sky's overcast, every other's clear (dusk and night are clear skies after sunset; the studio has none). */
export const weatherOfSky = (sky: SkyPreset): Weather => (sky === 'overcast' ? 'overcast' : 'clear');

/**
 * The sky preset a weather is seen under, from the preset asked for: a clear weather keeps a clear,
 * dusk or night sky (and turns an overcast one clear); overcast, rain and snow are all an overcast
 * sky. The studio is a backdrop, not a sky: it stays, and the weather only touches the surfaces.
 */
export function skyForWeather(sky: SkyPreset, weather: Weather | undefined): SkyPreset {
  if (weather === undefined || sky === 'studio') return sky;
  if (weather === 'clear') return sky === 'overcast' ? 'clear' : sky;
  return 'overcast';
}

/** A request's look resolved against the sky it asked for: its defaults filled in, and the sky the weather is seen under. */
export function resolveLook(sky: SkyPreset, request: LookRequest = {}): { sky: SkyPreset; look: Look } {
  const preset = skyForWeather(sky, request.weather);
  return { sky: preset, look: { season: request.season ?? DEFAULT_SEASON, weather: request.weather ?? weatherOfSky(preset) } };
}

/** Whether a look is the one every view drew before seasons: summer, and no rain or snow. */
export const plainLook = (look: Look): boolean => look.season === 'summer' && (look.weather === 'clear' || look.weather === 'overcast');

/**
 * The season at a date, for "Follow the date": the meteorological seasons — March to May spring, June
 * to August summer, September to November autumn, December to February winter — turned half a year
 * south of the equator. `month` is 1–12.
 */
export function seasonOfMonth(month: number, latitude: number): LookSeason {
  const north: LookSeason[] = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];
  const m = (((Math.round(month) - 1) % 12) + 12) % 12;
  return north[latitude < 0 ? (m + 6) % 12 : m]!;
}

/** A colour scaled to luminance 1: a tint that changes a hue, not a brightness. */
function unit(c: Vec3): Vec3 {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [c[0] / l, c[1] / l, c[2] / l];
}
const ONE: Vec3 = [1, 1, 1];

/**
 * The sky's colour in each season (a tint on its maps, luminance 1): summer's as the maps are, spring a
 * touch fresher, autumn warmer, winter paler and cooler.
 */
export const SEASON_SKY_TINT: Readonly<Record<LookSeason, Vec3>> = {
  spring: unit([0.98, 1, 1.03]),
  summer: ONE,
  autumn: unit([1.06, 1, 0.9]),
  winter: unit([0.93, 0.99, 1.12]),
};

/**
 * What a weather does to the sky: the overcast's brightness as a share of an overcast day's (rain's
 * cloud is thick and dark; snow's bright), a tint (luminance 1), and the haze — rain and snow close it in.
 */
export const WEATHER_SKY: Readonly<Record<Weather, { readonly lux: number; readonly tint: Vec3; readonly haze: { readonly near: number; readonly far: number } | null }>> = {
  clear: { lux: 1, tint: ONE, haze: null },
  overcast: { lux: 1, tint: ONE, haze: null },
  rain: { lux: 0.45, tint: unit([0.9, 0.97, 1.08]), haze: { near: 90, far: 1100 } },
  snow: { lux: 1.08, tint: unit([0.96, 0.99, 1.06]), haze: { near: 140, far: 1500 } },
};

/** The sky's tint for a look: its season's and its weather's. */
export function lookSkyTint(look: Look): Vec3 {
  const s = SEASON_SKY_TINT[look.season];
  const w = WEATHER_SKY[look.weather].tint;
  return [s[0] * w[0], s[1] * w[1], s[2] * w[2]];
}

/**
 * The lawn in each season, as a multiplier on its summer colour (linear RGB): fresh and bright in
 * spring, yellowing in autumn, a dormant straw-green in winter.
 */
export const LAWN_TINT: Readonly<Record<LookSeason, Vec3>> = {
  spring: [0.95, 1.12, 0.9],
  summer: ONE,
  autumn: [1.18, 1.0, 0.82],
  winter: [1.2, 0.86, 1.05],
};

/**
 * Wet surfaces (rain): a darker albedo — water fills the pores, so less light scatters back out — and
 * a glossy film over them that mirrors the sky.
 */
export const WET = { darken: 0.58, roughness: 0.22 } as const;

/** A surface's albedo and roughness made wet. */
export function wetten(color: readonly [number, number, number], roughness: number): { color: Vec3; roughness: number } {
  return { color: [color[0] * WET.darken, color[1] * WET.darken, color[2] * WET.darken], roughness: Math.min(roughness, WET.roughness) };
}

/** A light snow's albedo (linear RGB): fresh snow, a little blue, a little grey where it is thin. */
export const SNOW_ALBEDO: Vec3 = [0.8, 0.82, 0.86];

/**
 * The ground a look stands the house on: the lawn in its season (a tint on the grass), darkened and
 * glossy when it rains, or under light snow — a plain field of snow, as the studio's floor is plain.
 * `albedo` is its average colour, what it bounces.
 */
export function groundLook(look: Look, lawn: Vec3): { grass: boolean; albedo: Vec3; tint: Vec3 } {
  if (look.weather === 'snow') return { grass: false, albedo: SNOW_ALBEDO, tint: ONE };
  const s = LAWN_TINT[look.season];
  const k = look.weather === 'rain' ? WET.darken : 1;
  const tint: Vec3 = [s[0] * k, s[1] * k, s[2] * k];
  return { grass: true, albedo: [lawn[0] * tint[0], lawn[1] * tint[1], lawn[2] * tint[2]], tint };
}

/** The look in words, for a caption: "Autumn · overcast", "Winter · light snow". */
export function describeLook(look: Look): string {
  return `${SEASON_LABELS[look.season]} · ${WEATHER_LABELS[look.weather].toLowerCase()}`;
}
