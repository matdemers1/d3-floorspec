/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildScene, type Scene } from '../src/export/gltf/index.js';
import { createHandlers, render3dParams } from '../src/queue/handlers.js';
import { EXPOSURE, lampsOf, ptScene, renderLit, sunOf, toneMap, trace, DEFAULT_SUN, type PtScene } from '../src/pathtrace/index.js';
import { findRoom, roomCamera } from '../src/render3d/camera.js';
import { pngSize } from '../src/render/png.js';

/**
 * FLR-T-12.22: the luminaires lit. A room with its lamps on at night is many times brighter than with
 * them off; a closed room beside it, with no lamp of its own, stays as dark as it was — light does
 * not pass through walls; the same seed gives the same picture; and `floorspec_render`'s job draws
 * it with `lights`.
 */

type Json = Record<string, unknown>;
const showcase = (): Json => JSON.parse(readFileSync(new URL('../../../packages/mesh/test/fixtures/showcase.floorspec.json', import.meta.url), 'utf8')) as Json;

/** The showcase with the bedroom's fan light taken out: the bedroom (R2) has no lamp of its own, and no door. */
function darkBedroom(): Json {
  const doc = showcase();
  const lights = ((doc['extensions'] as Json)['FS_electrical'] as { collections: Record<string, Json> }).collections['lights']!;
  delete lights['E14'];
  return doc;
}

let scene: Scene;
beforeAll(async () => {
  scene = await buildScene(darkBedroom());
});

const NIGHT = { sky: [0.00008, 0.0001, 0.00018] as [number, number, number] };

/** The mean luminance a room's own camera sees, with the scene's lamps on or off, at night. */
async function roomLuminance(pt: PtScene, room: string, seed = 7): Promise<{ mean: number; color: Float32Array }> {
  const camera = roomCamera(findRoom(scene.rooms, room)!, scene.doors);
  const sun = { ...sunOf(DEFAULT_SUN, 0), irradiance: 0 };
  const W = 40;
  const H = 30;
  const { color } = await trace(pt, { width: W, height: H, samples: 8, camera, sun, seed, ...NIGHT });
  let sum = 0;
  for (let i = 0; i < W * H; i++) sum += 0.2126 * color[3 * i]! + 0.7152 * color[3 * i + 1]! + 0.0722 * color[3 * i + 2]!;
  return { mean: sum / (W * H), color };
}

describe('lamps in the path tracer', () => {
  it('turns the scene\'s luminaires into lamps on the levels drawn, spots pointing down', () => {
    const lamps = lampsOf(scene);
    expect(lamps).toHaveLength(scene.lights.length);
    expect(scene.lights.map((l) => l.id)).not.toContain('E14');
    const recessed = scene.lights.findIndex((l) => l.fixture === 'recessed');
    expect(lamps[recessed]!.spot?.dir).toEqual([0, -1, 0]);
    expect(lamps.every((l) => l.intensity.every((v) => v > 0) && l.radius > 0)).toBe(true);
    // A level cut below a lamp's level leaves it out.
    expect(lampsOf(scene, () => false)).toEqual([]);
    expect(ptScene(scene, { lights: 'on' }).lamps).toHaveLength(lamps.length);
    expect(ptScene(scene, { lights: 'off' }).lamps).toBeUndefined();
    // Off, a lens shows no light of its own; on (and by default, FLR-T-12.21), it does.
    expect(ptScene(scene, { lights: 'off' }).materials.some((m) => m.emission !== undefined)).toBe(false);
    expect(ptScene(scene, { lights: 'on' }).materials.some((m) => m.emission !== undefined && m.lens === true)).toBe(true);
  });

  it('lights a room at night: its luminance with the lamps on is many times that with them off', async () => {
    const on = await roomLuminance(ptScene(scene, { lights: 'on' }), 'R1');
    const off = await roomLuminance(ptScene(scene, { lights: 'off' }), 'R1');
    expect(on.mean).toBeGreaterThan(1e-4);
    expect(on.mean).toBeGreaterThan(50 * off.mean);
  });

  it('does not light the room behind a wall: a closed room with no lamp stays as dark as with the lamps off', async () => {
    const on = await roomLuminance(ptScene(scene, { lights: 'on' }), 'R2');
    const off = await roomLuminance(ptScene(scene, { lights: 'off' }), 'R2');
    const lit = await roomLuminance(ptScene(scene, { lights: 'on' }), 'R1');
    // Exactly as dark: not one shadow ray from the bedroom reached a lamp.
    expect(on.mean).toBe(off.mean);
    expect(on.mean).toBeLessThan(lit.mean / 1000);
  });

  it('gives the same picture for the same seed, and another for another', async () => {
    const pt = ptScene(scene, { lights: 'on' });
    const a = await roomLuminance(pt, 'R3', 11);
    const b = await roomLuminance(pt, 'R3', 11);
    const c = await roomLuminance(pt, 'R3', 12);
    expect(Buffer.from(a.color.buffer).equals(Buffer.from(b.color.buffer))).toBe(true);
    expect(Buffer.from(a.color.buffer).equals(Buffer.from(c.color.buffer))).toBe(false);
  });

  it('exposes to a fixed exposure when one is given, so on and off are not evened out', () => {
    // Auto-exposure makes a room and the same room ten times brighter the same grey…
    expect(Math.abs(toneMap(new Float32Array(12).fill(0.05), 2, 2)[0]! - toneMap(new Float32Array(12).fill(0.5), 2, 2)[0]!)).toBeLessThanOrEqual(1);
    // …a fixed exposure keeps them apart.
    const dim = toneMap(new Float32Array(12).fill(0.0002), 2, 2, EXPOSURE.night)[0]!;
    const bright = toneMap(new Float32Array(12).fill(0.002), 2, 2, EXPOSURE.night)[0]!;
    expect(bright).toBeGreaterThan(dim + 60);
  });
});

describe('a 3D render with lights', () => {
  it('reads lights and time from a job row, and drops what is not one of them', () => {
    expect(render3dParams({ lights: 'on', time: 'dusk' })).toMatchObject({ lights: 'on', time: 'dusk' });
    expect(render3dParams({ lights: 'dim', time: 'noon' })).toEqual({});
  });

  it('is path-traced at night by the render.3d job, cut away at the lowest level, at a fixed exposure', async () => {
    const handlers = createHandlers();
    const job = { id: 'j', projectId: 'p', kind: 'render.3d', versionHash: 'c'.repeat(64), params: { lights: 'on', width: 96 } };
    const out = await handlers['render.3d']!(darkBedroom(), job);
    expect(out.contentType).toBe('image/png');
    expect(pngSize(out.bytes)).toEqual({ width: 96, height: 72 });
    expect(out.summary).toMatchObject({ lit: { lights: 'on', time: 'night', lamps: scene.lights.length } });
    const off = await renderLit(darkBedroom(), { lights: 'off', width: 96 });
    expect(off.lit).toEqual({ lights: 'off', time: 'night', lamps: 0 });
    await expect(renderLit(darkBedroom(), { lights: 'on', width: 4000 })).rejects.toThrow(/pixels wide/);
  });
});
