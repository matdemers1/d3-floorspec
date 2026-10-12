/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { embedLibraryMaterial, LIBRARY_FILES, swapToLibraryMaterial } from '@floorspec/mesh/materials';
import { buildScene, exportGltf, libraryBytes, readGlb, withLibrary } from '../src/export/gltf/index.js';
import { ptScene, texturesOf } from '../src/pathtrace/index.js';
import { render3dPng } from '../src/render3d/index.js';

/**
 * FLR-T-13.6: the material library in the worker's views. A house whose living room's floor is
 * the library's white oak plank and whose siding is its lap siding (in place, keeping its colour):
 * every map is read from the library's own files when the store has none, the path tracer reads
 * the colour, normal and occlusion-roughness-metalness maps — the texel the colour, not the colour
 * times it — the raster render samples them, and the glTF embeds them.
 */

type Json = Record<string, unknown>;
const TWO_STOREY = JSON.parse(readFileSync(new URL('./fixtures/two-storey.json', import.meta.url), 'utf8')) as Json;

function dressed(): Json {
  const oak = embedLibraryMaterial(TWO_STOREY, 'white-oak-plank');
  const batch = [...oak.ops, { op: 'setProperty', id: 'LIV', path: '/floorFinish', value: oak.id }, ...swapToLibraryMaterial(TWO_STOREY, 'SIDING', 'lap-siding')];
  const r = apply(TWO_STOREY, { batch });
  if (r.status !== 'committed') throw new Error(JSON.stringify(r));
  return JSON.parse(r.document) as Json;
}

describe('the material library in the worker', () => {
  const doc = dressed();

  it('reads a library map from the package when the store does not have it, checked against its digest', () => {
    const f = LIBRARY_FILES['white-oak-plank.albedo.jpg']!;
    expect(libraryBytes(f.sha256)?.length).toBe(f.byteLength);
    expect(libraryBytes('0'.repeat(64))).toBeUndefined();
    expect(withLibrary(undefined)({ id: 'x', sha256: f.sha256, mediaType: 'image/jpeg' })?.length).toBe(f.byteLength);
  });

  it('gives the path tracer every map, the texel as the colour, and a colour-agnostic material its own colour', async () => {
    const scene = await buildScene(doc);
    const maps = texturesOf(scene, withLibrary(undefined));
    const oak = scene.materials.findIndex((m) => m.floorspec === 'white-oak-plank');
    const siding = scene.materials.findIndex((m) => m.floorspec === 'SIDING');
    expect(Object.keys(maps.textures.get(oak)!).sort()).toEqual(['albedo', 'normal', 'orm']);
    expect(Object.keys(maps.textures.get(siding)!).sort()).toEqual(['normal', 'orm']);
    expect(maps.used).toContain('white-oak-plank.albedo');
    const pt = ptScene(scene, { textures: maps.textures });
    expect(pt.materials[oak]).toMatchObject({ rgb: [1, 1, 1], metallic: 0 });
    expect(pt.materials[oak]!.normalMap).toBeDefined();
    expect(pt.materials[oak]!.orm).toBeDefined();
    // The siding keeps the colour it had: its maps are only its courses.
    expect(pt.materials[siding]!.rgb[0]).toBeLessThan(0.2);
    expect(pt.materials[siding]!.texture).toBeUndefined();
    // A model's piece of a role the library dresses names its maps as library files.
    expect(Object.keys(scene.assets).some((a) => a.startsWith('library:'))).toBe(scene.materials.some((m) => m.key.startsWith('role:') && m.texture !== undefined));
  });

  it('draws the floor with its planks in the raster render: a floor of one material is no longer one flat colour', async () => {
    const plain = await render3dPng(TWO_STOREY, { room: 'LIV', width: 320 });
    const planks = await render3dPng(doc, { room: 'LIV', width: 320 });
    expect(planks.png.length).not.toBe(plain.png.length);
  });

  it('embeds every map in the glTF, with the base colour factor white under the colour map', async () => {
    const file = await exportGltf(doc, { version: { hash: 'f'.repeat(64) } });
    const { json } = readGlb(file.bytes);
    const mats = json['materials'] as { name: string; pbrMetallicRoughness: { baseColorFactor: number[]; baseColorTexture?: unknown; metallicRoughnessTexture?: unknown }; normalTexture?: unknown; occlusionTexture?: unknown }[];
    const oak = mats.find((m) => m.name.startsWith('white-oak-plank'))!;
    expect(oak.pbrMetallicRoughness.baseColorTexture).toBeDefined();
    expect(oak.pbrMetallicRoughness.metallicRoughnessTexture).toBeDefined();
    expect(oak.normalTexture).toBeDefined();
    expect(oak.occlusionTexture).toBeDefined();
    expect(oak.pbrMetallicRoughness.baseColorFactor.slice(0, 3)).toEqual([1, 1, 1]);
  });
});
