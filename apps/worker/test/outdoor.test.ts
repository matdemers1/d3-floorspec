/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { check, OFFICIAL_READER, type DerivedOutdoor } from '@floorspec/engine';
import { buildScene, type Scene } from '../src/export/gltf/index.js';
import { ptScene, renderSceneStill, resolveSky } from '../src/pathtrace/index.js';

/**
 * FLR-T-15.2: the Courtyard House's back terrace (courtyard-house-outdoor.json, made by
 * make/courtyard-outdoor.mjs) — a pergola over the terrace, a plunge pool south of it with its coping
 * and water, an outdoor kitchen and a fire pit — valid, in the scene the worker's renderers read, the
 * ground opened over the pool, and path-traced. FLR_RENDER_DIR, when set, is where the still is written.
 */

type Json = Record<string, unknown>;
const TEXT = readFileSync(new URL('./fixtures/courtyard-house-outdoor.json', import.meta.url), 'utf8');
const doc = JSON.parse(TEXT) as Json;
let scene: Scene;
beforeAll(async () => {
  scene = await buildScene(doc);
}, 120_000);

const FT = 390_144;
const M = 1_280_000;

describe('the back terrace', () => {
  it('is a valid plan with its pergola, plunge pool, kitchen and fire pit', () => {
    const r = check(TEXT, OFFICIAL_READER);
    expect(r.valid, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error'))).toBe(true);
    const x = r.derived!.extensions!.FS_outdoor as DerivedOutdoor;
    expect(x.pools['OX1']).toMatchObject({ form: 'plunge', basin: [6 * FT, 12 * FT] });
    expect(x.shelters['OX2']!.posts).toBe(10);
    expect(Object.keys(x.kitchens)).toEqual(['OX3']);
    expect(Object.keys(x.fires)).toEqual(['OX4']);
  });

  it('opens the ground over the pool in the path tracer, and keeps the ground at the floor', () => {
    const pt = ptScene(scene, {});
    expect(pt.holes?.length ?? 0).toBeGreaterThan(0);
    // the house's own lowest ground (its front walk steps down 1'), never the pool's floor, 5' 6" down
    expect(pt.floor).toBeGreaterThan(-0.6);
  });

  it('path-traces the terrace under a clear sky: the pool and the pergola in the frame', async () => {
    const skyLight = resolveSky(doc, { sky: 'clear', at: '2026-06-21T16:00' });
    // From south-east of the pool, looking north-west across it to the pergola over the terrace (metres, +Y up, z = −y).
    const eye: [number, number, number] = [(88 * FT) / M, 5.2, (12 * FT) / M];
    const target: [number, number, number] = [(69 * FT) / M, 0.8, -(26 * FT) / M];
    const dir = process.env['FLR_RENDER_DIR'];
    const big = dir !== undefined && dir !== '';
    const r = await renderSceneStill(scene, {
      skyLight,
      shot: { camera: { eye, target, up: [0, 1, 0], fovY: 52, near: 0.1, label: 'back terrace' }, inside: false },
      pixels: big ? { width: 960, height: 540 } : { width: 64, height: 36 },
      samples: big ? 64 : 2,
      denoise: big,
    });
    expect(r.png.length).toBeGreaterThan(100);
    if (big) writeFileSync(`${dir}/terrace-pathtraced.png`, r.png);
  }, 1_800_000);
});
