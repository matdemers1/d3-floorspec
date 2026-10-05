import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildScene } from '../src/export/gltf/index.js';
import { createHandlers, stillParams } from '../src/queue/handlers.js';
import { encodePng } from '../src/render3d/png.js';
import { pngSize } from '../src/render/png.js';
import {
  Bvh,
  decodeTexture,
  imageSize,
  MAX_WORK,
  QUALITIES,
  renderSceneStill,
  renderStill,
  Rng,
  SIZES,
  skyRadiance,
  sunOf,
  trace,
  withinBudget,
  type Hit,
  type PtScene,
  type Sun,
} from '../src/pathtrace/index.js';
import type { Camera } from '../src/render3d/camera.js';

/**
 * FLR-T-12.6, FLR-REQ-154: the path-traced still — a BVH that finds what brute force finds, a lit
 * ground and a lit box against their analytic radiance, the same PNG every time, and its limits.
 */

type Json = Record<string, unknown>;
const template = (name: string): Json => JSON.parse(readFileSync(new URL(`../../../packages/engine/standard/templates/${name}.floorspec.json`, import.meta.url), 'utf8')) as Json;

describe('BVH', () => {
  it('finds the nearest triangle brute force finds, for random rays through random triangles', () => {
    const rng = new Rng(7);
    const n = 500;
    const positions = new Float64Array(9 * n);
    for (let i = 0; i < n; i++) {
      const c = [rng.next() * 20 - 10, rng.next() * 20 - 10, rng.next() * 20 - 10];
      for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) positions[9 * i + 3 * v + k] = c[k]! + rng.next() * 2 - 1;
    }
    const bvh = new Bvh({ positions, count: n });
    const brute = (o: number[], d: number[]): number => {
      let best = Infinity;
      let found = -1;
      for (let i = 0; i < n; i++) {
        const p = 9 * i;
        const e1 = [0, 1, 2].map((k) => positions[p + 3 + k]! - positions[p + k]!);
        const e2 = [0, 1, 2].map((k) => positions[p + 6 + k]! - positions[p + k]!);
        const pv = [d[1]! * e2[2]! - d[2]! * e2[1]!, d[2]! * e2[0]! - d[0]! * e2[2]!, d[0]! * e2[1]! - d[1]! * e2[0]!];
        const det = e1[0]! * pv[0]! + e1[1]! * pv[1]! + e1[2]! * pv[2]!;
        if (Math.abs(det) < 1e-14) continue;
        const s = [0, 1, 2].map((k) => o[k]! - positions[p + k]!);
        const u = (s[0]! * pv[0]! + s[1]! * pv[1]! + s[2]! * pv[2]!) / det;
        if (u < 0 || u > 1) continue;
        const q = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!];
        const v = (d[0]! * q[0]! + d[1]! * q[1]! + d[2]! * q[2]!) / det;
        if (v < 0 || u + v > 1) continue;
        const t = (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det;
        if (t > 1e-6 && t < best) {
          best = t;
          found = i;
        }
      }
      return found;
    };
    const hit: Hit = { tri: -1, t: 0, u: 0, v: 0 };
    for (let k = 0; k < 300; k++) {
      const o = [rng.next() * 40 - 20, rng.next() * 40 - 20, rng.next() * 40 - 20];
      const target = [rng.next() * 10 - 5, rng.next() * 10 - 5, rng.next() * 10 - 5];
      const d = target.map((t, i) => t - o[i]!);
      const l = Math.hypot(...d);
      const dir = d.map((x) => x / l);
      const want = brute(o, dir);
      const got = bvh.intersect(o[0]!, o[1]!, o[2]!, dir[0]!, dir[1]!, dir[2]!, 1e-6, Infinity, hit) ? hit.tri : -1;
      expect(got).toBe(want);
    }
  });
});

/** A camera straight down at a point, from `height` metres. */
const down = (x: number, z: number, height: number, fovY = 20): Camera => ({ eye: [x, height, z], target: [x, 0, z], up: [0, 0, -1], fovY, near: 0.01, label: 'down' });
const quad = (y: number, x0: number, z0: number, x1: number, z1: number): number[] => [x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z1, x1, y, z0, x0, y, z0];
/** A box from (x0, 0, z0) to (x1, h, z1), outward-facing triangles. */
function box(x0: number, z0: number, x1: number, z1: number, h: number): number[] {
  const P = [
    [x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1],
    [x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1],
  ];
  const faces = [[4, 7, 6, 5], [0, 1, 2, 3], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
  const out: number[] = [];
  for (const [a, b, c, d] of faces) out.push(...P[a!]!, ...P[b!]!, ...P[c!]!, ...P[a!]!, ...P[c!]!, ...P[d!]!);
  return out;
}

function scene(positions: number[], materials: { rgb: [number, number, number] }[], materialOf: (tri: number) => number): PtScene {
  const count = positions.length / 9;
  const normals = new Float64Array(3 * count);
  for (let t = 0; t < count; t++) {
    const p = positions.slice(9 * t, 9 * t + 9);
    const u = [p[3]! - p[0]!, p[4]! - p[1]!, p[5]! - p[2]!];
    const v = [p[6]! - p[0]!, p[7]! - p[1]!, p[8]! - p[2]!];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const l = Math.hypot(...n);
    normals.set(n.map((x) => x / l), 3 * t);
  }
  return {
    count,
    positions: Float64Array.from(positions),
    normals,
    material: Int32Array.from({ length: count }, (_, t) => materialOf(t)),
    uvs: new Float32Array(6 * count).fill(NaN),
    materials: materials.map((m) => ({ rgb: m.rgb, glass: false })),
  };
}

/** The sky's irradiance on an upward surface: ∫ L cos θ dω over the upper hemisphere, numerically. */
function skyIrradiance(sun: Sun): number {
  const out = new Float64Array(3);
  let e = 0;
  const N = 400;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < 2 * N; j++) {
      const theta = ((i + 0.5) / N) * (Math.PI / 2);
      const phi = ((j + 0.5) / (2 * N)) * 2 * Math.PI;
      const d = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)] as const;
      skyRadiance(d[0], d[1], d[2], sun, out);
      const lum = 0.2126 * out[0]! + 0.7152 * out[1]! + 0.0722 * out[2]!;
      e += lum * Math.cos(theta) * Math.sin(theta) * (Math.PI / 2 / N) * ((2 * Math.PI) / (2 * N));
    }
  return e;
}

const lum = (img: Float32Array, w: number, x: number, y: number): number => {
  const o = 3 * (y * w + x);
  return 0.2126 * img[o]! + 0.7152 * img[o + 1]! + 0.0722 * img[o + 2]!;
};
/** The mean luminance of a square of pixels. */
const patch = (img: Float32Array, w: number, cx: number, cy: number, r: number): number => {
  let s = 0;
  let k = 0;
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) {
      s += lum(img, w, x, y);
      k++;
    }
  return s / k;
};

describe('a lit scene against its analytic radiance', () => {
  const sun: Sun = { dir: [0, 1, 0], irradiance: 5, radius: 0.01, color: [1, 1, 1] };
  const grey: [number, number, number] = [0.5, 0.5, 0.5];

  it('open ground under the sun and sky: L = ρ/π · (E_sun + E_sky)', async () => {
    const s = scene(quad(0, -1000, -1000, 1000, 1000), [{ rgb: grey }], () => 0);
    const { color } = await trace(s, { width: 16, height: 16, samples: 256, camera: down(0, 0, 10), sun, seed: 1 });
    const want = (0.5 / Math.PI) * (5 + skyIrradiance(sun));
    expect(patch(color, 16, 8, 8, 6)).toBeCloseTo(want, 1);
    expect(Math.abs(patch(color, 16, 8, 8, 6) / want - 1)).toBeLessThan(0.03);
  });

  it('a box: its top lit like open ground, its shadow lit by the sky alone', async () => {
    // A 2 m box on a white ground, the sun low in the +X direction: its shadow falls toward −X.
    const low: Sun = { dir: [Math.SQRT1_2, Math.SQRT1_2, 0], irradiance: 5, radius: 0.01, color: [1, 1, 1] };
    const s = scene([...quad(0, -1000, -1000, 1000, 1000), ...box(-1, -1, 1, 1, 2)], [{ rgb: [0.8, 0.8, 0.8] }, { rgb: grey }], (t) => (t < 2 ? 0 : 1));
    // From 40 m up, 20° of view: about 14 m across, 32 px — a pixel is about 0.44 m.
    const W = 32;
    const { color } = await trace(s, { width: W, height: W, samples: 512, camera: down(0, 0, 40), sun: low, seed: 3 });
    const top = patch(color, W, 16, 16, 1);
    const wantTop = (0.5 / Math.PI) * (5 * Math.SQRT1_2 + skyIrradiance(low));
    expect(Math.abs(top / wantTop - 1)).toBeLessThan(0.05);
    // The ground in the sun, well clear of the box (+X), against the ground in its shadow (−X, about 2.5 m away).
    const lit = patch(color, W, 28, 16, 1);
    const shade = patch(color, W, 10, 16, 0);
    const wantLit = (0.8 / Math.PI) * (5 * Math.SQRT1_2 + skyIrradiance(low));
    expect(Math.abs(lit / wantLit - 1)).toBeLessThan(0.08);
    expect(shade).toBeLessThan(0.5 * lit);
    expect(shade).toBeGreaterThan(0);
  });
});

describe('stills of a house', () => {
  it('the same version and options make the same PNG, byte for byte', async () => {
    const doc = template('cabin');
    const a = await renderStill(doc, { pixels: { width: 64, height: 48 }, samples: 4 });
    const b = await renderStill(structuredClone(doc), { pixels: { width: 64, height: 48 }, samples: 4 });
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
    expect(pngSize(a.png)).toEqual({ width: 64, height: 48 });
    expect(a.camera).toBe('SW iso');
    expect(a.sun.source).toBe('default');
    const c = await renderStill(doc, { pixels: { width: 64, height: 48 }, samples: 4, sun: { azimuth: 135, altitude: 60 } });
    expect(Buffer.from(a.png).equals(Buffer.from(c.png))).toBe(false);
  });

  it('stands in a room, reports every pass, and names an unknown room or level', async () => {
    const scene = await buildScene(template('ranch'));
    const passes: number[] = [];
    const r = await renderSceneStill(scene, { room: 'Living room', pixels: { width: 48, height: 36 }, samples: 3, onPass: (d) => { passes.push(d); } });
    expect(r.camera).toMatch(/^Living room \(LIV\)/);
    expect(passes).toEqual([1, 2, 3]);
    await expect(renderSceneStill(scene, { room: 'Ballroom', pixels: { width: 16, height: 16 }, samples: 1 })).rejects.toThrow(/no room Ballroom/);
    await expect(renderSceneStill(scene, { level: 'L9', pixels: { width: 16, height: 16 }, samples: 1 })).rejects.toThrow(/no level L9/);
  });

  it('is bounded: large at high quality is refused, and a still past its time budget is stopped', async () => {
    expect(withinBudget('medium', 'high')).toBe(true);
    expect(withinBudget('large', 'standard')).toBe(true);
    expect(withinBudget('large', 'high')).toBe(false);
    for (const [s, [w, h]] of Object.entries(SIZES)) for (const [q, n] of Object.entries(QUALITIES)) expect(withinBudget(s as keyof typeof SIZES, q as keyof typeof QUALITIES)).toBe(w * h * n <= MAX_WORK);
    const scene = await buildScene(template('cabin'));
    await expect(renderSceneStill(scene, { size: 'large', quality: 'high' })).rejects.toThrow(/more work than a still may take/);
    await expect(renderSceneStill(scene, { pixels: { width: 32, height: 24 }, samples: 4, budgetMs: -1 })).rejects.toThrow(/stopped after/);
    expect(() => stillParams({ size: 'large', quality: 'high' })).toThrow(/more work/);
    expect(stillParams({ size: 'huge', quality: 'ultra', sun: { azimuth: 90, altitude: -5 } })).toEqual({ size: 'medium', quality: 'standard' });
  });

  it('runs as a job on the queue: export.still, with its progress and an honest label', async () => {
    const handler = createHandlers()['export.still']!;
    const progress: Record<string, unknown>[] = [];
    const file = await handler(template('cabin'), {
      id: 'j',
      projectId: 'p',
      kind: 'export.still',
      params: { size: 'small', quality: 'draft', camera: 'se' },
      versionHash: 'ab'.repeat(32),
      progress: (p) => {
        progress.push(p);
        return Promise.resolve();
      },
    });
    expect(file.contentType).toBe('image/png');
    expect(file.name).toBe('still-se-abababab.png');
    expect(pngSize(file.bytes)).toEqual({ width: 640, height: 480 });
    expect(file.summary).toMatchObject({ label: 'Offline path-traced render — approximate lighting', samples: 16, size: 'small', quality: 'draft', camera: 'SE iso' });
    expect(progress.at(-1)).toEqual({ pass: 16, passes: 16 });
  });
});

describe('threads', () => {
  // The compiled build starts threads; from sources a still is traced in-process. When the build is
  // here, the two must make the same PNG, byte for byte.
  const built = new URL('../dist/pathtrace/index.js', import.meta.url);
  it.skipIf(!existsSync(built))('four threads make the PNG one thread makes', async () => {
    const mod = (await import(built.href)) as typeof import('../src/pathtrace/index.js');
    const doc = template('ranch');
    const before = process.env['STILL_THREADS'];
    try {
      process.env['STILL_THREADS'] = '1';
      const one = await mod.renderStill(doc, { pixels: { width: 96, height: 72 }, samples: 4, room: 'LIV' });
      process.env['STILL_THREADS'] = '4';
      const four = await mod.renderStill(doc, { pixels: { width: 96, height: 72 }, samples: 4, room: 'LIV' });
      expect([one.threads, four.threads]).toEqual([1, 4]);
      expect(Buffer.from(one.png).equals(Buffer.from(four.png))).toBe(true);
    } finally {
      if (before === undefined) delete process.env['STILL_THREADS'];
      else process.env['STILL_THREADS'] = before;
    }
  });
});

describe('the sun and the maps', () => {
  it('turns the sun by the site’s true north', () => {
    const south = sunOf({ azimuth: 180, altitude: 45 }, 0);
    expect(south.dir[2]).toBeGreaterThan(0.7); // project south is +Z in the scene's frame
    // True north 90° counter-clockwise: the true south sun is at plan east (+X).
    const turned = sunOf({ azimuth: 180, altitude: 45 }, 90);
    expect(turned.dir[0]).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it('decodes a PNG map to linear colour, and reads a JPEG’s size from its frame header', () => {
    const png = encodePng(Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128]), 2, 2);
    const t = decodeTexture(png, 'image/png')!;
    expect([t.width, t.height]).toEqual([2, 2]);
    expect(Array.from(t.data.slice(0, 3))).toEqual([1, 0, 0]);
    expect(t.data[9]).toBeCloseTo(0.2158, 3);
    expect(decodeTexture(png, 'image/jpeg')).toBeUndefined();
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 30, 0, 40, 3, 0, 0, 0]);
    expect(imageSize(jpeg, 'image/jpeg')).toEqual({ width: 40, height: 30 });
  });
});
