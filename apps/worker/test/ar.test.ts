/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arScene, buildScene, capTexture, decimate, exportUsdz, groundShift, groupOf, MAX_AR_TEXTURE, readStoreZip, type ScenePrimitive } from '../src/export/gltf/index.js';
import { arOf, createHandlers, exportParams } from '../src/queue/handlers.js';
import { imageSize } from '../src/pathtrace/textures.js';
import { rasterize } from '../src/render/png.js';

/**
 * FLR-T-14.3: the USDZ export tuned for AR Quick Look — true scale on the lot or 1:50 on a table,
 * anchored on a horizontal plane, the lowest floor on the ground at the footprint's centre, every file
 * stored and 64-byte aligned, furniture and fixtures simplified, the site left out unless asked for,
 * maps at most 2048 px; and — where Apple's usdchecker is installed — both scales pass its ARKit rules.
 */

type Json = Record<string, unknown>;
const VERSION = { version: { hash: 'f'.repeat(64), seq: 3 } };
const here = (p: string): string => new URL(p, import.meta.url).pathname;
const load = (p: string): Json => JSON.parse(readFileSync(p, 'utf8')) as Json;
const COURTYARD = load(here('./fixtures/courtyard-house.json'));
const STAIR = load(here('../../web/e2e/fixtures/l-stair-hip-roof.json'));
const usdaOf = (bytes: Uint8Array): string => new TextDecoder().decode(readStoreZip(bytes)[0]!.bytes);
const usdchecker = spawnSync('usdchecker', ['--help'], { encoding: 'utf8' }).status === 0;

/** The root prim's translation, as written. */
function translation(usda: string): [number, number, number] {
  const m = /def Xform "Model"[\s\S]*?double3 xformOp:translate = \((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/.exec(usda);
  expect(m).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

describe('USDZ for AR Quick Look (FLR-T-14.3)', () => {
  it('is stored and 64-byte aligned, anchored on a horizontal plane, the lowest floor on the ground at the footprint’s centre', async () => {
    const file = await exportUsdz(COURTYARD, { ...VERSION, ar: { scale: 'true' } });
    expect(file.contentType).toBe('model/vnd.usdz+zip');
    expect(file.name).toBe('courtyard-house-v3.usdz');
    const entries = readStoreZip(file.bytes);
    expect(entries[0]!.name).toBe('model.usda');
    for (const e of entries) {
      expect(e.method, e.name).toBe(0);
      expect(e.offset % 64, e.name).toBe(0);
    }
    const usda = usdaOf(file.bytes);
    expect(usda).toContain('metersPerUnit = 1');
    expect(usda).toContain('upAxis = "Y"');
    expect(usda).toContain('prepend apiSchemas = ["Preliminary_AnchoringAPI"]');
    expect(usda).toContain('uniform token preliminary:anchoring:type = "plane"');
    expect(usda).toContain('uniform token preliminary:planeAnchoring:alignment = "horizontal"');
    expect(usda).toContain('string scale = "1:1"');
    // True scale: no scale on the root, only the move to the ground.
    expect(usda).toContain('uniform token[] xformOpOrder = ["xformOp:translate"]');
    expect(usda).not.toContain('xformOp:scale');
    // Level 1's floor (elevation 0) to y = 0; the footprint's centre to the origin.
    const scene = arScene(await buildScene(COURTYARD), {});
    const [tx, ty, tz] = translation(usda);
    expect(ty).toBeCloseTo(-Math.min(...scene.levels.map((l) => l.elevation)), 5);
    expect(ty).toBeCloseTo(0, 5);
    expect(tx).toBeCloseTo(-(scene.bounds!.min[0] + scene.bounds!.max[0]) / 2, 5);
    expect(tz).toBeCloseTo(-(scene.bounds!.min[2] + scene.bounds!.max[2]) / 2, 5);
    // The slab under the floor goes below the ground; the house stands on it.
    expect(scene.bounds!.min[1] + ty).toBeLessThan(0);
    expect(scene.bounds!.max[1] + ty).toBeGreaterThan(6);
    // A phone opens it whole: well under what the untuned export was (54 MB, 205k triangles).
    expect(file.bytes.byteLength).toBeLessThan(36 * 1024 * 1024);
    expect(file.summary['triangles']).toBeLessThan(120_000);
    expect(file.summary['ar']).toMatchObject({ scale: 'true', ratio: '1:1', roofs: true, furniture: true, fixtures: true, site: false });
  }, 60_000);

  it('at table scale is the same house at 1:50: a scale on the root prim, applied after the move to the ground', async () => {
    const trueScale = await exportUsdz(STAIR, { ...VERSION, ar: { scale: 'true' } });
    const table = await exportUsdz(STAIR, { ...VERSION, ar: { scale: 'table' } });
    expect(table.name).toMatch(/-v3-table\.usdz$/);
    const t = usdaOf(table.bytes);
    expect(t).toContain('string scale = "1:50"');
    expect(t).toContain('float3 xformOp:scale = (0.02, 0.02, 0.02)');
    expect(t).toContain('uniform token[] xformOpOrder = ["xformOp:scale", "xformOp:translate"]');
    // Everything else as at true scale: the stage still in metres, the same move, the same meshes.
    const u = usdaOf(trueScale.bytes);
    expect(translation(t)).toEqual(translation(u));
    expect(t.match(/def Mesh /g)!.length).toBe(u.match(/def Mesh /g)!.length);
    expect(t).toContain('metersPerUnit = 1');
    for (const e of readStoreZip(table.bytes)) expect(e.offset % 64).toBe(0);
    // Grounded on the lowest level's floor, which is not the lowest point.
    const scene = await buildScene(STAIR);
    expect(groundShift(scene)[1]).toBeCloseTo(-Math.min(...scene.levels.map((l) => l.elevation)), 9);
  });

  it('includes what it is asked to: roofs, furniture, fixtures, and the site only when asked', async () => {
    const scene = await buildScene(COURTYARD);
    const kinds = (s: typeof scene) => new Set(s.levels.flatMap((l) => l.nodes.map((n) => groupOf(n) ?? n.kind)));
    const parts = (s: typeof scene) => new Set(s.levels.flatMap((l) => l.nodes.flatMap((n) => n.primitives.map((p) => p.part))));
    expect(kinds(scene)).toContain('site');
    const plain = arScene(scene, {});
    expect(kinds(plain)).not.toContain('site');
    expect(kinds(plain)).toContain('furniture');
    expect(kinds(plain)).toContain('fixtures');
    expect(parts(plain)).toContain('roof');
    expect(kinds(arScene(scene, { site: true }))).toContain('site');
    expect(kinds(arScene(scene, { furniture: false }))).not.toContain('furniture');
    expect(kinds(arScene(scene, { fixtures: false }))).not.toContain('fixtures');
    expect(parts(arScene(scene, { roofs: false }))).not.toContain('roof');
    // The house itself is always there.
    for (const k of ['wall', 'room', 'opening', 'stair']) expect(kinds(arScene(scene, { roofs: false, furniture: false, fixtures: false }))).toContain(k);
  }, 60_000);

  it('simplifies a finely made mesh on a 1 cm grid, and leaves a coarse one as it is', () => {
    // A disc of 512 slivers 10 cm across: far finer than the grid.
    const fine = disc(512, 0.05);
    const out = decimate(fine, 0.01);
    expect(out.indices.length / 3).toBeLessThan(fine.indices.length / 3 / 4);
    expect(out.indices.length % 3).toBe(0);
    for (const i of out.indices) expect(i).toBeLessThan(out.positions.length / 3);
    for (let i = 0; i < out.normals.length; i += 3) expect(Math.hypot(out.normals[i]!, out.normals[i + 1]!, out.normals[i + 2]!)).toBeCloseTo(1, 5);
    // A metre-wide disc of 16 sides: nothing to gain.
    const coarse = disc(16, 0.5);
    expect(decimate(coarse, 0.01)).toBe(coarse);
  });

  it('keeps maps at most 2048 px on their long side', () => {
    const big = rasterize('<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="1000"><rect width="3000" height="1000" fill="#a0b0c0"/></svg>');
    expect(imageSize(big, 'image/png')).toEqual({ width: 3000, height: 1000 });
    const capped = capTexture(big, 'image/png')!;
    expect(capped.mediaType).toBe('image/png');
    expect(imageSize(capped.bytes, 'image/png')).toEqual({ width: MAX_AR_TEXTURE, height: 683 });
    const small = rasterize('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#a0b0c0"/></svg>');
    expect(capTexture(small, 'image/png')!.bytes).toBe(small);
    expect(capTexture(new Uint8Array([1, 2, 3]), 'image/png')).toBeUndefined();
  });

  it('takes its scale and include from the job the api queued, and the worker’s USDZ job writes them', async () => {
    expect(arOf({ scale: 'table', site: true, roofs: false, junk: 1 })).toEqual({ scale: 'table', site: true, roofs: false });
    expect(arOf({ scale: 'huge' })).toBeUndefined();
    expect(exportParams({ ar: { scale: 'true' } }).ar).toEqual({ scale: 'true' });
    const table = createHandlers();
    const job = { id: 'j', kind: 'export.usdz', versionHash: 'f'.repeat(64), params: { versionSeq: 3, ar: { scale: 'table', roofs: false } } };
    const out = await table['export.usdz']!(STAIR, job as never);
    expect(out.name).toMatch(/-table\.usdz$/);
    expect(usdaOf(out.bytes)).toContain('string scale = "1:50"');
    expect(out.summary).toMatchObject({ ar: { scale: 'table', roofs: false } });
  });

  it.skipIf(!usdchecker)('passes usdchecker --arkit at true scale and at table scale', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usdz-ar-'));
    for (const scale of ['true', 'table'] as const) {
      const file = await exportUsdz(STAIR, { ...VERSION, ar: { scale, site: true } });
      const path = join(dir, `stair-${scale}.usdz`);
      writeFileSync(path, file.bytes);
      expect(execFileSync('usdchecker', ['--arkit', '--strict', path], { encoding: 'utf8' }), scale).toContain('Success!');
    }
  }, 120_000);
});

/** A flat disc in the y = 0 plane: `n` triangles fanned round its centre. */
function disc(n: number, radius: number): ScenePrimitive {
  const positions = new Float32Array(3 * (n + 1));
  const normals = new Float32Array(3 * (n + 1));
  const indices = new Uint32Array(3 * n);
  for (let i = 0; i <= n; i++) normals.set([0, 1, 0], 3 * i);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    positions.set([0.3 + radius * Math.cos(a), 0, 0.3 + radius * Math.sin(a)], 3 * (i + 1));
    indices.set([0, 1 + ((i + 1) % n), 1 + i], 3 * i);
  }
  return { material: 0, part: 'extension', positions, normals, uvs: null, indices };
}
