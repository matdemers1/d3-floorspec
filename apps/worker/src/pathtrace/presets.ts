/**
 * What a path-traced still may be asked for (FLR-T-12.6): three sizes, three qualities, a work
 * budget, a time budget and the default sun. Kept apart from the tracer so the api can check a
 * request — and the editor can offer the choices — without loading it.
 */

export const SIZES = { small: [640, 480], medium: [1024, 768], large: [1600, 1200] } as const;
export type Size = keyof typeof SIZES;
/** Samples a pixel. */
export const QUALITIES = { draft: 16, standard: 64, high: 256 } as const;
export type Quality = keyof typeof QUALITIES;
/** The most pixel-samples one still may take: medium at high quality. Large at high is refused. */
export const MAX_WORK = 1024 * 768 * 256;
/** A still that runs longer than this is stopped, with a reason a person can read. */
export const BUDGET_MS = 20 * 60_000;

/** Whether a size and quality are within the work budget. */
export function withinBudget(size: Size, quality: Quality): boolean {
  const [w, h] = SIZES[size];
  return w * h * QUALITIES[quality] <= MAX_WORK;
}

/** A saved view rendered for an agent (FLR-T-13.10, floorspec_render with `view`): its long side, pixels — the lit render's default and widest. */
export const VIEW_WIDTH = 800;
export const VIEW_MAX_WIDTH = 1280;

/** A shot list's sizes (FLR-T-13.10), by the picture's long side in pixels: each view's frame sets the other side. */
export const SHOT_SIZES = { small: 960, medium: 1440, large: 1920 } as const;
export type ShotSize = keyof typeof SHOT_SIZES;
/** The most views one shot list renders. */
export const MAX_SHOTS = 24;

/** Whether a shot list's size and quality are within a still's work budget for every frame (a square one is the most work). */
export function shotWithinBudget(size: ShotSize, quality: Quality): boolean {
  const long = SHOT_SIZES[size];
  return long * long * QUALITIES[quality] <= MAX_WORK;
}

/** Degrees. Azimuth clockwise from true north; altitude above the horizon. */
export interface SunInput {
  readonly azimuth: number;
  readonly altitude: number;
}
/** Mid-afternoon from the south-west: the sun when the request names none. */
export const DEFAULT_SUN: SunInput = { azimuth: 225, altitude: 35 };

/**
 * The light a still with its lamps is seen in (FLR-T-12.22): by day, under the sun and sky; at dusk,
 * the sun down and the sky a deep blue; at night, dark outside. A still with `lights` is night
 * unless it says otherwise.
 */
export const TIMES = ['day', 'dusk', 'night'] as const;
export type TimeOfDay = (typeof TIMES)[number];
/** Whether a lamp setting is one. */
export const LIGHTS = ['on', 'off'] as const;
export type Lights = (typeof LIGHTS)[number];

/**
 * The sky a 3D render or a still is seen under (FLR-T-13.4): @floorspec/mesh's presets (sky/sky.ts
 * `SKY_PRESETS`, which the worker's tests hold this list to), kept here as plain names so the api
 * can check a request without loading the sky.
 */
export const SKIES = ['clear', 'overcast', 'dusk', 'night', 'studio'] as const;
export type Sky = (typeof SKIES)[number];

/**
 * A date and time at the site (FLR-T-13.9): ISO 8601, `2026-06-21T19:30`, seconds optional, with
 * `Z` or an offset (`-04:00`) — or without, read in the site's zone by its longitude (15° an hour,
 * no daylight saving), since Floorspec records no time zone.
 */
export const AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/;

export interface At {
  /** The instant, UTC milliseconds. */
  readonly ms: number;
  /** Minutes east of UTC it was read in. */
  readonly offset: number;
  /** The offset was not given: it is the site's zone by its longitude. */
  readonly assumed: boolean;
  /** Local midnight that day, UTC milliseconds. */
  readonly midnight: number;
}

/** Read `at` for a site at `longitude` (degrees, east positive); null when it is not a date and time. */
export function parseAt(at: string, longitude: number): At | null {
  const m = AT_PATTERN.exec(at);
  if (m === null) return null;
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0)) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  const zone = m[7];
  let offset: number;
  if (zone === undefined) offset = Math.round(longitude / 15) * 60;
  else if (zone === 'Z') offset = 0;
  else {
    const sign = zone.startsWith('-') ? -1 : 1;
    const [oh, om] = zone.slice(1).split(':').map(Number) as [number, number];
    if (oh > 14 || om > 59) return null;
    offset = sign * (oh * 60 + om);
  }
  const midnight = Date.UTC(y, mo - 1, d) - offset * 60_000;
  return { ms: midnight + ((h * 60 + mi) * 60 + s) * 1000, offset, assumed: zone === undefined, midnight };
}
