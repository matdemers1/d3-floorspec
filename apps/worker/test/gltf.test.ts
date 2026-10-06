import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, facingVector, OFFICIAL_READER } from '@floorspec/engine';
import { validateBytes } from 'gltf-validator';
import { describe, expect, it } from 'vitest';
import { assetDirImages, assetDirModels, buildScene, exportGltf, exportUsdz, linear, readGlb, readStoreZip, type ImageSource } from '../src/export/gltf/index.js';
import { createHandlers } from '../src/queue/handlers.js';
import { rasterize } from '../src/render/png.js';
import { withFurnitureFallbacks } from './support/furniture.js';

/** A small PNG: what a tile photo's bytes would be. */
const tilePng = (fill: string): Uint8Array => rasterize(`<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="${fill}"/></svg>`);

/**
 * FLR-T-9.2: glTF 2.0 (+Y up, metres, materials) that the Khronos validator passes with no errors
 * and no warnings, over every house the worker has and every valid Core 0.3 conformance case; the
 * axis conversion; determinism; materials and texture coordinates exactly as Core 18.3 places them;
 * fallback models placed by 12.6; and USDZ packages that are stored, 64-byte aligned, and — where
 * Apple's usdchecker is installed — pass its ARKit checks.
 */

type Json = Record<string, unknown>;
const M = 1_280_000;
const VERSION = { version: { hash: 'f'.repeat(64) } };
const here = (p: string): string => new URL(p, import.meta.url).pathname;
const load = (p: string): Json => JSON.parse(readFileSync(p, 'utf8')) as Json;

const SUITE = here('../../../packages/engine/standard/conformance/core/0.3');
const HOUSES: Record<string, Json> = {
  'two-storey': load(here('./fixtures/two-storey.json')),
  'l-stair-hip-roof': load(here('../../web/e2e/fixtures/l-stair-hip-roof.json')),
  'three-room-house': load(join(SUITE, 'examples/001-three-room-house/input.json')),
  // Its refrigerators completed with a model and a symbol, as FS_furniture 0.1.0 requires of the
  // editor's reader (FLR-T-12.10): written for a core-only reader, the example is invalid there.
  'kitchen-options': withFurnitureFallbacks(load(join(SUITE, 'examples/002-kitchen-options/input.json'))),
  'from-the-library': load(join(SUITE, 'examples/003-three-room-house-from-the-library/input.json')),
};

/**
 * Every Core 0.3 conformance input whose primary design derives and that is valid as the editor reads
 * it (OFFICIAL_READER, FLR-T-12.10) — the reader every export validates with.
 */
function validCases(): [string, Json][] {
  const out: [string, Json][] = [];
  for (const area of readdirSync(SUITE).sort()) {
    const dir = join(SUITE, area);
    if (!statSync(dir).isDirectory()) continue;
    for (const c of readdirSync(dir).sort()) {
      const input = join(dir, c, 'input.json');
      try {
        statSync(input);
      } catch {
        continue;
      }
      let doc: Json;
      try {
        doc = load(input);
      } catch {
        continue; // a serialization case: not JSON a reader parses as a document
      }
      const ev = evaluate(doc, OFFICIAL_READER);
      if (ev.valid && ev.view !== undefined && Object.keys((ev.view.levels ?? {})).length > 0) out.push([`${area}/${c}`, doc]);
    }
  }
  return out;
}

async function validate(bytes: Uint8Array): Promise<{ errors: number; warnings: number; messages: string[] }> {
  const report = await validateBytes(bytes, { maxIssues: 0, writeTimestamp: false, format: 'glb' });
  return { errors: report.issues.numErrors, warnings: report.issues.numWarnings, messages: report.issues.messages.map((m) => `${m.code} ${m.pointer ?? ''} ${m.message}`) };
}

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

/** An accessor's values (float, unsigned short or unsigned int; no strides). */
function accessor(glb: { json: Json; bin: Uint8Array | null }, i: number): number[] {
  const a = (glb.json['accessors'] as Accessor[])[i]!;
  const v = (glb.json['bufferViews'] as { byteOffset: number; byteLength: number }[])[a.bufferView]!;
  const n = a.count * ({ SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type] ?? 1);
  const at = glb.bin!.byteOffset + v.byteOffset;
  const buf = glb.bin!.buffer.slice(at, at + v.byteLength);
  const arr = a.componentType === 5126 ? new Float32Array(buf, 0, n) : a.componentType === 5123 ? new Uint16Array(buf, 0, n) : new Uint32Array(buf, 0, n);
  return Array.from(arr);
}

interface Node {
  name: string;
  mesh?: number;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  extras?: { floorspec?: Json };
}

const nodesOf = (json: Json): Node[] => json['nodes'] as Node[];

describe('glTF export', () => {
  it('passes the Khronos validator with no errors or warnings, for every house', async () => {
    for (const [name, doc] of Object.entries(HOUSES)) {
      const file = await exportGltf(doc, VERSION);
      expect(file.contentType).toBe('model/gltf-binary');
      const report = await validate(file.bytes);
      expect(report.errors, `${name}: ${report.messages.join('\n')}`).toBe(0);
      expect(report.warnings, `${name}: ${report.messages.join('\n')}`).toBe(0);
    }
  });

  it('passes the validator for every valid Core 0.3 conformance case: roofs, stairs, floors, options, materials', async () => {
    const cases = validCases();
    expect(cases.length).toBeGreaterThan(150);
    const areas = new Set(cases.map(([n]) => n.split('/')[0]));
    for (const a of ['roofs', 'stairs', 'floors', 'options', 'materials']) expect(areas.has(a), a).toBe(true);
    for (const [name, doc] of cases) {
      const file = await exportGltf(doc, VERSION);
      const report = await validate(file.bytes);
      expect(report.errors, `${name}: ${report.messages.join('\n')}`).toBe(0);
      expect(report.warnings, `${name}: ${report.messages.join('\n')}`).toBe(0);
    }
  }, 120_000);

  it('is +Y up and in metres: Floorspec (x, y, z) at (x, z, −y) / 1,280,000', async () => {
    const doc = HOUSES['two-storey']!;
    const glb = readGlb((await exportGltf(doc, VERSION)).bytes);
    const nodes = nodesOf(glb.json);
    const meshes = glb.json['meshes'] as { primitives: { attributes: { POSITION: number } }[] }[];
    const boxOf = (id: string) => {
      const node = nodes.find((n) => n.extras?.floorspec?.['id'] === id)!;
      const acc = meshes[node.mesh!]!.primitives.map((p) => (glb.json['accessors'] as Accessor[])[p.attributes.POSITION]!);
      return { min: [0, 1, 2].map((k) => Math.min(...acc.map((a) => a.min![k]!))), max: [0, 1, 2].map((k) => Math.max(...acc.map((a) => a.max![k]!))) };
    };
    // Every wall's box is its derived outline from its base to its top, turned to +Y up.
    const ev = evaluate(doc);
    const derived = (await import('@floorspec/engine')).deriveEvaluation(ev);
    for (const [id, w] of Object.entries(derived.walls)) {
      const xs = [w.startLeft, w.startRight, w.endLeft, w.endRight].map((p) => p[0] / M);
      const ys = [w.startLeft, w.startRight, w.endLeft, w.endRight].map((p) => p[1] / M);
      const box = boxOf(id);
      expect(box.min[0]).toBeCloseTo(Math.min(...xs), 5);
      expect(box.max[0]).toBeCloseTo(Math.max(...xs), 5);
      expect(box.min[1]).toBeCloseTo(w.baseElevation / M, 5);
      expect(box.max[1]).toBeCloseTo(w.topElevation / M, 5);
      // North (+y) is −Z.
      expect(box.min[2]).toBeCloseTo(-Math.max(...ys), 5);
      expect(box.max[2]).toBeCloseTo(-Math.min(...ys), 5);
    }
    // The upper level stands on the lower: its walls start at its elevation.
    const upper = nodes.find((n) => n.extras?.floorspec?.['kind'] === 'level' && n.extras.floorspec['id'] === 'UPPER')!;
    expect(upper.extras?.floorspec?.['elevation']).toBeCloseTo(3511296 / M, 6);
    expect(glb.json['asset']).toMatchObject({ version: '2.0', extras: { floorspec: { upAxis: 'Y', unit: 'metre', version: 'f'.repeat(64) } } });
  });

  it('writes one node per element under its level, named by its ID and name, with extras.floorspec', async () => {
    const doc = HOUSES['two-storey']!;
    const glb = readGlb((await exportGltf(doc, VERSION)).bytes);
    const nodes = nodesOf(glb.json);
    const scene = (glb.json['scenes'] as { nodes: number[] }[])[0]!;
    const root = nodes[scene.nodes[0]!]!;
    expect(root.name).toBe('Two-storey ranch');
    const levels = root.children!.map((i) => nodes[i]!);
    expect(levels.map((l) => l.name)).toEqual(['MAIN Main floor', 'UPPER Upper floor']);
    const elements = levels.flatMap((l) => l.children!.map((i) => nodes[i]!));
    const ids = elements.map((n) => n.extras?.floorspec?.['id']);
    expect(new Set(ids).size).toBe(ids.length);
    // Every wall, opening and room of the document is a node of its level.
    const walls = (doc['walls'] as Record<string, { level: string }>);
    for (const [id, w] of Object.entries(walls)) {
      const node = elements.find((n) => n.extras?.floorspec?.['id'] === id);
      expect(node?.extras?.floorspec, id).toMatchObject({ id, kind: 'wall', level: w.level });
    }
    for (const id of Object.keys(doc['rooms'] as object)) expect(ids, id).toContain(id);
    for (const id of Object.keys(doc['openings'] as object)) expect(ids, id).toContain(id);
    const bed = elements.find((n) => n.extras?.floorspec?.['id'] === 'BED1')!;
    expect(bed.name).toBe('BED1 Primary bedroom');
    expect(bed.extras?.floorspec).toMatchObject({ kind: 'room', parts: ['floor', 'ceiling'] });
  });

  it('makes PBR materials of the document’s: colour in linear light, metallic and roughness from thousandths', async () => {
    const doc = load(join(SUITE, 'materials/002-metallic-and-roughness-at-their-limits/input.json'));
    const glb = readGlb((await exportGltf(doc, VERSION)).bytes);
    const materials = glb.json['materials'] as { name: string; pbrMetallicRoughness: { baseColorFactor: number[]; metallicFactor: number; roughnessFactor: number }; extras: { floorspec: Json } }[];
    const declared = doc['materials'] as Record<string, { color?: string; metallic?: number; roughness?: number }>;
    let checked = 0;
    for (const m of materials) {
      const id = m.extras.floorspec['id'] as string | undefined;
      if (id === undefined) continue;
      const d = declared[id]!;
      checked++;
      expect(m.pbrMetallicRoughness.metallicFactor, id).toBeCloseTo((d.metallic ?? 0) / 1000, 6);
      expect(m.pbrMetallicRoughness.roughnessFactor, id).toBeCloseTo((d.roughness ?? 1000) / 1000, 6);
      if (d.color !== undefined) linear(d.color).forEach((c, k) => { expect(m.pbrMetallicRoughness.baseColorFactor[k]).toBeCloseTo(c, 6); });
    }
    expect(checked).toBeGreaterThan(0);
    // The two-storey house: its siding and gypsum board, on the exterior and interior faces.
    const house = readGlb((await exportGltf(HOUSES['two-storey']!, VERSION)).bytes);
    const names = (house.json['materials'] as { name: string }[]).map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['SIDING Fibre-cement lap siding', 'GWB Gypsum board', 'STUD SPF framing', 'Default glass']));
  });

  it('is deterministic: the same version gives the same bytes', async () => {
    for (const doc of [HOUSES['l-stair-hip-roof']!, HOUSES['kitchen-options']!]) {
      const a = await exportGltf(doc, VERSION);
      const b = await exportGltf(structuredClone(doc), VERSION);
      expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
      const u = await exportUsdz(doc, VERSION);
      const v = await exportUsdz(structuredClone(doc), VERSION);
      expect(Buffer.from(u.bytes).equals(Buffer.from(v.bytes))).toBe(true);
    }
  });

  it('exports the design asked for, the primary by default, and records which', async () => {
    const doc = HOUSES['kitchen-options']!;
    const primary = await exportGltf(doc, VERSION);
    const sets = doc['optionSets'] as Record<string, { primary: string }>;
    const primaryDesign = Object.fromEntries(Object.entries(sets).map(([set, s]) => [set, s.primary]));
    expect(Object.keys(primaryDesign).length).toBeGreaterThan(1);
    expect(primary.summary['design']).toEqual(primaryDesign);
    expect((readGlb(primary.bytes).json['asset'] as Json)['extras']).toMatchObject({ floorspec: { design: primaryDesign } });
    const [set, { primary: chosen }] = Object.entries(sets)[0]!;
    const other = Object.entries(doc['options'] as Record<string, { set: string }>).find(([id, o]) => o.set === set && id !== chosen)![0];
    const alternative = await exportGltf(doc, { ...VERSION, design: { [set]: other } });
    expect(alternative.summary['design']).toEqual({ ...primaryDesign, [set]: other });
    expect(Buffer.from(alternative.bytes).equals(Buffer.from(primary.bytes))).toBe(false);
    expect((await validate(alternative.bytes)).errors).toBe(0);
  });

  it('lays a texture exactly as Core 18.3 says: a region from its own corner, a floor in plan, turned and offset', async () => {
    // The backsplash: W2's right face runs west to east along y = 3,840,000; its region from 768,000.
    const doc = load(join(SUITE, 'materials/008-tile-photo-on-the-backsplash/input.json'));
    const glb = readGlb((await exportGltf(doc, VERSION)).bytes);
    const nodes = nodesOf(glb.json);
    const meshes = glb.json['meshes'] as { primitives: { attributes: { POSITION: number; TEXCOORD_0?: number }; material: number }[] }[];
    const materials = glb.json['materials'] as { extras: { floorspec: Json } }[];
    const w2 = nodes.find((n) => n.extras?.floorspec?.['id'] === 'W2')!;
    const tiled = meshes[w2.mesh!]!.primitives.filter((p) => materials[p.material]!.extras.floorspec['id'] === 'TILE');
    expect(tiled).toHaveLength(1);
    const pos = accessor(glb, tiled[0]!.attributes.POSITION);
    const uv = accessor(glb, tiled[0]!.attributes.TEXCOORD_0!);
    const size = 390144;
    let n = 0;
    for (let i = 0; i < pos.length / 3; i++) {
      const x = pos[3 * i]! * M;
      const z = pos[3 * i + 1]! * M;
      // The region's own origin (from, bottom) on a right face: s = (P − S)·e − from, t = z − b − bottom.
      expect(x).toBeGreaterThanOrEqual(768000 - 1);
      expect(x).toBeLessThanOrEqual(4352000 + 1);
      expect(uv[2 * i]!).toBeCloseTo((x - 768000) / size, 4);
      expect(uv[2 * i + 1]!).toBeCloseTo(-(z - 1170432) / size, 4);
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(4);
    // Every TILE vertex is in the region, and the paint keeps the rest of the face.
    const painted = meshes[w2.mesh!]!.primitives.find((p) => materials[p.material]!.extras.floorspec['id'] === 'PAINT');
    expect(painted).toBeDefined();

    // Oak floor boards turned 90° and offset (materials/001): u = s′ / w, v = −t′ / h.
    const oak = load(join(SUITE, 'materials/001-pbr-material-with-every-map/input.json'));
    const g2 = readGlb((await exportGltf(oak, VERSION)).bytes);
    const room = nodesOf(g2.json).find((nd) => nd.extras?.floorspec?.['id'] === 'R1')!;
    const floor = (g2.json['meshes'] as typeof meshes)[room.mesh!]!.primitives[0]!;
    const fp = accessor(g2, floor.attributes.POSITION);
    const fuv = accessor(g2, floor.attributes.TEXCOORD_0!);
    const tex = (oak['materials'] as Record<string, { texture: { size: number[]; offset: number[]; rotation: number } }>)['OAK']!.texture;
    const [fx, fy] = facingVector(tex.rotation).map(Number) as [number, number];
    const len = Math.hypot(fx, fy);
    for (let i = 0; i < fp.length / 3; i++) {
      const s = fp[3 * i]! * M;
      const t = -fp[3 * i + 2]! * M;
      const ds = s - tex.offset[0]!;
      const dt = t - tex.offset[1]!;
      expect(fuv[2 * i]!).toBeCloseTo((ds * fx + dt * fy) / len / tex.size[0]!, 3);
      expect(fuv[2 * i + 1]!).toBeCloseTo(-((dt * fx - ds * fy) / len) / tex.size[1]!, 3);
    }
  });

  it('embeds the maps whose bytes it is given, PNG or JPEG, and says which it left out', async () => {
    const doc = load(join(SUITE, 'materials/008-tile-photo-on-the-backsplash/input.json'));
    const png = tilePng('#c8beb4');
    const images: ImageSource = (a) => (a.id === 'TILE-PHOTO' ? png : undefined);
    const withMaps = await exportGltf(doc, { ...VERSION, images });
    expect(withMaps.summary['textures']).toEqual({ embedded: ['TILE-PHOTO'], omitted: [] });
    const glb = readGlb(withMaps.bytes);
    expect(glb.json['images']).toEqual([{ name: 'TILE-PHOTO', bufferView: expect.any(Number) as number, mimeType: 'image/png' }]);
    const tile = (glb.json['materials'] as { extras: { floorspec: Json }; pbrMetallicRoughness: Json }[]).find((m) => m.extras.floorspec['id'] === 'TILE')!;
    // 18.1: with a base colour map the texel is the colour.
    expect(tile.pbrMetallicRoughness).toMatchObject({ baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: 0 }, roughnessFactor: 0.30000001192092896 });
    const report = await validate(withMaps.bytes);
    expect(report.errors, report.messages.join('\n')).toBe(0);
    expect(report.warnings, report.messages.join('\n')).toBe(0);
    // Without the bytes: the colour, and the reason.
    const without = await exportGltf(doc, VERSION);
    expect(without.summary['textures']).toEqual({ embedded: [], omitted: [{ asset: 'TILE-PHOTO', reason: 'its bytes were not available to the exporter' }] });
    // WebP and KTX2 need extensions this export does not write; a PNG normal map goes in.
    const oak = await exportGltf(load(join(SUITE, 'materials/001-pbr-material-with-every-map/input.json')), { ...VERSION, images: (a) => (a.mediaType === 'image/png' ? png : undefined) });
    const textures = oak.summary['textures'] as { embedded: string[]; omitted: { asset: string; reason: string }[] };
    expect(textures.embedded).toEqual(['OAK-NORMAL']);
    expect(textures.omitted).toEqual([
      { asset: 'OAK-COLOR', reason: 'its bytes were not available to the exporter' },
      { asset: 'OAK-MR', reason: 'image/webp needs a glTF extension this export does not write' },
      { asset: 'OAK-AO', reason: 'image/ktx2 needs a glTF extension this export does not write' },
    ]);
    const oakReport = await validate(oak.bytes);
    expect(oakReport.errors, oakReport.messages.join('\n')).toBe(0);
    expect(oakReport.warnings, oakReport.messages.join('\n')).toBe(0);
  });

  it('places an extension element’s fallback model by Core 12.6: its frame’s origin, turned by its facing alone', async () => {
    // Each refrigerator with the library's model (FRIDGE) and symbol, as the editor's reader requires.
    const doc = withFurnitureFallbacks(load(join(SUITE, 'options/034-fridge-in-each-option/input.json')));
    expect(evaluate(doc, OFFICIAL_READER).valid).toBe(true);
    const bytes = (await exportGltf(doc, VERSION)).bytes;
    const glb = readGlb(bytes);
    const model = nodesOf(glb.json).find((n) => n.extras?.floorspec?.['model'] === 'FRIDGE')!;
    // FA stands at (9,216,000, 3,200,000) facing +y (90°): glTF (7.2, 0, −2.5), its +X turned to −Z.
    expect(model.translation![0]).toBeCloseTo(9216000 / M, 6);
    expect(model.translation![1]).toBeCloseTo(0, 6);
    expect(model.translation![2]).toBeCloseTo(-3200000 / M, 6);
    const [, qy, , qw] = model.rotation!;
    const front = [1 - 2 * qy! * qy!, 0, -2 * qy! * qw!];
    expect(front[0]).toBeCloseTo(0, 6);
    expect(front[2]).toBeCloseTo(-1, 6);
    const fridge = nodesOf(glb.json).find((n) => n.extras?.floorspec?.['id'] === 'FA' && n.mesh !== undefined)!;
    expect(fridge.extras?.floorspec).toMatchObject({ kind: 'extension', extension: 'FS_furniture', collection: 'pieces' });
    expect((await validate(bytes)).errors).toBe(0);
  });
});

describe('maps from the asset store (FLR-T-9.2 with FLR-T-8.2)', () => {
  /** An asset directory as the api writes it: `ab/cd/<sha256>`. */
  const store = (files: Uint8Array[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'assets-'));
    for (const bytes of files) {
      const sha = createHash('sha256').update(bytes).digest('hex');
      mkdirSync(join(dir, sha.slice(0, 2), sha.slice(2, 4)), { recursive: true });
      writeFileSync(join(dir, sha.slice(0, 2), sha.slice(2, 4), sha), bytes);
    }
    return dir;
  };
  const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
  /** The backsplash case with its tile photo pointing at `bytes`. */
  const backsplash = (bytes: Uint8Array, mediaType = 'image/png'): Json => {
    const doc = load(join(SUITE, 'materials/008-tile-photo-on-the-backsplash/input.json'));
    doc['assets'] = { 'TILE-PHOTO': { path: 'assets/tile.png', sha256: sha(bytes), mediaType, byteLength: bytes.byteLength } };
    expect(evaluate(doc).valid).toBe(true);
    return doc;
  };

  it('embeds a PNG read by its SHA-256, and the file passes the validator with no errors', async () => {
    const png = tilePng('#b0a89a');
    const dir = store([png]);
    const file = await exportGltf(backsplash(png), { ...VERSION, images: assetDirImages(dir)! });
    expect(file.summary['textures']).toEqual({ embedded: ['TILE-PHOTO'], omitted: [] });
    const glb = readGlb(file.bytes);
    expect((glb.json['images'] as Json[]).map((i) => i['mimeType'])).toEqual(['image/png']);
    const report = await validate(file.bytes);
    expect(report.errors, report.messages.join('\n')).toBe(0);
    expect(report.warnings, report.messages.join('\n')).toBe(0);
  });

  it('leaves out a map that is missing, changed on disk, or not what the document says it is', async () => {
    const png = tilePng('#b0a89a');
    const dir = store([png]);
    const images = assetDirImages(dir)!;
    // Missing: nothing under that digest.
    const other = tilePng('#123456');
    expect(images({ id: 'X', sha256: sha(other), mediaType: 'image/png' })).toBeUndefined();
    // Changed: the file under the digest is not those bytes.
    mkdirSync(join(dir, sha(other).slice(0, 2), sha(other).slice(2, 4)), { recursive: true });
    writeFileSync(join(dir, sha(other).slice(0, 2), sha(other).slice(2, 4), sha(other)), png);
    expect(images({ id: 'X', sha256: sha(other), mediaType: 'image/png' })).toBeUndefined();
    // Mislabelled: PNG bytes the document calls a JPEG.
    expect(images({ id: 'X', sha256: sha(png), mediaType: 'image/jpeg' })).toBeUndefined();
    // Not a digest: never a path.
    expect(images({ id: 'X', sha256: '../../etc/passwd', mediaType: 'image/png' })).toBeUndefined();
    expect(images({ id: 'X', sha256: sha(png), mediaType: 'image/png' })).toEqual(png);
    const file = await exportGltf(backsplash(png, 'image/jpeg'), { ...VERSION, images });
    expect(file.summary['textures']).toEqual({ embedded: [], omitted: [{ asset: 'TILE-PHOTO', reason: 'its bytes were not available to the exporter' }] });
    expect(assetDirImages(undefined)).toBeUndefined();
    expect(assetDirImages('')).toBeUndefined();
  });

  it('is what the worker’s glTF and USDZ jobs read, given the asset directory', async () => {
    const png = tilePng('#b0a89a');
    const table = createHandlers({ assetDir: store([png]) });
    const job = { id: 'j', projectId: 'p', versionHash: 'e'.repeat(64), params: { versionAt: '2026-10-05T00:00:00Z' } };
    const glb = await table['export.gltf']!(backsplash(png), { ...job, kind: 'export.gltf' });
    expect(glb.summary?.['textures']).toEqual({ embedded: ['TILE-PHOTO'], omitted: [] });
    const usdz = await table['export.usdz']!(backsplash(png), { ...job, kind: 'export.usdz' });
    expect(readStoreZip(usdz.bytes).map((e) => e.name)).toEqual(['model.usda', 'textures/TILE-PHOTO.png']);
    // The drain fills in what the job's project uploaded: a digest it has not claimed is not read.
    const unclaimed = await table['export.gltf']!(backsplash(png), { ...job, kind: 'export.gltf', claimed: new Set(['0'.repeat(64)]) });
    expect((unclaimed.summary?.['textures'] as { embedded: unknown[] }).embedded).toEqual([]);
    // Without a directory, the job says what it left out.
    const bare = await createHandlers()['export.gltf']!(backsplash(png), { ...job, kind: 'export.gltf' });
    expect((bare.summary?.['textures'] as { omitted: unknown[] }).omitted).toHaveLength(1);
  });
});

describe('fallback models merged into the glTF (FLR-T-9.2, Core 12.6)', () => {
  const FRIDGE_GLB = new Uint8Array(readFileSync(here('../../../packages/engine/standard/registry/FS_furniture/library/models/refrigerator-900.glb')));
  const digest = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
  /** An asset directory as the api writes it: `ab/cd/<sha256>`. */
  const store = (files: Uint8Array[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'models-'));
    for (const bytes of files) {
      const sha = digest(bytes);
      mkdirSync(join(dir, sha.slice(0, 2), sha.slice(2, 4)), { recursive: true });
      writeFileSync(join(dir, sha.slice(0, 2), sha.slice(2, 4), sha), bytes);
    }
    return dir;
  };
  /**
   * The fridge-in-each-option case with the starter library's refrigerator as its model: FA (option
   * A, the primary) and a second, common refrigerator FC on the far wall — two elements of the
   * shown design sharing one model.
   */
  const kitchen = (bytes: Uint8Array = FRIDGE_GLB, mediaType = 'model/gltf-binary'): Json => {
    const doc = load(join(SUITE, 'options/034-fridge-in-each-option/input.json'));
    const pieces = ((doc['extensions'] as Json)['FS_furniture'] as { collections: { pieces: Record<string, Json> } }).collections.pieces;
    (pieces['FA']!['fallback'] as Json)['asset'] = 'FRIDGE';
    const fc = structuredClone(pieces['FA']!);
    delete fc['option'];
    fc['host'] = { mode: 'free', level: 'L1', position: [2_000_000, 2_000_000], rotation: 0 };
    pieces['FC'] = fc;
    doc['assets'] = { FRIDGE: { path: 'assets/refrigerator-900.glb', sha256: digest(bytes), mediaType, byteLength: bytes.byteLength } };
    // FB and the plan symbols, as the editor's reader requires (FLR-T-12.10).
    const complete = withFurnitureFallbacks(doc);
    expect(evaluate(complete, OFFICIAL_READER).valid).toBe(true);
    return complete;
  };
  const glbOf = (json: Json, bin: Uint8Array): Uint8Array => {
    const text = new TextEncoder().encode(JSON.stringify(json));
    const jl = text.byteLength + ((4 - (text.byteLength % 4)) % 4);
    const out = new Uint8Array(12 + 8 + jl + 8 + bin.byteLength);
    const v = new DataView(out.buffer);
    v.setUint32(0, 0x46546c67, true);
    v.setUint32(4, 2, true);
    v.setUint32(8, out.byteLength, true);
    v.setUint32(12, jl, true);
    v.setUint32(16, 0x4e4f534a, true);
    out.set(text, 20);
    out.fill(0x20, 20 + text.byteLength, 20 + jl);
    v.setUint32(20 + jl, bin.byteLength, true);
    v.setUint32(24 + jl, 0x004e4942, true);
    out.set(bin, 28 + jl);
    return out;
  };

  it('draws the library refrigerator at each placement, its mesh and material once, and the validator passes with no errors or warnings', async () => {
    const file = await exportGltf(kitchen(), { ...VERSION, models: assetDirModels(store([FRIDGE_GLB]))! });
    expect(file.summary['models']).toEqual({ merged: ['FRIDGE'], omitted: [] });
    const glb = readGlb(file.bytes);
    const library = readGlb(FRIDGE_GLB);
    const meshes = glb.json['meshes'] as { name: string; primitives: { attributes: Record<string, number>; material: number }[] }[];
    const fridgeMeshes = meshes.flatMap((m, i) => (m.name === 'refrigerator-900' ? [i] : []));
    expect(fridgeMeshes).toHaveLength(1);
    expect((glb.json['materials'] as { name: string }[]).filter((m) => m.name === 'appliances')).toHaveLength(1);
    // The copied positions are the library's own: same bounds, metres, +Y up.
    const position = (glb.json['accessors'] as Accessor[])[meshes[fridgeMeshes[0]!]!.primitives[0]!.attributes['POSITION']!]!;
    const original = (library.json['accessors'] as Accessor[])[0]!;
    expect([position.min, position.max, position.count]).toEqual([original.min, original.max, original.count]);
    expect(accessor(glb, meshes[fridgeMeshes[0]!]!.primitives[0]!.attributes['POSITION']!)).toEqual(accessor(library, 0));
    // One node per element under its marker, both drawing the one mesh.
    const nodes = nodesOf(glb.json);
    const markers = nodes.filter((n) => n.extras?.floorspec?.['model'] === 'FRIDGE');
    expect(markers.map((n) => n.extras?.floorspec?.['id']).sort()).toEqual(['FA', 'FC']);
    for (const m of markers) {
      expect(m.children).toHaveLength(1);
      const child = nodes[m.children![0]!]!;
      expect(child.mesh).toBe(fridgeMeshes[0]);
      expect(child.name).toBe(`${String(m.extras?.floorspec?.['id'])} refrigerator-900`);
      expect(child.translation).toBeUndefined();
    }
    const report = await validate(file.bytes);
    expect(report.errors, report.messages.join('\n')).toBe(0);
    expect(report.warnings, report.messages.join('\n')).toBe(0);
    // The same scene writes the same bytes.
    expect((await exportGltf(kitchen(), { ...VERSION, models: assetDirModels(store([FRIDGE_GLB]))! })).bytes).toEqual(file.bytes);
  });

  it('keeps the marker and says why when a model cannot be merged', async () => {
    const without = await exportGltf(kitchen(), VERSION);
    expect(without.summary['models']).toEqual({ merged: [], omitted: [{ asset: 'FRIDGE', reason: 'its bytes were not available to the exporter' }] });
    expect(nodesOf(readGlb(without.bytes).json).filter((n) => n.extras?.floorspec?.['model'] === 'FRIDGE').every((n) => n.children === undefined)).toBe(true);
    const cases: [Uint8Array, string][] = [
      [new TextEncoder().encode('not a model'), 'it is not a glTF 2.0 binary'],
      [glbOf({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'], extensionsUsed: ['KHR_draco_mesh_compression'], scene: 0, scenes: [{ nodes: [0] }], nodes: [{}] }, new Uint8Array(4)), 'it requires KHR_draco_mesh_compression, which this export does not carry'],
      [glbOf({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 3 }] }, new Uint8Array(4)), 'mesh 3 is not in the model'],
      [glbOf({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{}], buffers: [{ byteLength: 4, uri: 'https://example.test/b.bin' }] }, new Uint8Array(4)), 'its data is outside the binary'],
    ];
    for (const [bytes, reason] of cases) {
      const file = await exportGltf(kitchen(bytes), { ...VERSION, models: () => bytes });
      expect(file.summary['models'], reason).toEqual({ merged: [], omitted: [{ asset: 'FRIDGE', reason }] });
      const report = await validate(file.bytes);
      expect(report.errors, report.messages.join('\n')).toBe(0);
    }
    // A glTF that is JSON, not a binary, is not merged.
    const gltfJson = await exportGltf(kitchen(FRIDGE_GLB, 'model/gltf+json'), { ...VERSION, models: () => FRIDGE_GLB });
    expect((gltfJson.summary['models'] as { omitted: { reason: string }[] }).omitted[0]!.reason).toBe('model/gltf+json is not a glTF binary this export merges');
  });

  it('reads a model from the asset store by its digest, only as a glTF binary, and only one the job’s project claimed', async () => {
    const dir = store([FRIDGE_GLB, tilePng('#fff')]);
    const models = assetDirModels(dir)!;
    expect(models({ id: 'F', sha256: digest(FRIDGE_GLB), mediaType: 'model/gltf-binary' })).toEqual(FRIDGE_GLB);
    expect(models({ id: 'F', sha256: digest(FRIDGE_GLB), mediaType: 'image/png' })).toBeUndefined();
    expect(models({ id: 'F', sha256: digest(tilePng('#fff')), mediaType: 'model/gltf-binary' })).toBeUndefined();
    expect(models({ id: 'F', sha256: '../../etc/passwd', mediaType: 'model/gltf-binary' })).toBeUndefined();
    expect(assetDirModels(undefined)).toBeUndefined();
    const table = createHandlers({ assetDir: dir });
    const job = { id: 'j', projectId: 'p', versionHash: 'e'.repeat(64), kind: 'export.gltf', params: { versionAt: '2026-10-05T00:00:00Z' } };
    const claimed = await table['export.gltf']!(kitchen(), { ...job, claimed: new Set([digest(FRIDGE_GLB)]) });
    expect(claimed.summary?.['models']).toEqual({ merged: ['FRIDGE'], omitted: [] });
    const unclaimed = await table['export.gltf']!(kitchen(), { ...job, claimed: new Set(['0'.repeat(64)]) });
    expect(unclaimed.summary?.['models']).toEqual({ merged: [], omitted: [{ asset: 'FRIDGE', reason: 'its bytes were not available to the exporter' }] });
  });

  it('marks the model in USDZ, at its placement, and says it was not converted', async () => {
    const file = await exportUsdz(kitchen(), { ...VERSION, models: assetDirModels(store([FRIDGE_GLB]))! });
    expect(file.summary['models']).toEqual({ merged: [], omitted: [{ asset: 'FRIDGE', reason: 'USDZ marks where the model goes; this export does not convert glTF to USD' }] });
    const usda = new TextDecoder().decode(readStoreZip(file.bytes)[0]!.bytes);
    expect(usda.match(/string floorspecModel = "FRIDGE"/g)).toHaveLength(2);
    expect(usda).toContain('uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient"]');
    // Where Apple's usdchecker is installed, the marked file still passes its ARKit rules.
    if (spawnSync('usdchecker', ['--help'], { encoding: 'utf8' }).status === 0) {
      const path = join(mkdtempSync(join(tmpdir(), 'usdz-')), 'kitchen.usdz');
      writeFileSync(path, file.bytes);
      expect(execFileSync('usdchecker', ['--arkit', '--strict', path], { encoding: 'utf8' })).toContain('Success!');
    }
  }, 60_000);
});

describe('USDZ export', () => {
  it('is a stored ZIP, every file 64-byte aligned, the root layer first: metres, +Y up, preview surfaces', async () => {
    const doc = HOUSES['l-stair-hip-roof']!;
    const file = await exportUsdz(doc, VERSION);
    expect(file.contentType).toBe('model/vnd.usdz+zip');
    expect(file.name).toMatch(/\.usdz$/);
    const entries = readStoreZip(file.bytes);
    expect(entries[0]!.name).toBe('model.usda');
    for (const e of entries) {
      expect(e.method, e.name).toBe(0);
      expect(e.offset % 64, e.name).toBe(0);
    }
    const usda = new TextDecoder().decode(entries[0]!.bytes);
    expect(usda.startsWith('#usda 1.0\n')).toBe(true);
    expect(usda).toContain('metersPerUnit = 1');
    expect(usda).toContain('upAxis = "Y"');
    expect(usda).toContain('defaultPrim = "Model"');
    expect(usda).toContain('uniform token info:id = "UsdPreviewSurface"');
    // A mesh per glTF primitive, an Xform per element, the Floorspec IDs kept.
    const scene = await buildScene(doc);
    const primitives = scene.levels.reduce((n, l) => n + l.nodes.reduce((m, node) => m + node.primitives.length, 0), 0);
    expect(usda.match(/def Mesh /g)).toHaveLength(primitives);
    expect(usda).toContain('string floorspecId = "KIT"');
    // Standing on the floor: the root lifts the lowest point to y = 0.
    expect(usda).toMatch(/double3 xformOp:translate = \(-?[\d.]+, -?[\d.]+, -?[\d.]+\)/);
  });

  it('packs PNG maps as aligned files and reads them through UsdUVTexture', async () => {
    const doc = load(join(SUITE, 'materials/008-tile-photo-on-the-backsplash/input.json'));
    const png = tilePng('#c8c8c8');
    const file = await exportUsdz(doc, { ...VERSION, images: () => png });
    const entries = readStoreZip(file.bytes);
    expect(entries.map((e) => e.name)).toEqual(['model.usda', 'textures/TILE-PHOTO.png']);
    for (const e of entries) expect(e.offset % 64).toBe(0);
    expect(Buffer.from(entries[1]!.bytes).equals(Buffer.from(png))).toBe(true);
    const usda = new TextDecoder().decode(entries[0]!.bytes);
    expect(usda).toContain('asset inputs:file = @textures/TILE-PHOTO.png@');
    expect(usda).toContain('texCoord2f[] primvars:st');
  });

  // Apple's usdchecker (macOS) is the closest thing to AR Quick Look a test can run: its --arkit
  // rules are RealityKit's. Where it is not installed, this says so and checks nothing.
  const usdchecker = spawnSync('usdchecker', ['--help'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!usdchecker)('passes usdchecker --arkit for every house, with and without textures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usdz-'));
    const png = tilePng('#c8c8c8');
    const docs: [string, Json, ImageSource | undefined][] = [
      ...Object.entries(HOUSES).map(([n, d]) => [n, d, undefined] as [string, Json, undefined]),
      ['backsplash', load(join(SUITE, 'materials/008-tile-photo-on-the-backsplash/input.json')), () => png],
    ];
    for (const [name, doc, images] of docs) {
      const file = await exportUsdz(doc, { ...VERSION, ...(images === undefined ? {} : { images }) });
      const path = join(dir, `${name}.usdz`);
      writeFileSync(path, file.bytes);
      const out = execFileSync('usdchecker', ['--arkit', '--strict', path], { encoding: 'utf8' });
      expect(out, name).toContain('Success!');
    }
  }, 120_000);
});
