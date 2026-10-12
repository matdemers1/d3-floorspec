/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { sceneNamed, type Lighting } from '@floorspec/mesh';
import type { FloorspecDocument } from '@floorspec/engine';
import { buildScene, exportGltf, type Scene } from '../src/export/gltf/index.js';
import { createHandlers, exportParams, render3dParams } from '../src/queue/handlers.js';
import { DEFAULT_SUN, lampsOf, ptScene, sunOf, trace, type PtScene } from '../src/pathtrace/index.js';
import { findRoom, roomCamera } from '../src/render3d/camera.js';
import { pngSize } from '../src/render/png.js';

/**
 * FLR-T-13.12: a lighting scene (FS_lighting 0.1.0) in every renderer the worker feeds — the path
 * tracer's lamps and lenses, the glTF export's KHR_lights_punctual and lit lenses (which the GPU
 * still reads), and the jobs that take a scene. The showcase house with two scenes: "Evening" (the
 * kitchen's pendant dimmed warm and the lantern; the downlights off) and "All on".
 */

type Json = Record<string, unknown>;
const showcase = (): Json => JSON.parse(readFileSync(new URL('../../../packages/mesh/test/fixtures/showcase.floorspec.json', import.meta.url), 'utf8')) as Json;

function withScenes(): Json {
  const doc = showcase();
  (doc['extensionsUsed'] as Json)['FS_lighting'] = '0.1.0';
  (doc['extensions'] as Json)['FS_lighting'] = {
    luminaires: { E7: { lumens: 1000, cct: 2700, cctRange: [2200, 3000], dimmable: true } },
    scenes: { LS1: { name: 'Evening', on: { E7: { output: 40, cct: 2400 }, E15: {} } } },
  };
  return doc;
}

let doc: Json;
let evening: Lighting;
let all: Scene;
let lit: Scene;
beforeAll(async () => {
  doc = withScenes();
  evening = sceneNamed(doc as unknown as FloorspecDocument, 'Evening')!.lighting;
  all = await buildScene(doc);
  lit = await buildScene(doc, { lighting: evening });
});

const lensesOf = (scene: Scene, id: string) =>
  scene.levels.flatMap((l) => l.nodes.filter((n) => n.id === id)).flatMap((n) => n.primitives.map((p) => scene.materials[p.material]!)).filter((m) => m.key.startsWith('role:lens') || m.key.startsWith('role:shade'));

describe('a lighting scene in the scene every renderer reads', () => {
  it('keeps only the lights the scene turns on, at its output', () => {
    expect(all.lights.map((l) => l.id).sort()).toEqual(['E10', 'E11', 'E12', 'E13', 'E14', 'E15', 'E7', 'E8', 'E9']);
    expect(lit.lights.map((l) => l.id)).toEqual(['E15', 'E7']);
    expect(lit.lights.find((l) => l.id === 'E7')!.lumens).toBe(400);
    expect(all.lights.find((l) => l.id === 'E7')!.lumens).toBe(1000);
  });

  it('darkens an off fixture’s lens, dims a dimmed one’s and warms it, and leaves the rest as they were', () => {
    // A downlight the scene turns off: its lens is no longer emissive.
    expect(lensesOf(all, 'E8').some((m) => m.emissive !== undefined)).toBe(true);
    expect(lensesOf(lit, 'E8').every((m) => m.emissive === undefined)).toBe(true);
    // The pendant at 40 %, warmer: its lens glows less, and redder than blue.
    const was = lensesOf(all, 'E7').find((m) => m.emissive !== undefined)!.emissive!;
    const now = lensesOf(lit, 'E7').find((m) => m.emissive !== undefined)!.emissive!;
    expect(now[1]).toBeLessThan(0.45 * was[1]);
    expect(now[0] / now[2]).toBeGreaterThan(was[0] / was[2]);
    // The lantern, on at full and its own colour, keeps the shared lens.
    expect(lensesOf(lit, 'E15')).toEqual(lensesOf(all, 'E15'));
  });

  it('gives the path tracer the scene’s lamps and lenses', () => {
    const pt = ptScene(lit, { lights: 'on' });
    expect(pt.lamps).toHaveLength(2);
    expect(lampsOf(all)).toHaveLength(9);
    // The off downlights' lenses give no light; the lantern's does.
    const emitting = new Set(lit.materials.flatMap((m, i) => (m.emissive === undefined ? [] : [i])));
    expect(lensesOf(lit, 'E9').some((m) => emitting.has(lit.materials.indexOf(m)))).toBe(false);
  });

  it('lights the kitchen less in the evening than with everything on', async () => {
    const room = findRoom(all.rooms, 'R1')!;
    const camera = roomCamera(room, all.doors, all.obstacles);
    const sun = { ...sunOf(DEFAULT_SUN, 0), irradiance: 0 };
    const mean = async (pt: PtScene) => {
      const { color } = await trace(pt, { width: 32, height: 24, samples: 6, camera, sun, seed: 3, sky: [0.00008, 0.0001, 0.00018] });
      let s = 0;
      for (let i = 0; i < 32 * 24; i++) s += 0.2126 * color[3 * i]! + 0.7152 * color[3 * i + 1]! + 0.0722 * color[3 * i + 2]!;
      return s / (32 * 24);
    };
    const on = await mean(ptScene(all, { lights: 'on' }));
    const eve = await mean(ptScene(lit, { lights: 'on' }));
    expect(eve).toBeGreaterThan(0);
    expect(on).toBeGreaterThan(2 * eve);
  });

  it('exports the scene’s lamps to glTF (KHR_lights_punctual), as the GPU still reads them', async () => {
    const glb = await exportGltf(doc, { version: { hash: 'a'.repeat(64), seq: 1 }, lighting: evening });
    const json = gltfJson(glb.bytes);
    const lights = (json['extensions'] as { KHR_lights_punctual: { lights: { name?: string; intensity: number }[] } }).KHR_lights_punctual.lights;
    expect(lights).toHaveLength(2);
    const full = gltfJson((await exportGltf(doc, { version: { hash: 'a'.repeat(64), seq: 1 } })).bytes);
    expect((full['extensions'] as { KHR_lights_punctual: { lights: unknown[] } }).KHR_lights_punctual.lights).toHaveLength(9);
  });
});

describe('the jobs that take a scene', () => {
  it('reads a lighting and a scene name from a job row, made well-formed', () => {
    expect(render3dParams({ scene: 'Evening', lighting: { on: { E7: { output: 400, cct: 2400 }, E15: {} } }, lights: 'on' })).toMatchObject({ scene: 'Evening', lighting: { on: { E15: {}, E7: { cct: 2400 } } }, lights: 'on' });
    expect(render3dParams({ lighting: ['E7'] }).lighting).toBeUndefined();
    expect(exportParams({ versionAt: '2026-10-12T00:00:00Z', lighting: { on: { E7: { output: 50 } } } }).lighting).toEqual({ on: { E7: { output: 50 } } });
  });

  it('path-traces floorspec_render with a scene, and says which', async () => {
    const handlers = createHandlers({});
    const out = await handlers['render.3d']!(doc, { id: 'j', kind: 'render.3d', versionHash: 'b'.repeat(64), params: { room: 'R1', width: 64, lights: 'on', scene: 'Evening', lighting: { on: { E7: { output: 40, cct: 2400 }, E15: {} } } } } as never);
    expect(pngSize(out.bytes)).toEqual({ width: 64, height: 48 });
    expect((out.summary as { lit: { scene: string; lamps: number } }).lit).toMatchObject({ scene: 'Evening', lamps: 2 });
  }, 120_000);
});

function gltfJson(bytes: Uint8Array): Json {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as Json;
}
