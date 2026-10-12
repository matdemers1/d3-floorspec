import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { apply } from '@floorspec/ops';
import { describe, expect, it } from 'vitest';
import { embedLibraryMaterial, isLibraryGlass, LIBRARY_CATEGORIES, LIBRARY_FILES, LIBRARY_MATERIALS, libraryFileOf, libraryItemOfMaterial, MATERIAL_LIBRARY, ROLE_LIBRARY, swapToLibraryMaterial } from '../src/materials/index.js';
import { MODEL_ROLES } from '../src/roles.js';

/**
 * FLR-T-13.6: the material library as committed — CC0 maps prepared by scripts/prepare-materials.py,
 * each file the bytes its data module and SOURCES.json record — and every item a Core material that
 * embeds into a document, or replaces one of its materials in place, and validates.
 */

const dir = new URL('../materials/', import.meta.url);
const bytes = (file: string) => new Uint8Array(readFileSync(new URL(file, dir)));
interface Sources { licence: string; originals: { key: string; url: string; sha256: string; licence: string; page: string }[]; files: { file: string; sha256: string; byteLength: number; origin: string }[]; totalBytes: number }
const sources = JSON.parse(readFileSync(new URL('SOURCES.json', dir), 'utf8')) as Sources;
type Json = Record<string, unknown>;

/** The JPEG segments before the image data: what the asset store's upload would strip (APP1, APP13, COM). */
function markers(b: Uint8Array): number[] {
  const out: number[] = [];
  let at = 2;
  while (at + 4 < b.length && b[at] === 0xff) {
    const m = b[at + 1]!;
    out.push(m);
    if (m === 0xda) break;
    at += 2 + ((b[at + 2]! << 8) | b[at + 3]!);
  }
  return out;
}

describe('the library\'s files', () => {
  it('are the files on disk, each the digest, length and size its data module records, and nothing else', () => {
    const onDisk = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
    expect(onDisk).toEqual(Object.keys(LIBRARY_FILES).sort());
    for (const [file, f] of Object.entries(LIBRARY_FILES)) {
      const b = bytes(file);
      expect(b.length, file).toBe(f.byteLength);
      expect(createHash('sha256').update(b).digest('hex'), file).toBe(f.sha256);
      // Its SOF0: height then width.
      const sof = b.findIndex((v, i) => v === 0xff && (b[i + 1] === 0xc0 || b[i + 1] === 0xc2));
      expect(((b[sof + 7]! << 8) | b[sof + 8]!), file).toBe(f.width);
      expect(((b[sof + 5]! << 8) | b[sof + 6]!), file).toBe(f.height);
      // Uploaded into a project, the store keeps them byte for byte: no metadata it would strip.
      expect(markers(b).filter((m) => m === 0xe1 || m === 0xed || m === 0xfe), file).toEqual([]);
      expect(libraryFileOf(f.sha256)).toBe(file);
    }
  });

  it('are recorded in SOURCES.json, from CC0 originals, and keep the repository small', () => {
    expect(sources.licence).toMatch(/CC0/);
    expect(sources.files.map((f) => f.file).sort()).toEqual(Object.keys(LIBRARY_FILES).sort());
    for (const f of sources.files) expect(f.sha256).toBe(LIBRARY_FILES[f.file]!.sha256);
    for (const o of sources.originals) {
      expect(o.url).toMatch(/^https:\/\/(dl\.polyhaven\.org|ambientcg\.com)\//);
      expect(o.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(o.licence).toMatch(/CC0/);
    }
    const total = Object.values(LIBRARY_FILES).reduce((n, f) => n + f.byteLength, 0);
    expect(total).toBe(sources.totalBytes);
    expect(total).toBeLessThan(45_000_000);
  });

  it('are 1K maps, 2K for the hero materials, and every one tiles at a real-world size', () => {
    for (const item of LIBRARY_MATERIALS) {
      if (item.texture === undefined) continue;
      expect(item.texture.size[0], item.id).toBeGreaterThan(0);
      expect(Number.isInteger(item.texture.size[0]) && Number.isInteger(item.texture.size[1]), item.id).toBe(true);
      for (const file of Object.values(item.texture.maps)) {
        const f = LIBRARY_FILES[file]!;
        expect(Math.max(f.width, f.height), file).toBeLessThanOrEqual(2048);
        // Square pixels: the image's aspect is the tile's.
        expect(f.width / f.height, file).toBeCloseTo(item.texture.size[0] / item.texture.size[1], 2);
      }
    }
  });
});

describe('the library\'s items', () => {
  it('cover every category, with unique IDs, colours and Core factors', () => {
    const ids = LIBRARY_MATERIALS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of LIBRARY_CATEGORIES) expect(LIBRARY_MATERIALS.some((i) => i.category === c.id), c.id).toBe(true);
    for (const i of LIBRARY_MATERIALS) {
      expect(i.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
      expect(i.color).toMatch(/^#[0-9a-f]{6}$/);
      for (const k of [i.metallic, i.roughness]) if (k !== undefined) expect(k >= 0 && k <= 1000 && Number.isInteger(k)).toBe(true);
    }
  });

  it('embed one after another into a document that stays valid, sharing a map two of them use', () => {
    let doc: unknown = { floorspec: '0.3', project: { name: 'Library' } };
    for (const item of LIBRARY_MATERIALS) {
      const { id, ops } = embedLibraryMaterial(doc, item.id);
      expect(id).toBe(item.id);
      const r = apply(doc as never, { batch: ops } as never);
      expect(r.status, item.id).toBe('committed');
      if (r.status !== 'committed') return;
      doc = JSON.parse(r.document) as unknown;
    }
    const d = doc as { materials: Record<string, Json>; assets: Record<string, Json> };
    expect(Object.keys(d.materials).length).toBe(LIBRARY_MATERIALS.length);
    // One asset per file: the six paints share their stipple.
    expect(Object.keys(d.assets).length).toBe(Object.keys(LIBRARY_FILES).length);
    const oak = d.materials['white-oak-plank']!;
    expect(oak['source']).toEqual({ library: MATERIAL_LIBRARY.library, version: MATERIAL_LIBRARY.version, item: 'white-oak-plank' });
    expect(oak['texture']).toEqual({ asset: 'white-oak-plank.albedo', normal: 'white-oak-plank.normal', metallicRoughness: 'white-oak-plank.orm', occlusion: 'white-oak-plank.orm', size: [2_176_000, 2_176_000] });
    expect(d.assets['white-oak-plank.albedo']).toMatchObject({ path: `assets/${LIBRARY_FILES['white-oak-plank.albedo.jpg']!.sha256}.jpg`, mediaType: 'image/jpeg' });
    expect(libraryItemOfMaterial(oak)?.id).toBe('white-oak-plank');
    expect(isLibraryGlass(d.materials['glass-clear'])).toBe(true);
    expect(isLibraryGlass(oak)).toBe(false);
    // A second embed of an item is a second material, on the assets already there.
    const again = embedLibraryMaterial(doc, 'white-oak-plank', { rotation: 90_000_000 });
    expect(again.id).toBe('white-oak-plank-2');
    expect(again.ops).toEqual([{ op: 'addElement', collection: 'materials', id: 'white-oak-plank-2', element: expect.objectContaining({ texture: expect.objectContaining({ rotation: 90_000_000 }) }) as unknown }]);
  });

  it('replace a document\'s material in place, keeping a person\'s colour on a colour-agnostic one', () => {
    const doc = { floorspec: '0.3', project: { name: 'Swap' }, materials: { 'paint-sage': { name: 'Paint, sage', color: '#a7b59c', roughness: 900 }, oak: { name: 'Oak', color: '#c9a77c', roughness: 600 } } };
    const pending = new Map<string, string>();
    const ops = [...swapToLibraryMaterial(doc, 'paint-sage', 'paint-eggshell', {}, pending), ...swapToLibraryMaterial(doc, 'oak', 'white-oak-plank', {}, pending)];
    const r = apply(doc as never, { batch: ops } as never);
    expect(r.status).toBe('committed');
    if (r.status !== 'committed') return;
    const d = JSON.parse(r.document) as { materials: Record<string, Json> };
    expect(d.materials['paint-sage']).toMatchObject({ name: 'Paint, sage', color: '#a7b59c', roughness: 720, texture: { normal: 'paint-stipple.normal' } });
    expect(d.materials['oak']).toMatchObject({ name: 'Oak', color: '#b9a283', source: { item: 'white-oak-plank' } });
    expect(d.materials['oak']!['roughness']).toBeUndefined();
  });

  it('dress the roles of a model\'s pieces with items that exist', () => {
    for (const [role, id] of Object.entries(ROLE_LIBRARY)) {
      expect(MODEL_ROLES).toContain(role);
      expect(LIBRARY_MATERIALS.some((i) => i.id === id), id).toBe(true);
    }
  });
});
