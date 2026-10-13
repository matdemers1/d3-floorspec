/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildScene, type Scene } from '../src/export/gltf/index.js';
import { renderSceneStill, resolveSky } from '../src/pathtrace/index.js';
import type { Preset } from '../src/render3d/camera.js';
import type { SkyPreset } from '@floorspec/mesh/sky';

/**
 * FLR-T-13.14, FLR-ADR-040: a CPU still and a GPU still of the same Courtyard House view agree on
 * the mean luminance of each region of the picture, in cd/m² — before either is exposed, so what is
 * compared is the light each traced, not the meter or the tone curve.
 *
 * The GPU stills are stored (fixtures/gpu-still, index.json says how they were made): WebGPU cannot
 * run on CI's runners. Each was traced on an M4 Pro by the editor's own still modules from the
 * worker's glTF export of the same version, and read back before the meter.
 *
 * The views are the ones where the GPU still is the whole picture: rooms under an overcast sky, and
 * the house outside in the sun. In a room by a clear day's sun, or by its lamps, the GPU still is
 * not yet a reference — it lets no sun through glass (three-gpu-pathtracer 0.0.26 shadow rays stop
 * at a transmissive surface), its lit lenses light the room on top of their lamps, and it sees
 * through a single-sided face from behind — so a CPU still there is held to its own calibration
 * (FLR-T-13.1's light-levels tests), not to the GPU's.
 */

interface View {
  readonly name: string;
  readonly file: string;
  readonly room?: string;
  readonly camera?: Preset;
  readonly sky: SkyPreset;
  readonly at: string;
  /** Where the regions are taken, as fractions of the picture: x0, y0, x1, y1. Default the whole of it. */
  readonly crop?: readonly [number, number, number, number];
}

const fixture = (name: string): URL => new URL(`./fixtures/${name}`, import.meta.url);
const REFERENCE = JSON.parse(readFileSync(fixture('gpu-still/index.json'), 'utf8')) as { width: number; height: number; document: string; views: View[] };
const DOCUMENT = JSON.parse(readFileSync(fixture(REFERENCE.document), 'utf8')) as object;

/** The regions a picture is compared in: a 4 × 3 grid. */
const GX = 4;
const GY = 3;
/**
 * The bands: each region's mean luminance within 0.6 of a stop of the GPU still's, and the regions'
 * mean difference within 0.3. Measured: within 0.51 (a kitchen's terrazzo floor seen at a slant) and
 * 0.22 indoors, 0.07 and 0.02 outside; before FLR-T-13.14 the steel, the mirrors and the windows
 * were as far off as a stop and a half.
 */
const REGION_STOPS = 0.6;
const MEAN_STOPS = 0.3;
/** The CPU still a region is measured on: small and few samples, smoothed by the denoiser — a mean over a region is steady long before a pixel is. */
const WIDTH = 128;
const HEIGHT = 96;
const SAMPLES = 64;

/** The mean luminance (cd/m²) of each region of a linear RGB picture. */
function regions(rgb: Float32Array, width: number, height: number, crop: readonly [number, number, number, number] = [0, 0, 1, 1]): number[] {
  const sum = new Float64Array(GX * GY);
  const count = new Float64Array(GX * GY);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = ((x + 0.5) / width - crop[0]) / (crop[2] - crop[0]);
      const v = ((y + 0.5) / height - crop[1]) / (crop[3] - crop[1]);
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const r = Math.floor(v * GY) * GX + Math.floor(u * GX);
      const o = 3 * (y * width + x);
      sum[r] = sum[r]! + 0.2126 * rgb[o]! + 0.7152 * rgb[o + 1]! + 0.0722 * rgb[o + 2]!;
      count[r] = count[r]! + 1;
    }
  return Array.from(sum, (s, i) => s / count[i]!);
}

describe('a CPU still agrees with the GPU still of the same view (FLR-ADR-040)', () => {
  let scene: Scene;
  beforeAll(async () => {
    scene = await buildScene(DOCUMENT);
  }, 120_000);

  for (const view of REFERENCE.views)
    it(`the Courtyard House, ${view.name}: every region within ${String(REGION_STOPS)} of a stop, on average within ${String(MEAN_STOPS)}`, async () => {
      const bytes = readFileSync(fixture(`gpu-still/${view.file}`));
      const gpu = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      expect(gpu.length).toBe(3 * REFERENCE.width * REFERENCE.height);
      const cpu = await renderSceneStill(scene, {
        ...(view.room === undefined ? {} : { room: view.room }),
        ...(view.camera === undefined ? {} : { camera: view.camera }),
        skyLight: resolveSky(DOCUMENT, { sky: view.sky, at: view.at }),
        lights: 'off',
        pixels: { width: WIDTH, height: HEIGHT },
        samples: SAMPLES,
        radiance: true,
      });
      const want = regions(gpu, REFERENCE.width, REFERENCE.height, view.crop);
      const got = regions(cpu.radiance!, WIDTH, HEIGHT, view.crop);
      const stops = got.map((g, i) => Math.log2(g / want[i]!));
      const report = stops.map((s, i) => `${String(i % GX)},${String(Math.floor(i / GX))}: ${want[i]!.toFixed(0)} → ${got[i]!.toFixed(0)} cd/m² (${s.toFixed(2)})`).join('; ');
      if (process.env["PARITY_LOG"]) console.log(view.name, report);
      for (const s of stops) expect(Math.abs(s), report).toBeLessThanOrEqual(REGION_STOPS);
      expect(Math.abs(stops.reduce((a, b) => a + b, 0) / stops.length), report).toBeLessThanOrEqual(MEAN_STOPS);
    }, 180_000);
});
