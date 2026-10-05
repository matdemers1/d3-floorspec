/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMesher, type HouseMesh } from '@floorspec/mesh';
import { labelOf, readModel, type EditorModel } from '../src/editor/model';
import { formatLen } from '../src/editor/units';
import {
  applyOps,
  averageColour,
  defaultTarget,
  existingAssetId,
  imageSize,
  nameFromFile,
  scaleText,
  sizeText,
  spanPixels,
  targetChoices,
  textureBatch,
  wholeWidth,
  type UploadedAsset,
} from '../src/materials/calibrate';
import { mapOf, surfaceBuffers } from '../src/editor/three/surfaces';
import { linear } from '../src/editor/three/parts';

/**
 * FLR-T-8.2 without a browser: the calibration dialog's arithmetic, the one Ops batch it applies,
 * and the 3D view's textured surfaces — on the conformance suite's backsplash (Core 0.3, 18.5): a
 * kitchen painted all round, with a 12-inch tile photo on a region of W2's right face.
 */

const IN = 32_512;
const BACKSPLASH = readFileSync(new URL('../../../packages/engine/standard/conformance/core/0.3/materials/008-tile-photo-on-the-backsplash/input.json', import.meta.url), 'utf8');

const UPLOAD: UploadedAsset = {
  sha256: 'c'.repeat(64),
  mediaType: 'image/jpeg',
  byteLength: 52_311,
  width: 2048,
  height: 1024,
  name: 'zellige-seafoam.jpg',
  path: `assets/${'c'.repeat(64)}.jpg`,
  href: `/api/projects/p/assets/${'c'.repeat(64)}`,
};

let model: EditorModel;
let mesh: HouseMesh;

beforeAll(async () => {
  model = readModel('fixture', BACKSPLASH);
  expect(model.valid).toBe(true);
  mesh = (await loadMesher()).meshDerived(model.view, model.derived!, { origin: [2_560_000, 1_920_000, 0] });
});

describe('calibration', () => {
  it('sizes the whole image from a span and its real length, keeping the aspect', () => {
    // A 2048 × 1024 photo whose whole width is 24": 24 × 12 in.
    const span = wholeWidth(2048, 1024);
    expect(spanPixels(span)).toBe(2048);
    expect(imageSize(2048, 1024, spanPixels(span), 24 * IN)).toEqual([24 * IN, 12 * IN]);
    // One tile, 512 px across a diagonal-free drag, is 4": the image is 16 × 8 in.
    expect(imageSize(2048, 1024, spanPixels({ a: [100, 300], b: [612, 300] }), 4 * IN)).toEqual([16 * IN, 8 * IN]);
    // Rounded once to whole base units, never below one.
    expect(imageSize(3, 1, 3, 10)).toEqual([10, 3]);
    expect(imageSize(1, 1, 1000, 1)).toEqual([1, 1]);
    expect(imageSize(10, 10, 0, 12 * IN)).toBeNull();
    expect(imageSize(10, 10, 10, 0)).toBeNull();
  });

  it('says the scale and the size as a person reads them', () => {
    expect(scaleText([4 * IN, 4 * IN], 2048 / 12, 'imperial')).toBe('1 px = 0.023 in');
    expect(scaleText([300 * 1280, 300 * 1280], 500, 'metric')).toBe('1 px = 0.60 mm');
    expect(sizeText([12 * IN, 24 * IN], 'imperial')).toMatch(/1'.*× 2'/);
    expect(nameFromFile('zellige_seafoam-4in.JPG')).toBe('zellige seafoam 4in');
    expect(nameFromFile(null)).toBe('Texture');
  });

  it('averages a photo to the colour shown where its map is not drawn', () => {
    expect(averageColour(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 0]))).toBe('#800080');
    expect(averageColour(new Uint8ClampedArray([0, 0, 0, 0]))).toBeNull();
  });
});

describe('where a texture goes', () => {
  it('offers the backsplash region by the room it faces, every room’s surfaces, and nothing yet', () => {
    const choices = targetChoices(model, null, 'imperial');
    expect(choices[0]!.target).toEqual({ kind: 'none' });
    const region = choices.find((c) => c.target.kind === 'region')!;
    expect(region.target).toEqual({ kind: 'region', wall: 'W2', side: 'right', index: 0 });
    expect(region.label).toBe(`Kitchen · region on ${labelOf(model, 'W2')} (${formatLen(1_755_648 - 1_170_432, 'imperial')} high)`);
    expect(choices.filter((c) => c.target.kind === 'room').map((c) => c.label)).toEqual(['Kitchen · floor', 'Kitchen · walls', 'Kitchen · ceiling']);
    expect(defaultTarget(choices, null)).toBe('none');
    // With the wall selected, its region is where the dialog opens, and its faces are offered.
    const onWall = targetChoices(model, 'W2', 'imperial');
    expect(defaultTarget(onWall, 'W2')).toBe('region:W2:right:0');
    expect(onWall.filter((c) => c.target.kind === 'face').map((c) => c.value)).toEqual(['face:W2:left', 'face:W2:right']);
    expect(defaultTarget(targetChoices(model, 'R1', 'imperial'), 'R1')).toBe('room:R1:floorFinish');
  });

  it('builds one batch: the asset, the material at its calibrated size, and the region’s finish', () => {
    const batch = textureBatch(model, { asset: UPLOAD, name: 'Zellige', color: '#5ea6a0', size: [4 * IN, 2 * IN], roughness: 300, target: { kind: 'region', wall: 'W2', side: 'right', index: 0 } })(0);
    expect(batch).toEqual([
      { op: 'addElement', collection: 'assets', id: 'IMG1', element: { path: UPLOAD.path, sha256: UPLOAD.sha256, mediaType: 'image/jpeg', byteLength: 52_311, name: 'zellige-seafoam.jpg' } },
      { op: 'addElement', collection: 'materials', id: 'M1', element: { name: 'Zellige', color: '#5ea6a0', roughness: 300, texture: { asset: 'IMG1', size: [4 * IN, 2 * IN] } } },
      { op: 'setProperty', id: 'W2', path: '/finishes', value: { right: { regions: [{ from: 768000, to: 4352000, bottom: 1170432, top: 1755648, material: 'M1' }] } } },
    ]);
    // A retry after an ID is refused takes the next ones.
    const retry = textureBatch(model, { asset: UPLOAD, name: 'Zellige', size: [IN, IN], target: { kind: 'none' } })(1);
    expect(retry.map((o) => (o as { id: string }).id)).toEqual(['IMG2', 'M2']);
  });

  it('reuses the document’s asset for a file it already has, and re-sizes an existing material', () => {
    const tile = (model.document.assets as Record<string, { sha256: string; path: string }>)['TILE-PHOTO']!;
    expect(existingAssetId(model.document, tile.sha256)).toBe('TILE-PHOTO');
    const same = { ...UPLOAD, sha256: tile.sha256, path: tile.path };
    const batch = textureBatch(model, { asset: same, material: 'TILE', name: 'Tile', size: [12 * IN, 12 * IN], target: { kind: 'room', room: 'R1', surface: 'floorFinish' } })(0);
    expect(batch).toEqual([
      { op: 'setProperty', id: 'TILE', path: '/texture/size', value: [12 * IN, 12 * IN] },
      { op: 'setProperty', id: 'R1', path: '/floorFinish', value: 'TILE' },
    ]);
  });

  it('puts a material on a whole face, keeping its regions', () => {
    expect(applyOps(model.document, { kind: 'face', wall: 'W2', side: 'right' }, 'PAINT')).toEqual([
      { op: 'setProperty', id: 'W2', path: '/finishes', value: { right: { material: 'PAINT', regions: [{ from: 768000, to: 4352000, bottom: 1170432, top: 1755648, material: 'TILE' }] } } },
    ]);
    expect(applyOps(model.document, { kind: 'none' }, 'PAINT')).toEqual([]);
  });
});

describe('textured surfaces in 3D (Core 18.3)', () => {
  it('finds a material’s base colour map, and none for a file the editor would have to fetch from the web', () => {
    expect(mapOf(model, 'TILE')).toMatchObject({ ref: { material: 'TILE', color: '#d8d4cc' }, size: [390_144, 390_144] });
    expect(mapOf(model, 'PAINT')).toBeNull();
    expect(mapOf(model, null)).toBeNull();
  });

  it('draws the backsplash with its map in world units, from the region’s lower-left corner, and the rest of the face painted', () => {
    const wall = mesh.parts.find((p) => p.key === 'wall:W2')!;
    const b = surfaceBuffers(model, mesh, wall);
    expect(b.groups.map((g) => g.map?.material ?? null)).toEqual([null, 'TILE']);
    const tiled = b.groups[1]!;
    let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let i = tiled.start; i < tiled.start + tiled.count; i++) {
      u0 = Math.min(u0, b.uvs[2 * i]!);
      u1 = Math.max(u1, b.uvs[2 * i]!);
      v0 = Math.min(v0, b.uvs[2 * i + 1]!);
      v1 = Math.max(v1, b.uvs[2 * i + 1]!);
      // Under a map the vertex colour is white: the map is the colour.
      expect([b.colors[3 * i], b.colors[3 * i + 1], b.colors[3 * i + 2]]).toEqual([1, 1, 1]);
    }
    // 3,584,000 units along by 585,216 up at 390,144 a tile: 9.186 tiles by 1.5, from (0, 0).
    expect(u0).toBeCloseTo(0, 4);
    expect(v0).toBeCloseTo(0, 4);
    expect(u1).toBeCloseTo((4_352_000 - 768_000) / 390_144, 4);
    expect(v1).toBeCloseTo((1_755_648 - 1_170_432) / 390_144, 4);
    // The face around it is the kitchen's paint (from the room, Core 18.6).
    const paint = linear('#e9e6df');
    const painted = [...Array(b.groups[0]!.count).keys()].filter((k) => b.colors[3 * k]!.toFixed(6) === paint[0].toFixed(6));
    expect(painted.length).toBeGreaterThan(0);
  });

  it('keeps every triangle of the part', () => {
    for (const part of mesh.parts.filter((p) => p.kind === 'wall' || p.kind === 'floor' || p.kind === 'ceiling')) {
      const b = surfaceBuffers(model, mesh, part);
      expect(b.groups.reduce((n, g) => n + g.count, 0)).toBe(b.positions.length / 3);
      expect(b.groups.every((g) => g.count % 3 === 0)).toBe(true);
    }
  });
});
