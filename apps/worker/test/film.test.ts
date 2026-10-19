/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UNITS_PER_METRE } from '@floorspec/mesh';
import { Adaptation, describeVideo, ffmpegReady, filmChoiceProblem, FilmStopped, finalSamples, renderFilm, type FilmProgress } from '../src/film/index.js';
import { filmParams } from '../src/queue/handlers.js';
import { rasterize, type DrawList, type RasterLamp } from '../src/render3d/raster.js';
import { rasterSky } from '../src/render3d/index.js';
import { resolveSky } from '../src/pathtrace/sky.js';
import type { Camera } from '../src/render3d/camera.js';

/**
 * FLR-T-14.1: films — a document's camera path rendered frame by frame and encoded: a tiny draft
 * drawn by the rasterizer into an MP4 (H.264, its index at the front) and a WebM (VP9), day to night
 * with its clock and its lights; a tiny final, path-traced; the choices a film is refused; exposure
 * easing; and a lamp lighting its own room and not the next.
 *
 * The encoding needs ffmpeg (the worker image's, or FFMPEG_PATH): CI installs it; a laptop without
 * it skips those tests.
 */

const M = UNITS_PER_METRE;
type Json = Record<string, unknown>;
const showcase = (): Json => JSON.parse(readFileSync(new URL('../../../packages/mesh/test/fixtures/showcase.floorspec.json', import.meta.url), 'utf8')) as Json;

/** The showcase house with two saved views and a one-second film between them, and a recorded walk after. */
function withFilm(): Json {
  const doc = showcase();
  (doc['extensionsUsed'] as Json)['FS_views'] = '0.1.0';
  (doc['extensions'] as Json)['FS_views'] = {
    views: {
      SV1: { name: 'Front', eye: [-8 * M, -10 * M, 1.6 * M], target: [4 * M, 4 * M, 2 * M], focalLength: 24, twoPoint: true, at: '2026-06-21T17:00' },
      SV2: { name: 'High', eye: [-8 * M, -10 * M, 6 * M], target: [4 * M, 4 * M, 1 * M], exposure: 5 },
    },
  };
  doc['extras'] = {
    d3floorspec: {
      films: {
        F1: { name: 'Walk-in', keys: [{ at: 0, view: 'SV1' }, { at: 700, view: 'SV2', hold: 300 }] },
        F2: { name: 'Lost', keys: [{ at: 0, view: 'SV1' }, { at: 2000, view: 'SV9' }] },
      },
    },
  };
  return doc;
}

const ready = ffmpegReady();
// In CI the image's ffmpeg must be there: run (and fail) rather than skip.
const encoding = ready || process.env['CI'] !== undefined;

describe.runIf(encoding)('a film, rendered and encoded', () => {
  it('draws a draft and encodes it as an MP4 — H.264, its index at the front — reporting every frame', async () => {
    const seen: FilmProgress[] = [];
    const r = await renderFilm(withFilm(), { film: 'walk-in', quality: 'draft', format: 'mp4', size: '720p', fps: 24, light: 'timeline', pixels: { width: 64, height: 36 }, onFrame: (p) => { seen.push(p); } });
    expect(r.film).toEqual({ id: 'F1', name: 'Walk-in' });
    expect([r.width, r.height, r.fps, r.frames, r.seconds]).toEqual([64, 36, 24, 24, 1]);
    expect(r.contentType).toBe('video/mp4');
    expect(r.video).toMatchObject({ container: 'mp4', codec: 'h264' });
    const boxes = r.video!.boxes!;
    expect(boxes[0]).toBe('ftyp');
    expect(boxes.indexOf('moov')).toBeGreaterThan(-1);
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
    expect(r.video!.seconds).toBeCloseTo(1, 1);
    expect(seen.map((p) => p.frame)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(seen.every((p) => p.frames === 24 && p.clock === undefined)).toBe(true);
    // The last frame's picture, for the job card.
    expect(seen.at(-1)!.preview).toMatch(/^data:image\/png;base64,/);
  });

  it('runs day to night into a WebM — VP9 — the clock moving and the lights coming on', async () => {
    const seen: FilmProgress[] = [];
    const r = await renderFilm(withFilm(), {
      film: 'F1',
      quality: 'draft',
      format: 'webm',
      size: '720p',
      fps: 24,
      light: 'day-to-night',
      timelapse: { date: '2026-06-21', from: '19:00', to: '21:00', lightsAtDusk: true },
      pixels: { width: 64, height: 36 },
      onFrame: (p) => { seen.push(p); },
    });
    expect(r.contentType).toBe('video/webm');
    expect(r.video).toMatchObject({ container: 'webm', codec: 'vp9' });
    expect(r.timelapse).toMatchObject({ date: '2026-06-21', from: '19:00', to: '21:00', lightsAtDusk: true });
    expect(r.timelapse!.sunset).toMatch(/pm$/);
    expect(seen[0]!.clock).toBe('7:00 pm');
    expect(seen.at(-1)!.clock).toMatch(/^8:5\d pm$/);
  });

  it('path-traces a final, frame by frame', async () => {
    const r = await renderFilm(withFilm(), { film: 'F1', quality: 'final', format: 'mp4', size: '1080p', fps: 24, light: 'timeline', pixels: { width: 32, height: 18 }, samples: 1 });
    expect(r.quality).toBe('final');
    expect(r.samples).toBe(1);
    expect(r.frames).toBe(24);
    expect(r.video).toMatchObject({ container: 'mp4', codec: 'h264' });
  }, 120_000);

  it('stops at once when its signal is aborted, between frames as well as at a report (FLR-T-14.10)', async () => {
    const stop = new AbortController();
    let n = 0;
    const film = renderFilm(withFilm(), {
      film: 'F1',
      quality: 'draft',
      format: 'mp4',
      size: '720p',
      fps: 24,
      light: 'timeline',
      pixels: { width: 32, height: 18 },
      signal: stop.signal,
      onFrame: () => {
        if (++n === 2) stop.abort();
      },
    });
    await expect(film).rejects.toBeInstanceOf(FilmStopped);
    expect(n).toBe(2);
    // Already aborted: nothing starts.
    await expect(renderFilm(withFilm(), { film: 'F1', quality: 'draft', format: 'mp4', size: '720p', fps: 24, light: 'timeline', signal: AbortSignal.abort() })).rejects.toBeInstanceOf(FilmStopped);
  });

  it('stops when told to, and keeps nothing', async () => {
    let n = 0;
    await expect(
      renderFilm(withFilm(), { film: 'F1', quality: 'draft', format: 'mp4', size: '720p', fps: 24, light: 'timeline', pixels: { width: 32, height: 18 }, onFrame: () => { if (++n === 3) throw new Error('cancelled'); } }),
    ).rejects.toThrow('cancelled');
    expect(n).toBe(3);
  });
});

describe('what a film may be asked for', () => {
  it('refuses a film the model does not have, one naming views it lacks, and choices over the budget', async () => {
    await expect(renderFilm(withFilm(), { film: 'Garden', quality: 'draft', format: 'mp4', size: '720p', fps: 24, light: 'timeline' })).rejects.toThrow(/no film "Garden"; its films are "Walk-in", "Lost"/);
    await expect(renderFilm(withFilm(), { film: 'Lost', quality: 'draft', format: 'mp4', size: '720p', fps: 24, light: 'timeline' })).rejects.toThrow(/saved views the model does not have: SV9/);
    await expect(renderFilm(withFilm(), { film: 'F1', quality: 'final', format: 'mp4', size: '4k', fps: 24, light: 'timeline' })).rejects.toThrow(/4k is for drafts/);
  });

  it('takes as many samples a final frame as a still’s budget allows', () => {
    expect(finalSamples('720p')).toBe(128);
    expect(finalSamples('1080p')).toBe(64);
    expect(finalSamples('4k')).toBeNull();
    expect(filmChoiceProblem('draft', '4k', 900)).toBeNull();
    expect(filmChoiceProblem('draft', '1080p', 7200)).toMatch(/at most 3600 frames/);
  });

  it('reads a job’s parameters with their defaults, and only a well-formed timelapse', () => {
    expect(filmParams({ film: 'F1' })).toEqual({ film: 'F1', quality: 'draft', format: 'mp4', size: '1080p', fps: 30, light: 'timeline' });
    expect(filmParams({ film: 'F1', quality: 'final', format: 'webm', size: '720p', fps: 60, light: 'day-to-night', timelapse: { date: '2026-06-21', from: '16:30', to: '21:30', lightsAtDusk: false } })).toMatchObject({ quality: 'final', fps: 60, timelapse: { lightsAtDusk: false } });
    expect(filmParams({ film: 'F1', timelapse: { date: 'today', from: '16:30', to: '21:30' } }).timelapse).toBeUndefined();
    expect(filmParams({ film: 'F1', fps: 25, size: '8k' })).toMatchObject({ fps: 30, size: '1080p' });
    expect(() => filmParams({})).toThrow(/names its film/);
  });

  it('eases exposure towards each frame’s, in stops, over half a second', () => {
    const a = new Adaptation(500);
    expect(a.next(1, 0)).toBe(1);
    // Four stops brighter: after one time constant, about two thirds of the way in stops.
    const after = a.next(16, 500);
    expect(Math.log2(after)).toBeCloseTo(4 * (1 - Math.exp(-1)), 6);
    for (let i = 0; i < 40; i++) a.next(16, 100);
    expect(a.next(16, 100)).toBeCloseTo(16, 1);
  });

  const describeOf = (bytes: number[]) => describeVideo(Uint8Array.from(bytes));
  const ascii = (text: string): number[] => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
  it('tells an MP4 from a WebM from neither by their bytes', () => {
    expect(describeOf([0, 0, 0, 16, ...ascii('ftypisom'), 0, 0, 2, 0])).toMatchObject({ container: 'mp4', codec: 'unknown', boxes: ['ftyp'] });
    expect(describeOf([0x1a, 0x45, 0xdf, 0xa3, ...ascii('....webm....V_VP9')])).toEqual({ container: 'webm', codec: 'vp9' });
    expect(describeOf([0x89, 0x50, 0x4e, 0x47])).toBeNull();
  });
});

describe('a lamp in the rasterizer', () => {
  /** Two floors side by side, x 0–4 and 4–8 at y = 0, under a night sky, seen from straight above. */
  function floors(): DrawList {
    const quad = (x0: number, x1: number) => [x0, 0, 0, x1, 0, -4, x0, 0, -4, x0, 0, 0, x1, 0, 0, x1, 0, -4];
    const positions = Float32Array.from([...quad(0, 4), ...quad(4, 8)]);
    const n = 4;
    return {
      positions,
      normals: Float32Array.from(Array.from({ length: n }, () => [0, 1, 0]).flat()),
      colors: new Float32Array(3 * n).fill(0.6),
      alpha: new Float32Array(n).fill(1),
      keys: Int32Array.from([0, 0, 1, 1]),
      twoSided: new Uint8Array(n),
      bias: new Uint8Array(n),
      count: n,
    };
  }
  const camera: Camera = { eye: [4, 12, -2], target: [4, 0, -2.0001], up: [0, 0, -1], fovY: 40, near: 0.05, label: 'above' };
  const lamp: RasterLamp = { position: [2, 2.4, -2], intensity: [60, 60, 60], room: { outer: [[0, 0], [4, 0], [4, 4], [0, 4]], floor: 0, ceiling: 2.5 } };
  const night = rasterSky(resolveSky({}, { sky: 'night' }), -0.01);
  const brightness = (rgb: Uint8Array, x: number, y: number, w: number) => rgb[3 * (y * w + x)]!;

  it('lights its own room’s floor, not the next room’s, and only as far as it is up', () => {
    const w = 64;
    const h = 48;
    const dark = rasterize(floors(), camera, { width: w, height: h, lighting: { ...night, exposure: 0.3 }, supersample: 1, edges: false });
    const lit = rasterize(floors(), camera, { width: w, height: h, lighting: { ...night, exposure: 0.3 }, supersample: 1, edges: false, lamps: [lamp] });
    const half = rasterize(floors(), camera, { width: w, height: h, lighting: { ...night, exposure: 0.3 }, supersample: 1, edges: false, lamps: [lamp], glow: 0.5 });
    // The left room is x 0–4: the left of the picture; the right room the right.
    const left = { x: Math.round(w * 0.3), y: h / 2 };
    const right = { x: Math.round(w * 0.7), y: h / 2 };
    expect(brightness(lit, left.x, left.y, w)).toBeGreaterThan(brightness(dark, left.x, left.y, w) + 20);
    expect(brightness(lit, right.x, right.y, w)).toBe(brightness(dark, right.x, right.y, w));
    const l = brightness(half, left.x, left.y, w);
    expect(l).toBeGreaterThan(brightness(dark, left.x, left.y, w));
    expect(l).toBeLessThan(brightness(lit, left.x, left.y, w));
  });
});
