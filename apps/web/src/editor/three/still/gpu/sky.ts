/**
 * The light a GPU still is seen in (FLR-T-13.13, FLR-ADR-040): the worker's path tracer's sun and
 * sky (apps/worker/src/pathtrace — `sunOf`, `skyRadiance`, the dusk and night skies, the ground
 * plate), in photometric units — lux for the sun, cd/m² for the sky — so the editor's still and the
 * server's agree. The worker's tracer is the reference: its unit of irradiance is 12 500 lx, so a
 * radiance of 1 there is 12 500 cd/m² here. Kept free of three.js so the worker's tests can hold the
 * two to each other (apps/worker/test/gpu-sky.test.ts) until FLR-T-13.4 shares the sky presets.
 */

export type Vec3 = [number, number, number];
export type TimeOfDay = 'day' | 'dusk' | 'night';

/** The worker's tracer's irradiance unit, in lux: its sun's 8 is about 100 000 lx. */
export const LUX_PER_UNIT = 12_500;

/**
 * The unit the GPU still is traced in, cd/m² (and lux): the worker tracer's. Light is divided by it
 * going in and the picture exposed back by it, so the tracer works with radiance of order 1.
 */
export const TRACE_UNIT = LUX_PER_UNIT;

/** The sky by time of day, scaled per channel: dusk a deep blue, night all but black (the worker's `SKY`). */
export const SKY_SCALE: Readonly<Record<TimeOfDay, Vec3>> = { day: [1, 1, 1], dusk: [0.0006, 0.0008, 0.0014], night: [0.00008, 0.0001, 0.00018] };

/** The ground plate under the house: the worker's, a pale gravel (#cfcabd). */
export const GROUND = '#cfcabd';

/** Degrees. Azimuth clockwise from true north; altitude above the horizon. */
export interface SunInput {
  readonly azimuth: number;
  readonly altitude: number;
}
/** Mid-afternoon from the south-west: the worker's default sun. */
export const DEFAULT_SUN: SunInput = { azimuth: 225, altitude: 35 };

export interface Sun {
  /** Unit, toward the sun, in the scene's frame (x east-ish, +Y up, −Z project north). */
  readonly dir: Vec3;
  /** Irradiance on a surface square to it, lux. */
  readonly lux: number;
  /** Linear RGB. */
  readonly color: Vec3;
}

const DEG = Math.PI / 180;

/** The sun in the scene's frame, turned by the site's true north: the worker's `sunOf`, in lux. */
export function sunOf(input: SunInput, trueNorthDeg: number): Sun {
  const b = (input.azimuth - trueNorthDeg) * DEG;
  const alt = Math.max(1, Math.min(90, input.altitude)) * DEG;
  const dir: Vec3 = [Math.sin(b) * Math.cos(alt), Math.sin(alt), -Math.cos(b) * Math.cos(alt)];
  const low = Math.max(0, Math.min(1, (25 - input.altitude) / 25));
  return { dir, lux: 8 * (1 - 0.35 * low) * LUX_PER_UNIT, color: [1, 0.96 - 0.12 * low, 0.9 - 0.25 * low] };
}

/** The sky's radiance along a direction, cd/m² (the sun's disc excluded): the worker's `skyRadiance`. */
export function skyRadiance(d: Vec3, sun: Sun): Vec3 {
  if (d[1] <= 0) return [0.12 * LUX_PER_UNIT, 0.115 * LUX_PER_UNIT, 0.1 * LUX_PER_UNIT];
  const t = Math.pow(d[1], 0.55);
  const glow = Math.pow(Math.max(0, d[0] * sun.dir[0] + d[1] * sun.dir[1] + d[2] * sun.dir[2]), 12) * 0.35;
  return [
    ((0.62 + (0.16 - 0.62) * t) * 0.62 + glow * sun.color[0]) * LUX_PER_UNIT,
    ((0.69 + (0.27 - 0.69) * t) * 0.62 + glow * sun.color[1]) * LUX_PER_UNIT,
    ((0.78 + (0.55 - 0.78) * t) * 0.62 + glow * sun.color[2]) * LUX_PER_UNIT,
  ];
}

/**
 * The sky as an equirectangular map, RGBA floats, cd/m², rows from straight down to straight up —
 * three.js's equirectangular convention: u = atan2(z, x) / 2π + ½, v = asin(y) / π + ½.
 */
export function skyPixels(sun: Sun, time: TimeOfDay, width = 256, height = 128): Float32Array {
  const out = new Float32Array(width * height * 4);
  const scale = SKY_SCALE[time];
  for (let j = 0; j < height; j++) {
    const theta = ((j + 0.5) / height - 0.5) * Math.PI;
    for (let i = 0; i < width; i++) {
      const phi = ((i + 0.5) / width - 0.5) * 2 * Math.PI;
      const d: Vec3 = [Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi)];
      const r = skyRadiance(d, sun);
      const o = 4 * (j * width + i);
      out[o] = r[0] * scale[0];
      out[o + 1] = r[1] * scale[1];
      out[o + 2] = r[2] * scale[2];
      out[o + 3] = 1;
    }
  }
  return out;
}

/**
 * What the tone curve is given per cd/m² (FLR-T-13.1's calibration): a still is metered to a key of
 * 0.18 within its time of day's band — by day from a sunlit exterior to a daylit room, after dark
 * from a room lit by its lamps to one lit by a single light.
 */
export const EXPOSURE_BAND: Readonly<Record<TimeOfDay, { readonly min: number; readonly max: number }>> = {
  day: { min: 1.6e-5, max: 2e-3 },
  dusk: { min: 0.01, max: 0.04 },
  night: { min: 0.01, max: 0.04 },
};

/** The exposure for an image's log-average luminance (cd/m²): key 0.18, held within the band. */
export function meteredExposure(logAverage: number, time: TimeOfDay): number {
  const band = EXPOSURE_BAND[time];
  const e = 0.18 / Math.max(1e-6, logAverage);
  return Math.min(band.max, Math.max(band.min, e));
}

/**
 * three.js's `toneMappingExposure` for an exposure: its ACES filmic curve divides what it is given by
 * 0.6, where the worker's fit of the same curve does not.
 */
export const toneMappingExposure = (exposure: number): number => exposure * 0.6;
