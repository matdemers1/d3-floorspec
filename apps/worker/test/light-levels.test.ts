/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPOSURE_PER_NIT } from '@floorspec/mesh';
import type { Scene, SceneLight } from '../src/export/gltf/scene.js';
import { decodeTexture, EXPOSURE, exposureOf, lampsOf, LUX_PER_UNIT, renderLit, toneMap, trace, type PtScene, type Sun } from '../src/pathtrace/index.js';
import type { Camera } from '../src/render3d/camera.js';

/**
 * FLR-T-13.1: light levels that match the fixtures. A lamp's lumens light a surface to I cos θ / d²
 * lux, d in metres; a luminaire never shadows its own lamp; and the exposure is calibrated so a room
 * lit by its one ceiling light at night, a room lit to 150–300 lux, and a daylit room each read as a
 * normally lit room — and a room with its lamps off at night stays dark.
 */

type Rgb = [number, number, number];
const NO_SUN: Sun = { dir: [0, 1, 0], irradiance: 0, radius: 0.01, color: [1, 1, 1] };
const BLACK_SKY: Rgb = [0, 0, 0];
const NIGHT_SKY: Rgb = [0.00008, 0.0001, 0.00018];

/** Two triangles over a rectangle, from a corner along two edges: facing along a × b. */
const rect = (o: Rgb, a: Rgb, b: Rgb): number[] => {
  const p = (s: number, t: number): number[] => [o[0] + a[0] * s + b[0] * t, o[1] + a[1] * s + b[1] * t, o[2] + a[2] * s + b[2] * t];
  return [...p(0, 0), ...p(1, 0), ...p(1, 1), ...p(0, 0), ...p(1, 1), ...p(0, 1)];
};

function ptScene(positions: number[], materials: Rgb[], materialOf: (tri: number) => number, extra: Partial<PtScene> = {}): PtScene {
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
    materials: materials.map((rgb) => ({ rgb, glass: false })),
    ...extra,
  };
}

/** A luminaire's light as the scene has it (@floorspec/mesh lightsOf, in metres, +Y up). */
const light = (id: string, position: Rgb, lumens: number, spot?: { inner: number; outer: number }): SceneLight => ({
  id,
  level: 'L1',
  fixture: spot === undefined ? 'ceiling' : 'recessed',
  position,
  radius: 0.02,
  lumens,
  color: [1, 1, 1],
  room: null,
  ...(spot === undefined ? {} : { spot: { dir: [0, -1, 0] as Rgb, ...spot } }),
});
const lamps = (...lights: SceneLight[]) => lampsOf({ lights } as unknown as Scene);

/** A camera straight down at a point, from `height` metres, with a narrow view. */
const down = (x: number, z: number, height: number): Camera => ({ eye: [x, height, z], target: [x, 0, z], up: [0, 0, -1], fovY: 4, near: 0.01, label: 'down' });

const meanLuminance = (img: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < img.length; i += 3) s += 0.2126 * img[i]! + 0.7152 * img[i + 1]! + 0.0722 * img[i + 2]!;
  return s / (img.length / 3);
};
/** The mean of an 8-bit sRGB picture's pixels, and the share of them blown to white. */
function tones(srgb: Uint8Array): { mean: number; blown: number } {
  let s = 0;
  let blown = 0;
  const n = srgb.length / 3;
  for (let i = 0; i < n; i++) {
    const v = 0.2126 * srgb[3 * i]! + 0.7152 * srgb[3 * i + 1]! + 0.0722 * srgb[3 * i + 2]!;
    s += v;
    if (v >= 250) blown++;
  }
  return { mean: s / n, blown: blown / n };
}

describe('lumens to lux', () => {
  const grey: Rgb = [0.5, 0.5, 0.5];
  const floor = rect([-50, 0, 50], [100, 0, 0], [0, 0, -100]);

  it('a lamp lights the floor under it to I / d² lux, d in metres: inverse-square, nothing else', async () => {
    for (const h of [1.5, 3]) {
      const s = ptScene(floor, [grey], () => 0, { lamps: lamps(light('X1', [0, h, 0], 1200)) });
      const { color } = await trace(s, { width: 8, height: 8, samples: 64, camera: down(0, 0, 0.5), sun: NO_SUN, sky: BLACK_SKY, seed: 1, bounces: 0 });
      // E = (1200 lm / 4π sr) / h², and the floor shows ρE/π.
      const lux = 1200 / (4 * Math.PI) / (h * h);
      const want = ((0.5 / Math.PI) * lux) / LUX_PER_UNIT;
      expect(Math.abs(meanLuminance(color) / want - 1)).toBeLessThan(0.03);
    }
  });

  it('a spot puts its lumens in its cone: brighter under it than the same lamp shining every way', async () => {
    const cone = { inner: 0.8192, outer: 0.5736 };
    const s = ptScene(floor, [grey], () => 0, { lamps: lamps(light('X1', [0, 2.5, 0], 800, cone)) });
    const { color } = await trace(s, { width: 8, height: 8, samples: 64, camera: down(0, 0, 0.5), sun: NO_SUN, sky: BLACK_SKY, seed: 1, bounces: 0 });
    // Candela = lumens over the cone's solid angle, out to the middle of its edge.
    const sr = 2 * Math.PI * (1 - (cone.inner + cone.outer) / 2);
    const want = ((0.5 / Math.PI) * (800 / sr / 6.25)) / LUX_PER_UNIT;
    expect(Math.abs(meanLuminance(color) / want - 1)).toBeLessThan(0.03);
  });
});

describe('a fixture never shadows itself', () => {
  const grey: Rgb = [0.5, 0.5, 0.5];
  // The floor, and a dark shade 5 cm under the lamp, between it and the floor: the luminaire's own piece.
  const floor = rect([-50, 0, 50], [100, 0, 0], [0, 0, -100]);
  const shade = rect([-0.2, 2.45, 0.2], [0.4, 0, 0], [0, 0, -0.4]);
  const positions = [...floor, ...shade];
  const material = (t: number) => (t < 2 ? 0 : 1);
  const lit = lamps(light('X1', [0, 2.5, 0], 1500));
  const under = async (s: PtScene) => meanLuminance((await trace(s, { width: 8, height: 8, samples: 32, camera: down(0, 0, 0.5), sun: NO_SUN, sky: BLACK_SKY, seed: 2, bounces: 0 })).color);

  it('passes every piece of its own luminaire: the floor under it is lit as if the piece were not there', async () => {
    const bare = await under(ptScene(floor, [grey], () => 0, { lamps: lit }));
    const own = await under(ptScene(positions, [grey, [0.05, 0.05, 0.05]], material, { lamps: lit, owner: Int32Array.from([-1, -1, 0, 0]) }));
    expect(bare).toBeGreaterThan(0);
    expect(own).toBe(bare);
  });

  it('is still shadowed by what is not its own: the same piece of another luminaire, or of the house, blocks it', async () => {
    const other = await under(ptScene(positions, [grey, [0.05, 0.05, 0.05]], material, { lamps: lit, owner: Int32Array.from([-1, -1, 1, 1]) }));
    const house = await under(ptScene(positions, [grey, [0.05, 0.05, 0.05]], material, { lamps: lit }));
    expect(other).toBe(0);
    expect(house).toBe(0);
  });
});

/**
 * A closed room 4 m × 4 m and 2.7 m high, its walls 0.7, ceiling 0.8 and floor 0.35 — with, when
 * `window` is set, a window 2 m wide and 1.4 m high in its south wall (+Z), the sun low through it.
 */
function room(lampsIn: ReturnType<typeof lamps>, window = false): PtScene {
  const H = 2.7;
  const parts: number[][] = [
    rect([0, 0, 4], [4, 0, 0], [0, 0, -4]), // floor, facing up
    rect([0, H, 0], [4, 0, 0], [0, 0, 4]), // ceiling, facing down
    rect([0, 0, 0], [4, 0, 0], [0, H, 0]), // north wall, facing +Z
    rect([0, 0, 4], [0, 0, -4], [0, H, 0]), // west wall, facing +X
    rect([4, 0, 0], [0, 0, 4], [0, H, 0]), // east wall, facing −X
  ];
  // The south wall, facing −Z, around its window (x 1–3, y 0.8–2.2) or whole.
  const south = window
    ? [rect([1, 0, 4], [-1, 0, 0], [0, H, 0]), rect([4, 0, 4], [-1, 0, 0], [0, H, 0]), rect([3, 0, 4], [-2, 0, 0], [0, 0.8, 0]), rect([3, 2.2, 4], [-2, 0, 0], [0, H - 2.2, 0])]
    : [rect([4, 0, 4], [-4, 0, 0], [0, H, 0])];
  const tris = [...parts, ...south];
  const albedo: Rgb[] = [[0.35, 0.35, 0.35], [0.8, 0.8, 0.8], [0.7, 0.7, 0.7]];
  const of: number[] = [];
  tris.forEach((r, i) => { for (let k = 0; k < r.length / 9; k++) of.push(i === 0 ? 0 : i === 1 ? 1 : 2); });
  return ptScene(tris.flat(), albedo, (t) => of[t]!, lampsIn.length === 0 ? {} : { lamps: lampsIn });
}
/** Standing in the room's north-west corner at eye height, looking across it to the south-east. */
const inRoom: Camera = { eye: [0.4, 1.6, 0.4], target: [3.2, 0.9, 3.2], up: [0, 1, 0], fovY: 60, near: 0.05, label: 'room' };

async function picture(s: PtScene, time: 'day' | 'night', sun: Sun = NO_SUN): Promise<{ hdr: Float32Array; tones: { mean: number; blown: number } }> {
  const W = 48;
  const H = 36;
  const { color } = await trace(s, { width: W, height: H, samples: 48, camera: inRoom, sun, sky: time === 'day' ? [1, 1, 1] : NIGHT_SKY, seed: 5, bounces: 6, clamp: 12 * (EXPOSURE.day.min / EXPOSURE[time].min) });
  return { hdr: color, tones: tones(toneMap(color, W, H, EXPOSURE[time])) };
}

describe('a lit test room reads as a lit room', () => {
  const ceiling = (lumens: number) => lamps(light('X1', [2, 2.55, 2], lumens));

  it('at night by its one 1500 lm ceiling light: a normally lit bedroom, not a dark one', async () => {
    const { tones: t } = await picture(room(ceiling(1500)), 'night');
    expect(t.mean).toBeGreaterThan(100);
    expect(t.mean).toBeLessThan(200);
    expect(t.blown).toBeLessThan(0.05);
  });

  it('lit to 150–300 lux, it reads lit at the least exposure — bright, not blown', async () => {
    // Four 2000 lm lamps: about 200 lux over the room.
    const four = lamps(...[[1, 1], [3, 1], [1, 3], [3, 3]].map(([x, z], i) => light(`X${String(i)}`, [x!, 2.55, z!], 2000)));
    const s = room(four);
    const { hdr, tones: t } = await picture(s, 'night');
    // At the band's least exposure: metering does not have to open it up.
    expect(exposureOf(hdr, 48, 36, EXPOSURE.night)).toBeLessThan(2 * EXPOSURE.night.min);
    expect(t.mean).toBeGreaterThan(120);
    expect(t.mean).toBeLessThan(215);
    expect(t.blown).toBeLessThan(0.05);
    // The floor in the middle of the room, by the lux probe: 150–300 lux.
    const { color } = await trace(s, { width: 4, height: 4, samples: 128, camera: { ...down(2, 2, 1.2), fovY: 10 }, sun: NO_SUN, sky: BLACK_SKY, seed: 9, bounces: 6 });
    const lux = (meanLuminance(color) * Math.PI) / 0.35 * LUX_PER_UNIT;
    expect(lux).toBeGreaterThan(150);
    expect(lux).toBeLessThan(300);
  });

  it('with its lamps off at night, it stays dark', async () => {
    const { tones: t } = await picture(room([]), 'night');
    expect(t.mean).toBeLessThan(15);
  });

  it('by day through its window, bright and natural — not the dark interior a sunlit-house exposure gives', async () => {
    const sun: Sun = { dir: [0, 0.5, 0.866], irradiance: 8, radius: 0.01, color: [1, 0.96, 0.9] };
    const { hdr, tones: t } = await picture(room([], true), 'day', sun);
    expect(t.mean).toBeGreaterThan(95);
    expect(t.mean).toBeLessThan(200);
    // At a sunlit house's exposure, the same room is dull and dark.
    expect(tones(toneMap(hdr, 48, 36, EXPOSURE.day.min)).mean).toBeLessThan(60);
  });

  it('is exposed in the tracer\'s units as @floorspec/mesh calibrates it, per cd/m²', () => {
    expect(EXPOSURE.night.min).toBeCloseTo(EXPOSURE_PER_NIT.night * LUX_PER_UNIT, 9);
    expect(EXPOSURE.night.max).toBeCloseTo(EXPOSURE_PER_NIT.nightMax * LUX_PER_UNIT, 9);
    expect(EXPOSURE.day.min).toBeCloseTo(EXPOSURE_PER_NIT.day * LUX_PER_UNIT, 9);
    expect(EXPOSURE.day.max).toBeCloseTo(EXPOSURE_PER_NIT.dayMax * LUX_PER_UNIT, 9);
  });
});

describe('a house\'s room by lamplight, end to end', () => {
  const showcase = (): object => JSON.parse(readFileSync(new URL('../../../packages/mesh/test/fixtures/showcase.floorspec.json', import.meta.url), 'utf8')) as object;
  const meanOf = (png: Uint8Array): number => {
    const t = decodeTexture(png, 'image/png')!;
    let s = 0;
    for (let i = 0; i < t.width * t.height; i++) s += 0.2126 * t.data[3 * i]! + 0.7152 * t.data[3 * i + 1]! + 0.0722 * t.data[3 * i + 2]!;
    return s / (t.width * t.height);
  };

  it('the laundry under its ceiling light reads lit at night, and dark with the light off', async () => {
    const on = await renderLit(showcase(), { room: 'R3', lights: 'on', width: 96 });
    const off = await renderLit(showcase(), { room: 'R3', lights: 'off', width: 96 });
    expect(on.lit?.exposure).toBeGreaterThanOrEqual(EXPOSURE_PER_NIT.night);
    expect(on.lit?.exposure).toBeLessThanOrEqual(EXPOSURE_PER_NIT.nightMax);
    // Linear means: lit, a mid-to-light picture; off, all but black.
    expect(meanOf(on.png)).toBeGreaterThan(0.15);
    expect(meanOf(off.png)).toBeLessThan(0.02);
  });
});
