/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { embedLibraryMaterial, LIBRARY_FILES, LIBRARY_MATERIALS, swapToLibraryMaterial } from '@floorspec/mesh/materials';
import { buildScene, exportGltf, libraryBytes, readGlb, withLibrary } from '../src/export/gltf/index.js';
import { decodeTexture, ptScene, texturesOf } from '../src/pathtrace/index.js';
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

/** The document with the white oak's `color` set to something no oak is: what a view shows of it must not change. */
function tinted(doc: Json, color: string): Json {
  const materials = { ...(doc['materials'] as Record<string, Json>) };
  materials['white-oak-plank'] = { ...materials['white-oak-plank']!, color };
  return { ...doc, materials };
}

const srgbLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearOf = (hex: string): [number, number, number] => [1, 3, 5].map((i) => srgbLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];

describe('the colour and the colour map (FLR-T-13.17, Core 18.1)', () => {
  const doc = dressed();

  it('is the texel under a map in every view — never the colour times it — and the colour where there is no map', async () => {
    // The raster render, the path tracer's materials and the glTF the GPU still loads: a red oak is
    // drawn exactly as the oak is. Before 0.3's maps the colour was the floor; with a map it is the plan's.
    const red = tinted(doc, '#ff0000');
    const [a, b] = await Promise.all([render3dPng(doc, { room: 'LIV', width: 240 }), render3dPng(red, { room: 'LIV', width: 240 })]);
    expect(Buffer.from(b.png).equals(Buffer.from(a.png)), 'raster').toBe(true);
    const scene = await buildScene(red);
    const pt = ptScene(scene, { textures: texturesOf(scene, withLibrary(undefined)).textures });
    const oak = scene.materials.findIndex((m) => m.floorspec === 'white-oak-plank');
    expect(pt.materials[oak]!.rgb).toEqual([1, 1, 1]);
    const { json } = readGlb((await exportGltf(red, { version: { hash: 'f'.repeat(64) } })).bytes);
    const mats = json['materials'] as { name: string; pbrMetallicRoughness: { baseColorFactor: number[] } }[];
    expect(mats.find((m) => m.name.startsWith('white-oak-plank'))!.pbrMetallicRoughness.baseColorFactor.slice(0, 3)).toEqual([1, 1, 1]);
    // Without a map the colour is the surface: the siding keeps its own.
    const siding = scene.materials.findIndex((m) => m.floorspec === 'SIDING');
    expect(pt.materials[siding]!.rgb).toEqual(scene.materials[siding]!.baseColor.slice(0, 3));
  });

  it('agree: every library colour map averages to its item\'s colour, so the plan\'s colour and the 3D view\'s are one material', () => {
    const require = createRequire(import.meta.url);
    const off: string[] = [];
    for (const item of LIBRARY_MATERIALS) {
      const file = item.texture?.maps.albedo;
      // A bare metal's map is its measured reflectance, not calibrated to its colour.
      if (file === undefined || item.metallic === 1000) continue;
      const t = decodeTexture(new Uint8Array(readFileSync(require.resolve(`@floorspec/mesh/materials/${file}`))), 'image/jpeg')!;
      const mean = [0, 0, 0];
      const n = t.width * t.height;
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c]! += t.data[3 * i + c]! / n;
      const want = linearOf(item.color);
      for (let c = 0; c < 3; c++) if (Math.abs(mean[c]! / want[c]! - 1) > 0.05) off.push(`${item.id}[${String(c)}]: ${(mean[c]! / want[c]!).toFixed(3)}`);
    }
    expect(off).toEqual([]);
  });
});
