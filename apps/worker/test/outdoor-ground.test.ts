/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildScene, type Scene } from '../src/export/gltf/index.js';
import { ptScene } from '../src/pathtrace/index.js';
import { trace, type PtScene } from '../src/pathtrace/trace.js';
import { groundOfScene, sceneTriangles } from '../src/render3d/index.js';
import { inHoles, platePoints } from '../src/render3d/sunken.js';

/**
 * FLR-T-15.2: a sunken pool is seen. The back terrace of FS_outdoor's suite has a plunge pool 5′ 6″
 * deep south of its patio and a spa sunk 2′ into the courtyard's floor: the worker's ground lies under
 * everything else — at the floor, not the pool's — and opens over each pool, in the plate a headless
 * render draws and in the path tracer's ground plane.
 */

type Json = Record<string, unknown>;
const TERRACE = (): Json => JSON.parse(readFileSync(new URL('../../../packages/engine/standard/conformance/ext/FS_outdoor/0.1.0/examples/001-p15-back-terrace/input.json', import.meta.url), 'utf8')) as Json;
const FT = 0.3048;

let scene: Scene;
beforeAll(async () => {
  scene = await buildScene(TERRACE());
}, 120_000);

describe('the ground under a sunken pool', () => {
  it('lies at the floor, not at the pool’s bottom, and opens over each pool', () => {
    const g = groundOfScene(scene);
    expect(g.min[1]).toBeLessThan(-1.6); // the plunge pool's floor, 66″ down
    expect(g.ground).toBeGreaterThan(-0.2); // the patio slab's bottom, 100 mm down, at most
    const holes = g.holes;
    expect(holes.length).toBe(2);
    // plan (7′, −18′), the plunge pool's middle, is (x, −y) in the scene's frame
    expect(inHoles(7 * FT, 18 * FT, holes)).toBe(true);
    expect(inHoles(7 * FT, 5 * FT, holes)).toBe(false);
  });

  it('is a plate with the pools left out in the headless render', () => {
    const tris = sceneTriangles(scene);
    const plate = tris.filter((t) => t.key === -2);
    expect(plate.length).toBeGreaterThan(2);
    const holes = groundOfScene(scene).holes;
    for (const t of plate) {
      expect(t.a[1]).toBeGreaterThan(-0.25);
      expect(inHoles((t.a[0] + t.b[0] + t.c[0]) / 3, (t.a[2] + t.b[2] + t.c[2]) / 3, holes)).toBe(false);
    }
  });

  it('is the path tracer’s, at the floor, with the pools as holes', () => {
    const pt = ptScene(scene);
    expect(pt.floor).toBeGreaterThan(-0.25);
    expect(pt.holes.length).toBe(2);
    expect(pt.plateCount).toBeGreaterThan(2);
  });

  it('lets a ray through the ground plane where it is open', async () => {
    // a red floor 1 m under a ground plane at 0, seen from straight above
    const tri = (a: number[], b: number[], c: number[]) => [...a, ...b, ...c];
    const positions = Float64Array.from([...tri([-10, -1, 10], [10, -1, 10], [10, -1, -10]), ...tri([-10, -1, 10], [10, -1, -10], [-10, -1, -10])]);
    const scene1: PtScene = {
      count: 2,
      positions,
      normals: Float64Array.from([0, 1, 0, 0, 1, 0]),
      material: Int32Array.from([0, 0]),
      uvs: new Float32Array(12).fill(NaN),
      materials: [{ rgb: [1, 0, 0], glass: false }],
    };
    const camera = { eye: [0, 10, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 0, -1] as [number, number, number], fovY: 10, near: 0.05, label: 'down' };
    const run = (holes?: [number, number][][]) =>
      trace(scene1, { width: 4, height: 4, samples: 2, camera, sun: { dir: [0, 1, 0], irradiance: 1, radius: 0.005, color: [1, 1, 1] }, seed: 1, ground: { y: 0, ...(holes === undefined ? {} : { holes }) } });
    const shut = (await run()).color;
    const open = (await run([[[-5, -5], [5, -5], [5, 5], [-5, 5]]])).color;
    const red = (c: Float32Array) => c[0]! - c[1]!;
    // shut: the lawn, greener than red; open: the red floor under it
    expect(red(open)).toBeGreaterThan(0);
    expect(red(open)).toBeGreaterThan(red(shut));
  });

  it('builds a plate that covers all but the holes', () => {
    const tris = platePoints(0, 0, 100, 0, [[[-1, -1], [1, -1], [1, 1], [-1, 1]]]);
    const area = tris.reduce((s, [a, b, c]) => s + Math.abs((b![0] - a![0]) * (c![2] - a![2]) - (c![0] - a![0]) * (b![2] - a![2])) / 2, 0);
    expect(area).toBeCloseTo(200 * 200 - 4, 6);
  });
});
