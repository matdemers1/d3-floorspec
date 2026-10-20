/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { sceneNamed, type Lighting } from '@floorspec/mesh';
import { check, OFFICIAL_READER, type FloorspecDocument } from '@floorspec/engine';
import { buildScene, exportGltf, type Scene } from '../src/export/gltf/index.js';
import { ptScene, resolveSky, renderSceneStill } from '../src/pathtrace/index.js';
import { rasterStage } from '../src/render3d/index.js';

/**
 * FLR-T-15.5: the Courtyard House's grounds lit at night (courtyard-night.json, made by
 * make/courtyard-night.mjs from the electrical assistant's exterior proposal and lights placed by
 * hand) — path lights, uplights into the trees, wall-washers, string lights — in every renderer the
 * worker feeds: the scene's lamps aimed as each kind shines, the glTF export's spots turned to their
 * aim (the GPU still reads them), the path tracer's lamps, and the rasterizer's lamps outside any room.
 */

type Json = Record<string, unknown>;
const NIGHT = (): Json => JSON.parse(readFileSync(new URL('./fixtures/courtyard-night.json', import.meta.url), 'utf8')) as Json;

let doc: Json;
let night: Lighting;
let scene: Scene;
let dark: Scene;
beforeAll(async () => {
  doc = NIGHT();
  night = sceneNamed(doc as unknown as FloorspecDocument, 'Night exterior')!.lighting;
  scene = await buildScene(doc, { lighting: night });
  dark = await buildScene(doc, { lighting: { on: {} } });
}, 120_000);

const exterior = (s: Scene) => s.lights.filter((l) => l.fixture === 'exterior' && l.room === null);

describe('a night exterior in the scene every renderer reads', () => {
  it('is a valid plan with the grounds’ lights on', () => {
    expect(check(JSON.stringify(doc), OFFICIAL_READER).valid).toBe(true);
    expect(exterior(scene).length).toBeGreaterThan(25);
    expect(exterior(dark)).toEqual([]);
  });

  it('aims each kind’s lamp as it shines: an uplight up, a path light and a wall-washer down', () => {
    const lights = (JSON.parse(JSON.stringify(doc)) as { extensions: { FS_electrical: { collections: { lights: Record<string, Json> } } } }).extensions.FS_electrical.collections.lights;
    const kind = (id: string) => (((lights[id]?.['extras'] as Json | undefined)?.['d3floorspec'] as Json | undefined)?.['exterior'] as { kind?: string } | undefined)?.kind;
    const ups = exterior(scene).filter((l) => kind(l.id) === 'uplight');
    const paths = exterior(scene).filter((l) => kind(l.id) === 'path');
    const washes = exterior(scene).filter((l) => kind(l.id) === 'wallWash');
    expect(ups.length).toBeGreaterThan(4);
    expect(paths.length).toBeGreaterThan(5);
    expect(washes.length).toBeGreaterThan(1);
    // The scene's frame is metres with +Y up.
    for (const l of ups) expect(l.spot!.dir[1]).toBeGreaterThan(0.5);
    for (const l of paths) expect(l.spot!.dir[1]).toBe(-1);
    for (const l of washes) expect(l.spot!.dir[1]).toBeLessThan(-0.9);
    // A string light shines from three of its bulbs.
    const strings = exterior(scene).filter((l) => kind(l.id) === 'string');
    expect(strings.length % 3).toBe(0);
    expect(strings.every((l) => l.spot === undefined)).toBe(true);
  });

  it('turns each glTF spot to its aim, as the GPU still reads it', async () => {
    const glb = await exportGltf(doc, { version: { hash: 'a'.repeat(64), seq: 1 }, lighting: night });
    const view = new DataView(glb.bytes.buffer, glb.bytes.byteOffset, glb.bytes.byteLength);
    const json = JSON.parse(new TextDecoder().decode(glb.bytes.subarray(20, 20 + view.getUint32(12, true)))) as { nodes: { name?: string; rotation?: number[]; extensions?: { KHR_lights_punctual?: { light: number } } }[]; extensions: { KHR_lights_punctual: { lights: { type: string }[] } } };
    const spots = json.nodes.filter((n) => n.extensions?.KHR_lights_punctual !== undefined && json.extensions.KHR_lights_punctual.lights[n.extensions.KHR_lights_punctual.light]!.type === 'spot');
    // An uplight's node is turned so its −Z looks up: its rotation is no straight-down turn.
    const turned = spots.filter((n) => n.rotation !== undefined).map((n) => n.rotation!);
    const forward = (q: number[]): [number, number, number] => {
      const [x, y, z, w] = q as [number, number, number, number];
      // −Z rotated by q.
      return [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))];
    };
    expect(turned.some((q) => forward(q)[1] > 0.5)).toBe(true);
    expect(turned.some((q) => forward(q)[1] < -0.9)).toBe(true);
  }, 120_000);

  it('gives the path tracer the grounds’ lamps, and the rasterizer lamps outside every room', () => {
    expect(ptScene(scene, { lights: 'on' }).lamps!.length).toBe(scene.lights.length);
    const stage = rasterStage(scene);
    const outside = stage.lamps().filter((l) => l.room.ceiling - l.room.floor > 15);
    expect(outside.length).toBe(exterior(scene).length);
  });

  it('lights the courtyard at night: brighter with the scene than with every light off', async () => {
    const skyLight = resolveSky(doc, { sky: 'night' });
    const camera = { eye: [1.2, 1.7, -5.6] as [number, number, number], target: [9, 2.6, -12.5] as [number, number, number], up: [0, 1, 0] as [number, number, number], fovY: 70, near: 0.1, label: 'courtyard' };
    const mean = async (s: Scene) => {
      const r = await renderSceneStill(s, { skyLight, shot: { camera, inside: false }, pixels: { width: 48, height: 27 }, samples: 4, lights: 'on', exposureScale: 1, radiance: true, denoise: false });
      return r.radiance!.reduce((a, v) => a + v, 0) / r.radiance!.length;
    };
    const lit = await mean(scene);
    const off = await mean(dark);
    expect(lit).toBeGreaterThan(3 * off);
  }, 180_000);
});
