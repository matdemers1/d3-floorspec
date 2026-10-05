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

/** Degrees. Azimuth clockwise from true north; altitude above the horizon. */
export interface SunInput {
  readonly azimuth: number;
  readonly altitude: number;
}
/** Mid-afternoon from the south-west: the sun when the request names none. */
export const DEFAULT_SUN: SunInput = { azimuth: 225, altitude: 35 };
