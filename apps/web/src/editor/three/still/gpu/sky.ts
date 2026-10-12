/**
 * The light a GPU still is seen in (FLR-T-13.13, FLR-ADR-040; FLR-T-13.4): @floorspec/mesh's sky —
 * the same presets, sun and HDRI dome the worker's path tracer reads — in photometric units, lux for
 * the sun and cd/m² for the sky, so the editor's still and the server's agree. The worker's tracer
 * is the reference for units: its unit of irradiance is 12 500 lx, so a radiance of 1 there is
 * 12 500 cd/m² here. Kept free of three.js so the worker's tests can hold the two to each other
 * (apps/worker/test/gpu-sky.test.ts).
 */

import { EXPOSURE_PER_NIT } from '@floorspec/mesh';
import { DEFAULT_SUN as MESH_DEFAULT_SUN, skyRadiance, type SkyField, type SkyLight } from '@floorspec/mesh/sky';

export type Vec3 = [number, number, number];
export type TimeOfDay = 'day' | 'dusk' | 'night';
export const TIMES: readonly TimeOfDay[] = ['day', 'dusk', 'night'];

/** The worker's tracer's irradiance unit, in lux: its sun's 8 is about 100 000 lx. */
export const LUX_PER_UNIT = 12_500;

/**
 * The unit the GPU still is traced in, cd/m² (and lux): the worker tracer's. Light is divided by it
 * going in and the picture exposed back by it, so the tracer works with radiance of order 1.
 */
export const TRACE_UNIT = LUX_PER_UNIT;

/** Degrees. Azimuth clockwise from true north; altitude above the horizon. */
export interface SunInput {
  readonly azimuth: number;
  readonly altitude: number;
}
/** Mid-afternoon from the south-west: the worker's default sun. */
export const DEFAULT_SUN: SunInput = MESH_DEFAULT_SUN;

export interface Sun {
  /** Unit, toward the sun, in the scene's frame (x east-ish, +Y up, −Z project north). */
  readonly dir: Vec3;
  /** Irradiance on a surface square to it, lux. */
  readonly lux: number;
  /** Linear RGB. */
  readonly color: Vec3;
}

/** A project-frame direction (x, y north, z up) in the scene's (x, +Y up, −Z north). */
const toScene = (d: readonly [number, number, number]): Vec3 => [d[0], d[2], -d[1]];

/** The sky's direct light — the sun, the moon, the studio's key — in the scene's frame, lux; null at dusk. */
export function stillSun(light: SkyLight): Sun | null {
  const d = light.direct;
  return d === null ? null : { dir: toScene(d.dir), lux: d.lux, color: [d.color[0], d.color[1], d.color[2]] };
}

/**
 * The sky as an equirectangular map, RGBA floats, cd/m², rows from straight down to straight up —
 * three.js's equirectangular convention: u = atan2(z, x) / 2π + ½, v = asin(y) / π + ½ — read from
 * @floorspec/mesh's sky (FLR-T-13.4), the worker's tracer's own: its HDRI dome, and below the
 * horizon the lawn far off in the haze.
 */
export function skyPixels(field: SkyField, width = 1024, height = 512): Float32Array {
  const out = new Float32Array(width * height * 4);
  const L = new Float64Array(3);
  const d = new Float64Array(3);
  for (let j = 0; j < height; j++) {
    const theta = ((j + 0.5) / height - 0.5) * Math.PI;
    for (let i = 0; i < width; i++) {
      const phi = ((i + 0.5) / width - 0.5) * 2 * Math.PI;
      // The scene's (x, y, z) is the project's (x, −z, y).
      const sx = Math.cos(theta) * Math.cos(phi);
      const sy = Math.sin(theta);
      const sz = Math.cos(theta) * Math.sin(phi);
      d[0] = sx;
      d[1] = -sz;
      d[2] = sy;
      skyRadiance(field, d, L);
      const o = 4 * (j * width + i);
      out[o] = (L[0] ?? 0);
      out[o + 1] = (L[1] ?? 0);
      out[o + 2] = (L[2] ?? 0);
      out[o + 3] = 1;
    }
  }
  return out;
}

/**
 * What the tone curve is given per cd/m² (FLR-T-13.1, @floorspec/mesh `EXPOSURE_PER_NIT`): a still is
 * metered to a key of 0.18 within its time of day's band — by day from a sunlit exterior to a daylit
 * room, after dark from a room lit by its lamps to one lit by a single light — as the worker's
 * path tracer meters its own (pathtrace `EXPOSURE`, `exposureOf`).
 */
export const EXPOSURE_BAND: Readonly<Record<TimeOfDay, { readonly min: number; readonly max: number }>> = {
  day: { min: EXPOSURE_PER_NIT.day, max: EXPOSURE_PER_NIT.dayMax },
  dusk: { min: EXPOSURE_PER_NIT.night, max: EXPOSURE_PER_NIT.nightMax },
  night: { min: EXPOSURE_PER_NIT.night, max: EXPOSURE_PER_NIT.nightMax },
};

/** The photographic key a still is metered to. */
export const KEY = 0.18;

/**
 * The luminance (cd/m²) a pixel darker than counts as, when a still is metered: what the band's most
 * open exposure would show at a hundredth of the key — the worker's floor, so a black night sky does
 * not drag the average to nothing.
 */
export const meterFloor = (time: TimeOfDay): number => KEY / EXPOSURE_BAND[time].max / 100;

/**
 * The exposure for an image's log-average luminance (cd/m², each pixel counted as at least
 * `meterFloor`): the key over it, held within the band — the worker's `exposureOf`.
 */
export function meteredExposure(logAverage: number, time: TimeOfDay): number {
  const band = EXPOSURE_BAND[time];
  const e = KEY / Math.max(meterFloor(time), logAverage);
  return Math.min(band.max, Math.max(band.min, e));
}

/**
 * three.js's `toneMappingExposure` for an exposure: its ACES filmic curve divides what it is given by
 * 0.6, where the worker's fit of the same curve does not.
 */
export const toneMappingExposure = (exposure: number): number => exposure * 0.6;
