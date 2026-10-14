/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readView, UNITS_PER_METRE, viewCamera, type SavedView } from '@floorspec/mesh';
import { trace, type PtScene, type Sun } from '../src/pathtrace/index.js';
import { renderSavedView, renderShots } from '../src/pathtrace/views.js';
import { savedCamera, type Camera } from '../src/render3d/camera.js';
import { rasterize, type DrawList } from '../src/render3d/raster.js';
import { readStoreZip } from '../src/export/gltf/zip.js';
import { shotsParams, shotsZip, render3dParams } from '../src/queue/handlers.js';
import { pngSize } from '../src/render/png.js';

/**
 * FLR-T-13.10: the camera of a saved view (FS_views 0.1.0, FLR-ADR-046) in the worker's renderers —
 * two-point perspective's lens shift keeps a vertical pole vertical in the rasterizer and the path
 * tracer alike, a thin lens blurs what is out of focus and keeps what is in focus sharp, exposure
 * compensation brightens — and saved views rendered by name and as a shot list.
 */

const M = UNITS_PER_METRE;
const SUN: Sun = { dir: [0.3, 0.9, 0.3], irradiance: 4, radius: 0.01, color: [1, 1, 1] };

/** A box (scene frame, +Y up) as triangles: `min` to `max`. */
function box(min: [number, number, number], max: [number, number, number]): number[] {
  const [a, b, c] = min;
  const [d, e, f] = max;
  const v = [
    [a, b, c], [d, b, c], [d, e, c], [a, e, c],
    [a, b, f], [d, b, f], [d, e, f], [a, e, f],
  ];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
  return quads.flatMap(([p, q, r, s]) => [...v[p!]!, ...v[q!]!, ...v[r!]!, ...v[p!]!, ...v[r!]!, ...v[s!]!]);
}

/** Black poles on nothing (the sky behind), as the path tracer reads them. */
function poles(...boxes: number[][]): PtScene {
  const pos = Float64Array.from(boxes.flat());
  const count = pos.length / 9;
  const normals = new Float64Array(3 * count);
  for (let t = 0; t < count; t++) {
    const o = 9 * t;
    const u = [pos[o + 3]! - pos[o]!, pos[o + 4]! - pos[o + 1]!, pos[o + 5]! - pos[o + 2]!];
    const w = [pos[o + 6]! - pos[o]!, pos[o + 7]! - pos[o + 1]!, pos[o + 8]! - pos[o + 2]!];
    const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    const l = Math.hypot(...n) || 1;
    normals.set(n.map((x) => x / l), 3 * t);
  }
  return { count, positions: pos, normals, material: new Int32Array(count), uvs: new Float32Array(6 * count).fill(NaN), materials: [{ rgb: [0, 0, 0], glass: false }] };
}

/** The same poles as the rasterizer's draw list, unlit black. */
function drawList(pt: PtScene): DrawList {
  return {
    positions: Float32Array.from(pt.positions),
    normals: Float32Array.from(pt.normals),
    colors: new Float32Array(3 * pt.count),
    alpha: new Float32Array(pt.count).fill(1),
    keys: new Int32Array(pt.count),
    twoSided: new Uint8Array(pt.count).fill(1),
    bias: new Uint8Array(pt.count),
    unlit: new Uint8Array(pt.count).fill(1),
    count: pt.count,
  };
}

/**
 * A view from 3 m east of a pole 10 m north, 10 m tall, the eye 1.6 m up, looking due north at a
 * point 5 m up beside it (a marker there): a camera tilted up sees the pole, off to the left of the
 * picture's middle, lean in; held level with its lens shifted, it stands upright.
 */
const view = (patch: Record<string, unknown> = {}): SavedView => readView('SV1', { name: 'Pole', eye: [3 * M, 0, 1.6 * M], target: [3 * M, 10 * M, 5 * M], focalLength: 24, ...patch })!;
const POLE = box([-0.15, 0, -10.15], [0.15, 10, -9.85]);
const MARKER = box([2.85, 4.85, -10.15], [3.15, 5.15, -9.85]);
const W = 96;
const H = 64;

/** Each row's mean column of dark pixels left of the middle (the pole), or null when the row has none. */
function columns(dark: (x: number, y: number) => boolean, from = 0, to = Math.round(W * 0.4)): (number | null)[] {
  const out: (number | null)[] = [];
  for (let y = 0; y < H; y++) {
    let sum = 0;
    let n = 0;
    for (let x = from; x < to; x++)
      if (dark(x, y)) {
        sum += x;
        n++;
      }
    out.push(n === 0 ? null : sum / n);
  }
  return out;
}

/** How far the pole's middle moves across the picture from its highest row to its lowest. */
function lean(cols: (number | null)[]): number {
  const seen = cols.flatMap((c, y) => (c === null ? [] : [{ c, y }]));
  return Math.abs(seen[0]!.c - seen[seen.length - 1]!.c);
}

async function traced(camera: Camera, scene: PtScene, samples = 1): Promise<Float32Array> {
  return (await trace(scene, { width: W, height: H, samples, camera, sun: SUN, seed: 7 })).color;
}

describe('two-point perspective', () => {
  it('keeps a vertical pole vertical in the rasterizer, and the target in the middle', () => {
    const list = drawList(poles(POLE, MARKER));
    const draw = (v: SavedView) => {
      const rgb = rasterize(list, savedCamera(viewCamera(v)), { width: W, height: H, supersample: 1, edges: false, sky: [[1, 1, 1], [1, 1, 1]] });
      const dark = (x: number, y: number) => rgb[3 * (y * W + x)]! < 64;
      return { pole: columns(dark), marker: columns(dark, Math.round(W * 0.4), W).map((c, y) => (c === null ? null : y)).filter((y) => y !== null) };
    };
    const tilted = draw(view({ twoPoint: false }));
    const upright = draw(view({ twoPoint: true }));
    expect(lean(tilted.pole)).toBeGreaterThan(3);
    expect(lean(upright.pole)).toBeLessThan(0.6);
    // The target — the marker — is in the middle of the picture, either way.
    for (const { marker } of [tilted, upright]) {
      const mid = (marker[0]! + marker[marker.length - 1]!) / 2;
      expect(Math.abs(mid - (H - 1) / 2)).toBeLessThan(1.5);
    }
  });

  it('keeps it vertical in the path tracer too', async () => {
    const scene = poles(POLE, MARKER);
    const dark = (img: Float32Array) => (x: number, y: number) => img[3 * (y * W + x)]! + img[3 * (y * W + x) + 1]! < 0.05;
    const tilted = columns(dark(await traced(savedCamera(viewCamera(view({ twoPoint: false }))), scene)));
    const upright = columns(dark(await traced(savedCamera(viewCamera(view({ twoPoint: true }))), scene)));
    expect(lean(tilted)).toBeGreaterThan(3);
    expect(lean(upright)).toBeLessThan(0.75);
  });
});

describe('depth of field', () => {
  // Through a 135 mm lens: a near pole 4 m away and a far one 20 m away, side by side; focused on the near one at f/1.4.
  const near = box([-0.35, 0, -4.05], [-0.25, 3, -3.95]);
  const far = box([0.8, 0, -20.2], [1.4, 6, -19.8]);
  const scene = poles(near, far);
  const look = (patch: Record<string, unknown>) => savedCamera(viewCamera(readView('SV1', { name: 'DoF', eye: [0, 0, 1.6 * M], target: [0, 4 * M, 1.6 * M], focalLength: 135, ...patch })!));
  /** Pixels between the pole's black and the sky's white, along the middle row: how soft its edges are. */
  const soft = (img: Float32Array, from: number, to: number): number => {
    let n = 0;
    const y = H / 2;
    const sky = img[3 * (y * W + 0)]! + 0.0001;
    for (let x = from; x < to; x++) {
      const v = img[3 * (y * W + x)]! / sky;
      if (v > 0.12 && v < 0.88) n++;
    }
    return n;
  };

  it('blurs what is out of focus and keeps what is in focus sharp', async () => {
    const pinhole = await traced(look({}), scene, 48);
    const lens = await traced(look({ aperture: 'f/1.4', focus: 4 * M }), scene, 48);
    // The near pole is left of the middle, the far one right of it.
    expect(soft(lens, 0, W / 2)).toBeLessThanOrEqual(soft(pinhole, 0, W / 2) + 2);
    expect(soft(lens, W / 2, W)).toBeGreaterThan(soft(pinhole, W / 2, W) + 4);
  });
});

describe('exposure compensation', () => {
  it('brightens the rasterized picture by its factor before the tone curve', () => {
    const list = drawList(poles(box([-50, -1, -60], [50, 30, -59])));
    for (let i = 0; i < list.count; i++) list.colors.set([0.18, 0.18, 0.18], 3 * i);
    const cam = savedCamera(viewCamera(view({ target: [3 * M, 10 * M, 1.6 * M] })));
    const mean = (k: number) => {
      const rgb = rasterize(list, cam, { width: 16, height: 12, supersample: 1, edges: false, exposureScale: k });
      return rgb.reduce((s, v) => s + v, 0) / rgb.length;
    };
    expect(mean(2)).toBeGreaterThan(mean(1) + 10);
    expect(mean(0.5)).toBeLessThan(mean(1) - 10);
  });
});

type Json = Record<string, unknown>;
const showcase = (): Json => JSON.parse(readFileSync(new URL('../../../packages/mesh/test/fixtures/showcase.floorspec.json', import.meta.url), 'utf8')) as Json;

function withViews(): Json {
  const doc = showcase();
  (doc['extensionsUsed'] as Json)['FS_views'] = '0.1.0';
  (doc['extensions'] as Json)['FS_views'] = {
    views: {
      SV1: { name: 'Front', eye: [-8 * M, -10 * M, 1.6 * M], target: [4 * M, 4 * M, 2 * M], focalLength: 24, twoPoint: true, at: '2026-06-21T17:00' },
      SV2: { name: 'Square', eye: [-8 * M, -10 * M, 6 * M], target: [4 * M, 4 * M, 1 * M], aspect: '1:1', exposure: 5, sky: 'overcast' },
    },
  };
  return doc;
}

describe('a saved view, rendered', () => {
  it('renders a view by name, framed by its aspect, and says which', async () => {
    const r = await renderSavedView(withViews(), 'front', { width: 96 });
    expect(r.view.id).toBe('SV1');
    expect([r.width, r.height]).toEqual([96, 64]);
    expect(pngSize(r.png)).toEqual({ width: 96, height: 64 });
    expect(r.camera).toBe('Front');
    expect(r.lit?.lights).toBe('off');
    expect(r.sky?.preset).toBe('clear');
  });

  it('refuses a view the model does not have, naming those it has', async () => {
    await expect(renderSavedView(withViews(), 'Garden', { width: 96 })).rejects.toThrow(/no saved view "Garden"; its views are "Front", "Square"/);
    await expect(renderSavedView(showcase(), 'Front', { width: 96 })).rejects.toThrow(/it has none/);
    await expect(renderSavedView(withViews(), 'Front', { width: 4000 })).rejects.toThrow(/long side/);
  });

  it('renders every saved view as a shot list, each at its own frame', async () => {
    const seen: number[] = [];
    const shots = await renderShots(withViews(), { long: 64, samples: 2, onShot: (shot) => { seen.push(shot); } });
    expect(shots.map((s) => s.view.id)).toEqual(['SV1', 'SV2']);
    expect(shots.map((s) => [s.still.width, s.still.height])).toEqual([[64, 43], [64, 64]]);
    expect([...new Set(seen)]).toEqual([0, 1]);
    const only = await renderShots(withViews(), { views: ['SV2'], long: 32, samples: 1 });
    expect(only.map((s) => s.view.id)).toEqual(['SV2']);
    await expect(renderShots(showcase(), { long: 32, samples: 1 })).rejects.toThrow(/no saved views/);
    await expect(renderShots(withViews(), { size: 'large', quality: 'high' })).rejects.toThrow(/more work/);
  });

  it('packs a shot list into a ZIP of PNGs named for their views', async () => {
    const shots = await renderShots(withViews(), { long: 32, samples: 1 });
    const zip = shotsZip(shots);
    expect(readStoreZip(zip.bytes).map((e) => e.name)).toEqual(['01-front.png', '02-square.png']);
    expect(zip.shots.map((s) => [s['view'], s['file'], s['width'], s['height']])).toEqual([
      ['SV1', '01-front.png', 32, 21],
      ['SV2', '02-square.png', 32, 32],
    ]);
  });

  it('reads a shot list’s and a saved view’s job parameters', () => {
    expect(shotsParams({ views: ['SV2'], size: 'small', quality: 'draft' })).toEqual({ views: ['SV2'], size: 'small', quality: 'draft' });
    expect(shotsParams({})).toEqual({ size: 'medium', quality: 'standard' });
    expect(() => shotsParams({ size: 'large', quality: 'high' })).toThrow(/more work/);
    expect(render3dParams({ view: 'SV1', width: 640 })).toEqual({ view: 'SV1', width: 640 });
  });
});
