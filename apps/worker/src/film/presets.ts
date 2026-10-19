/**
 * What a film may be asked for (FLR-T-14.1): its quality, its frame size and rate, its container and
 * its light — kept apart from the renderer so the api can check a request, and the editor offer the
 * choices, without loading it.
 *
 * A draft is drawn by the worker's rasterizer; a final is path-traced, each frame as a still within a
 * still's work budget (pathtrace/presets.ts `MAX_WORK`): as many samples a pixel as that allows at
 * its size, up to 256 — 128 at 720p, 64 at 1080p — and 4K is drafts only.
 */
import { MAX_WORK } from '../pathtrace/presets.js';

export const FILM_SIZES = { '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160] } as const;
export type FilmSize = keyof typeof FILM_SIZES;
export const FILM_RATES = [24, 30, 60] as const;
export type FilmRate = (typeof FILM_RATES)[number];
export const FILM_FORMATS = ['mp4', 'webm'] as const;
export type FilmFormat = (typeof FILM_FORMATS)[number];
export const FILM_QUALITIES = ['draft', 'final'] as const;
export type FilmQuality = (typeof FILM_QUALITIES)[number];
/** The film's light: as its keyframes have it, fixed for the whole film, or the day-to-night timelapse. */
export const FILM_LIGHTS = ['timeline', 'day-to-night'] as const;
export type FilmLight = (typeof FILM_LIGHTS)[number];

export const FILM_CONTENT_TYPES: Readonly<Record<FilmFormat, string>> = { mp4: 'video/mp4', webm: 'video/webm' };

/** The most samples a pixel a final frame takes. */
export const FINAL_SAMPLES_MAX = 256;
/** Fewer than this and a final is no better than a draft: the size is drafts only. */
export const FINAL_SAMPLES_MIN = 32;

/** A final frame's samples a pixel at a size — a power of two within a still's work budget — or null when the size is drafts only. */
export function finalSamples(size: FilmSize): number | null {
  const [w, h] = FILM_SIZES[size];
  const most = Math.min(FINAL_SAMPLES_MAX, MAX_WORK / (w * h));
  const samples = 2 ** Math.floor(Math.log2(most));
  return samples < FINAL_SAMPLES_MIN ? null : samples;
}

/** The most frames one film renders: two minutes at 30 fps, or one at 60. */
export const MAX_FILM_FRAMES = 3600;
/** A final frame that runs longer than this is stopped, with a reason a person can read. */
export const FINAL_FRAME_BUDGET_MS = 20 * 60_000;
/** The biggest file a film may be: the job store keeps it in Postgres. */
export const MAX_FILM_BYTES = 512 * 1024 * 1024;

/** What is wrong with a film request's choices, in words; null when nothing. */
export function filmChoiceProblem(quality: FilmQuality, size: FilmSize, frames: number): string | null {
  if (quality === 'final' && finalSamples(size) === null) return `a final film is path-traced frame by frame: ${size} is for drafts — choose 1080p or 720p`;
  if (frames > MAX_FILM_FRAMES) return `a film renders at most ${String(MAX_FILM_FRAMES)} frames: choose a lower frame rate or a shorter film`;
  return null;
}
