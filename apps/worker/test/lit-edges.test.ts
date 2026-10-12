/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { describe, expect, it } from 'vitest';
import type { Scene, SceneLight } from '../src/export/gltf/scene.js';
import { Bvh, denoise, EXPOSURE, lampsOf, Rng, toneMap, trace, type Features, type Hit, type PtMaterial, type PtScene, type Sun } from '../src/pathtrace/index.js';
import type { Camera } from '../src/render3d/camera.js';

/**
 * FLR-T-13.16: lit renders without white speckles along every casing, sill and wall-to-ceiling line,
 * and a ceiling light that can be seen in the glow it casts.
 *
 * - The speckles were the denoiser leaving a pixel that straddles two faces with its own few samples:
 *   its normal is the two faces' average, shorter than one, and matched neither face's neighbours.
 * - The fixture vanished because the firefly clamp capped what the camera saw directly — its lit lens
 *   and the ceiling beside it alike — and because its lamp hung 12 cm under the fitting shining every
 *   way, lighting the ceiling round it to some 3000 lux.
 */

type Rgb = [number, number, number];
const NO_SUN: Sun = { dir: [0, 1, 0], irradiance: 0, radius: 0.01, color: [1, 1, 1] };
const BLACK_SKY: Rgb = [0, 0, 0];

describe('the denoiser on an edge', () => {
  // Two faces meeting in a slanting line: the left facing +Z, lit to 0.5; the right facing +X, lit to
  // 0.3; and in the column between them each pixel seeing some of each — its normal their average by
  // how much, and its light too. Every pixel is noisy, as 16 samples of a lamp-lit room are.
  const W = 33;
  const H = 48;
  const EDGE = 16;
  const SIGMA = 0.12;
  let cover = new Float64Array(H);
  const truth = (x: number, y: number): number => {
    const f = x < EDGE ? 1 : x > EDGE ? 0 : cover[y]!;
    return 0.5 * f + 0.3 * (1 - f);
  };
  function noisy(seed: number): { color: Float32Array; features: Features } {
    const rng = new Rng(seed);
    cover = Float64Array.from({ length: H }, () => 0.15 + 0.7 * rng.next());
    const color = new Float32Array(3 * W * H);
    const albedo = new Float32Array(3 * W * H).fill(1);
    const normal = new Float32Array(3 * W * H);
    const depth = new Float32Array(W * H).fill(3);
    const variance = new Float32Array(W * H).fill(SIGMA * SIGMA);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        // A sum of uniforms: near-normal noise of deviation SIGMA.
        let n = 0;
        for (let k = 0; k < 12; k++) n += rng.next();
        const v = truth(x, y) + (n - 6) * SIGMA;
        color.fill(v, 3 * p, 3 * p + 3);
        const f = x < EDGE ? 1 : x > EDGE ? 0 : cover[y]!;
        normal.set([1 - f, 0, f], 3 * p);
      }
    return { color, features: { albedo, normal, depth, variance } };
  }
  const errors = (img: Float32Array, column: number): number[] => Array.from({ length: H }, (_, y) => Math.abs(img[3 * (y * W + column)]! - truth(column, y)));
  const rms = (e: number[]): number => Math.sqrt(e.reduce((s, v) => s + v * v, 0) / e.length);

  it('smooths a pixel that straddles two faces from both, instead of leaving it to sparkle', () => {
    for (const seed of [1, 2, 3]) {
      const { color, features } = noisy(seed);
      const out = denoise(color, features, W, H);
      const raw = errors(color, EDGE);
      const edge = errors(out, EDGE);
      // The edge column was left exactly as noisy as it was traced; now it is smoothed, and no pixel
      // of it stands out from the line.
      expect(rms(edge)).toBeLessThan(0.5 * rms(raw));
      expect(Math.max(...edge)).toBeLessThan(0.5 * Math.max(...raw));
      // And neither face is pulled toward the other, or toward the edge.
      for (const x of [EDGE - 2, EDGE + 2]) expect(rms(errors(out, x))).toBeLessThan(0.03);
    }
  });
});

/** Two triangles over a rectangle, from a corner along two edges: facing along a × b. */
const rect = (o: Rgb, a: Rgb, b: Rgb): number[] => {
  const p = (s: number, t: number): number[] => [o[0] + a[0] * s + b[0] * t, o[1] + a[1] * s + b[1] * t, o[2] + a[2] * s + b[2] * t];
  return [...p(0, 0), ...p(1, 0), ...p(1, 1), ...p(0, 0), ...p(1, 1), ...p(0, 1)];
};

function ptScene(positions: number[], materials: PtMaterial[], materialOf: (tri: number) => number, extra: Partial<PtScene> = {}): PtScene {
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
  return { count, positions: Float64Array.from(positions), normals, material: Int32Array.from({ length: count }, (_, t) => materialOf(t)), uvs: new Float32Array(6 * count).fill(NaN), materials, ...extra };
}

/** A luminaire's light as the scene has it (@floorspec/mesh lightsOf, in metres, +Y up). */
const light = (position: Rgb, lumens: number, spot?: { inner: number; outer: number }): SceneLight => ({
  id: 'X1',
  level: 'L1',
  fixture: 'ceiling',
  position,
  radius: 0.019,
  lumens,
  color: [1, 1, 1],
  room: null,
  ...(spot === undefined ? {} : { spot: { dir: [0, -1, 0] as Rgb, ...spot } }),
});

describe('a ceiling light in the glow it casts', () => {
  // A 4 m room 2.7 m high: floor, ceiling and four walls; and under the ceiling at its middle a flush
  // fitting's dome, a lit lens 20 cm across, 3–7 cm under the ceiling.
  const H = 2.7;
  const walls = [
    rect([0, 0, 4], [4, 0, 0], [0, 0, -4]),
    rect([0, H, 0], [4, 0, 0], [0, 0, 4]),
    rect([0, 0, 0], [4, 0, 0], [0, H, 0]),
    rect([0, 0, 4], [0, 0, -4], [0, H, 0]),
    rect([4, 0, 0], [0, 0, 4], [0, H, 0]),
    rect([4, 0, 4], [-4, 0, 0], [0, H, 0]),
  ].flat();
  const lens = rect([1.9, H - 0.07, 2.1], [0.2, 0, 0], [0, 0, -0.2]);
  const materials: PtMaterial[] = [
    { rgb: [0.8, 0.8, 0.8], glass: false },
    { rgb: [0.9, 0.9, 0.9], glass: false, lens: true, emission: [2.5, 2.5, 2.5] },
  ];
  const count = (walls.length + lens.length) / 9;
  const material = (t: number) => (t < walls.length / 9 ? 0 : 1);
  const owner = Int32Array.from({ length: count }, (_, t) => (material(t) === 1 ? 0 : -1));
  // Looking up at the ceiling around the fitting from the middle of the room, a 70 cm patch.
  const up: Camera = { eye: [2, 1.2, 2], target: [2, H, 2], up: [0, 0, -1], fovY: 26, near: 0.05, label: 'up' };
  const W = 40;
  /** The picture's 8-bit luminance, row-major, exposed as a dim bedroom at night is (the band's most). */
  async function look(lamp: SceneLight): Promise<number[]> {
    const s = ptScene([...walls, ...lens], materials, material, { lamps: lampsOf({ lights: [lamp] } as unknown as Scene), owner });
    const night = EXPOSURE.night;
    const { color } = await trace(s, { width: W, height: W, samples: 64, camera: up, sun: NO_SUN, sky: BLACK_SKY, seed: 3, bounces: 3, clamp: 12 * (EXPOSURE.day.min / night.min) });
    const px = toneMap(color, W, W, night.max);
    return Array.from({ length: W * W }, (_, i) => 0.2126 * px[3 * i]! + 0.7152 * px[3 * i + 1]! + 0.0722 * px[3 * i + 2]!);
  }
  // The lens fills the middle of the picture (20 cm at 1.43 m, of a 66 cm view: the middle 12 pixels);
  // the ceiling around it is the ring between 9 and 15 pixels out.
  const ring = (img: number[], from: number, to: number): number[] =>
    img.filter((_, i) => {
      const r = Math.hypot((i % W) - W / 2 + 0.5, Math.floor(i / W) - W / 2 + 0.5);
      return r >= from && r < to;
    });
  const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;

  it('lit inside its dome and shining down and out, its lens is white and the ceiling round it bright but not blown', async () => {
    // As @floorspec/mesh puts a ceiling light (FLR-T-13.16): in its dome under the canopy, its cone 70°–110°.
    const img = await look(light([2, H - 0.034, 2], 1500, { inner: 0.342, outer: -0.342 }));
    const lensPx = ring(img, 0, 4);
    const ceiling = ring(img, 9, 15);
    // The lens is white; the ceiling round it bright — a glow — but short of white, and falling off
    // away from the fitting, so the fitting's edge can be seen against it.
    expect(Math.min(...lensPx)).toBeGreaterThanOrEqual(254);
    expect(mean(ceiling)).toBeGreaterThan(200);
    expect(ceiling.filter((v) => v >= 253).length / ceiling.length).toBeLessThan(0.02);
    expect(mean(ring(img, 9, 11)) - mean(ring(img, 17, 19))).toBeGreaterThan(6);
  });

  it('where a bare lamp hung 12 cm under it shining every way blew the ceiling round it out with the lens', async () => {
    const img = await look(light([2, H - 0.185, 2], 1500));
    const ceiling = ring(img, 9, 15);
    expect(ceiling.filter((v) => v >= 253).length / ceiling.length).toBeGreaterThan(0.9);
  });

  it('is not clamped where the camera sees it directly: a lit lens shows its own brightness, whatever the firefly cap', async () => {
    const s = ptScene([...walls, ...lens], materials, material, { owner });
    const straight: Camera = { eye: [2, 1.2, 2], target: [2, H, 2], up: [0, 0, -1], fovY: 2, near: 0.05, label: 'lens' };
    const { color } = await trace(s, { width: 4, height: 4, samples: 4, camera: straight, sun: NO_SUN, sky: BLACK_SKY, seed: 1, bounces: 2, clamp: 0.01 });
    for (let i = 0; i < 16; i++) expect(color[3 * i]!).toBeCloseTo(2.5, 6);
  });
});

describe('a shadow ray stops at the first thing in its way', () => {
  it('agrees with the nearest-hit walk on whether anything lies between a point and a lamp', () => {
    const rng = new Rng(11);
    const n = 400;
    const positions = new Float64Array(9 * n);
    for (let i = 0; i < n; i++) {
      const c = [rng.next() * 20 - 10, rng.next() * 20 - 10, rng.next() * 20 - 10];
      for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) positions[9 * i + 3 * v + k] = c[k]! + rng.next() * 3 - 1.5;
    }
    const bvh = new Bvh({ positions, count: n });
    const hit: Hit = { tri: -1, t: 0, u: 0, v: 0 };
    let blocked = 0;
    for (let r = 0; r < 2000; r++) {
      const o = [rng.next() * 24 - 12, rng.next() * 24 - 12, rng.next() * 24 - 12];
      const d = [rng.next() * 2 - 1, rng.next() * 2 - 1, rng.next() * 2 - 1];
      const l = Math.hypot(d[0]!, d[1]!, d[2]!);
      const tMax = rng.next() * 15;
      const nearest = bvh.intersect(o[0]!, o[1]!, o[2]!, d[0]! / l, d[1]! / l, d[2]! / l, 1e-4, tMax, hit);
      const seen: number[] = [];
      const any = bvh.occluded(o[0]!, o[1]!, o[2]!, d[0]! / l, d[1]! / l, d[2]! / l, 1e-4, tMax, (tri) => {
        seen.push(tri);
        return true;
      });
      expect(any).toBe(nearest);
      if (any) blocked++;
      // Told that nothing blocks, it visits every triangle the segment crosses — the nearest among them.
      const all: number[] = [];
      bvh.occluded(o[0]!, o[1]!, o[2]!, d[0]! / l, d[1]! / l, d[2]! / l, 1e-4, tMax, (tri) => {
        all.push(tri);
        return false;
      });
      if (nearest) expect(all).toContain(hit.tri);
      else expect(all).toEqual([]);
    }
    expect(blocked).toBeGreaterThan(100);
  });
});
