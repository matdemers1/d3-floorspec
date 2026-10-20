/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { check, OFFICIAL_READER, type DerivedContext } from '@floorspec/engine';
import { CONTEXT_CASTS_SHADE } from '@floorspec/mesh';
import { buildScene, type Scene } from '../src/export/gltf/index.js';
import { renderSceneStill, resolveSky } from '../src/pathtrace/index.js';
import { architecture } from '../src/pathtrace/daylight.js';

/**
 * FLR-T-15.3: the Courtyard House on its street (courtyard-house-on-its-street.json, made by
 * make/courtyard-on-its-street.mjs) — Laurel Ridge Drive on the west, neighbours to the north and south
 * at the lot's side setback, trees beyond — valid, the same house and lot as the back terrace, its
 * context in the scene every renderer reads as nodes marked `context`, shading the daylight study, and
 * path-traced from the south-west. FLR_RENDER_DIR, when set, is where the still is written.
 */

type Json = Record<string, unknown>;
const TEXT = readFileSync(new URL('./fixtures/courtyard-house-on-its-street.json', import.meta.url), 'utf8');
const doc = JSON.parse(TEXT) as Json;
const LOT = JSON.parse(readFileSync(new URL('./fixtures/courtyard-house-outdoor.json', import.meta.url), 'utf8')) as Json;
let scene: Scene;
beforeAll(async () => {
  scene = await buildScene(doc);
}, 120_000);

const FT = 390_144;
const M = 1_280_000;
const nodes = (s: Scene) => s.levels.flatMap((l) => l.nodes);

describe('the Courtyard House on its street', () => {
  it('is valid, its context beyond the lot, and nothing of the design changes', () => {
    const r = check(TEXT, OFFICIAL_READER);
    expect(r.valid, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error'))).toBe(true);
    expect(r.diagnostics.filter((d) => d.code.startsWith('FS-CTXT'))).toEqual([]);
    const x = r.derived!.extensions!.FS_context as DerivedContext;
    expect(Object.values(x.streets)[0]!.width).toBe(49 * FT);
    expect(Object.keys(x.neighbours)).toHaveLength(2);
    const lot = check(JSON.stringify(LOT), OFFICIAL_READER);
    const { extensions: a, ...ra } = r.derived!;
    const { extensions: b, ...rb } = lot.derived!;
    expect(ra).toEqual(rb);
    expect({ ...a, FS_context: undefined }).toEqual({ ...b, FS_context: undefined });
  });

  it('is in the scene as nodes marked context, which shade the daylight study', () => {
    const ctx = nodes(scene).filter((n) => n.kind === 'context');
    expect(new Set(ctx.map((n) => n.extension?.collection))).toEqual(new Set(['streets', 'neighbours', 'trees']));
    expect(ctx.find((n) => n.extension?.collection === 'streets')?.name).toBe('Laurel Ridge Drive');
    expect(CONTEXT_CASTS_SHADE).toBe(true);
    // the daylight study's architecture keeps context as an occluder, and leaves furniture and planting out
    const withContext = architecture(scene);
    const without = architecture({ ...scene, levels: scene.levels.map((l) => ({ ...l, nodes: l.nodes.filter((n) => n.kind !== 'context') })) });
    expect(withContext.count).toBeGreaterThan(without.count);
  });

  it('path-traces the house on its street from the south-west, its neighbours in neutral massing', async () => {
    const skyLight = resolveSky(doc, { sky: 'clear', at: '2026-06-21T15:00' });
    // From south-west of the lot, above the street, looking north-east at the house (metres, +Y up, z = −y).
    const eye: [number, number, number] = [(-150 * FT) / M, 38, (150 * FT) / M];
    const target: [number, number, number] = [(35 * FT) / M, 0, -(30 * FT) / M];
    const dir = process.env['FLR_RENDER_DIR'];
    const big = dir !== undefined && dir !== '';
    const r = await renderSceneStill(scene, {
      skyLight,
      shot: { camera: { eye, target, up: [0, 1, 0], fovY: 46, near: 0.1, label: 'on its street' }, inside: false },
      pixels: big ? { width: 1280, height: 800 } : { width: 64, height: 40 },
      samples: big ? 64 : 2,
      denoise: big,
    });
    expect(r.png.length).toBeGreaterThan(100);
    if (big) writeFileSync(`${dir}/on-its-street-pathtraced.png`, r.png);
  }, 1_800_000);
});
