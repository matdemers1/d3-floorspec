/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { OFFICIAL_READER, type FloorspecDocument } from '@floorspec/engine';
import { readModel, type EditorModel } from '../src/editor/model';
import type { Batch } from '../src/editor/ops';
import { boxFromBounds, faceXFromZ, gltfBounds, gltfJson, modelBox, outlineSymbol } from '../src/furniture/gltf';
import { categoryLabel, defaultEnvelopes, LIBRARY, libraryItem, matches, mountingOf, type LibraryItem } from '../src/furniture/library';
import { declarationOps, moveFurniture, normalAngle, placeFurniture, turnFurniture, type StoredFile } from '../src/furniture/ops';
import { footprintAt, overlaps, spotIn } from '../src/furniture/placement';
import { symbolMatrix } from '../src/furniture/Plan';
import { lintsOf, lintText } from '../src/furniture/view';
import { nudgeBatch } from '../src/editor/nudge';
import { sizeText } from '../src/furniture/Preview';
import { furnitureModels } from '../src/furniture/Furniture3D';

/**
 * FS_furniture in the editor (FLR-T-8.3): a model's box from its glTF bounds by Core 12.6's mapping,
 * the library, where "Place in" puts an item, and the batch that places it — run through the real
 * applier as the server runs it, implementing and knowing FS_furniture.
 */

const LIB = new URL('../../../packages/engine/standard/registry/FS_furniture/library/', import.meta.url);
const libFile = (path: string) => new Uint8Array(readFileSync(new URL(path, LIB)));
const HOUSE = readFileSync(new URL('../src/projects/templates/three-room-house.floorspec.json', import.meta.url), 'utf8');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function commit(doc: string, batch: Batch): string {
  const r = apply(doc, { batch }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return r.document;
}
const model = (doc: string): EditorModel => readModel('h', doc);

/** A library item's files as the asset route would answer them. */
function stored(item: LibraryItem): { model: StoredFile; symbol: StoredFile } {
  return {
    model: { sha256: item.model.sha256, mediaType: item.model.mediaType, byteLength: item.model.byteLength, path: `assets/${item.model.sha256}.glb`, name: `${item.id}.glb` },
    symbol: { sha256: item.symbol.sha256, mediaType: item.symbol.mediaType, byteLength: item.symbol.byteLength, path: `assets/${item.symbol.sha256}.svg`, name: `${item.id}.svg` },
  };
}

function place(doc: string, id: string, room: string): string {
  const m = model(doc);
  const item = libraryItem(id) as LibraryItem;
  const level = m.levels.find((l) => l.rooms.some((r) => r.id === room));
  const spot = spotIn(level!, room, { box: item.box, mounting: item.mounting, category: item.category, clearances: item.clearances, height: 1_756_160 });
  expect(spot).not.toBeNull();
  return commit(doc, placeFurniture(m, { kind: item.kind, category: item.category, name: item.name, catalogue: item.id, box: item.box, clearances: item.clearances, ...stored(item), host: spot!.host })(0));
}

describe('a model’s box (Core 12.6, FS_furniture 3.1)', () => {
  it('is every library item’s box, read from its model’s accessors', () => {
    for (const item of LIBRARY) expect(modelBox(libFile(item.model.path)), item.id).toEqual(item.box);
  });

  it('maps glTF (X, Y, Z) to the frame’s (X, −Z, Y), and a +Z-facing model’s to (Z, X, Y)', () => {
    const b = { min: [-0.1, 0, -0.3] as [number, number, number], max: [0.5, 2, 0.2] as [number, number, number] };
    expect(boxFromBounds(b)).toEqual({ min: [-128_000, -256_000, 0], max: [640_000, 384_000, 2_560_000] });
    expect(boxFromBounds(b, true)).toEqual({ min: [-384_000, -128_000, 0], max: [256_000, 640_000, 2_560_000] });
  });

  it('carries the corners through each node’s transform', () => {
    const json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ translation: [1, 0, 0], children: [1] }, { mesh: 0, scale: [2, 1, 1] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ min: [0, 0, 0], max: [0.5, 1, 0.25], count: 8, type: 'VEC3', componentType: 5126 }],
    };
    expect(gltfBounds(json)).toEqual({ min: [1, 0, 0], max: [2, 1, 0.25] });
    expect(() => gltfBounds({ asset: { version: '2.0' } })).toThrow(/no geometry/);
  });

  it('turns a +Z-facing model to face +X under one node, as Core 12.6’s note says, keeping its buffers', () => {
    const bytes = libFile('models/sofa-2100.glb');
    const turned = faceXFromZ(bytes);
    const json = gltfJson(turned);
    const scene = (json['scenes'] as { nodes: number[] }[])[0]!;
    const root = (json['nodes'] as { rotation?: number[]; children?: number[] }[])[scene.nodes[0]!]!;
    expect(root.rotation).toEqual([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    expect(root.children).toEqual([0]);
    // The turned model's box is the original's read as facing +Z.
    expect(modelBox(turned)).toEqual(modelBox(bytes, true));
    // The binary chunk is copied as it was.
    expect(Buffer.from(turned.subarray(turned.length - 100)).equals(Buffer.from(bytes.subarray(bytes.length - 100)))).toBe(true);
  });

  it('draws an outline symbol at the box’s size in millimetres (FS_furniture 3.3)', () => {
    const svg = outlineSymbol({ min: [0, -576_000, 0], max: [896_000, 576_000, 1_000_000] }, 'Fridge <3');
    expect(svg).toContain('viewBox="0 0 900 700"');
    expect(svg).toContain('<title>Fridge &lt;3</title>');
  });
});

describe('the starter library', () => {
  it('has the 25 CC0 items, each with a model and a symbol the editor serves', () => {
    expect(LIBRARY).toHaveLength(25);
    for (const i of LIBRARY) {
      expect(i.model.url, i.id).not.toBe('');
      expect(i.symbol.url, i.id).not.toBe('');
      expect(sha(libFile(i.model.path))).toBe(i.model.sha256);
    }
  });

  it('gives each item its category’s default envelopes (FS_furniture 4.2)', () => {
    for (const i of LIBRARY) expect(i.clearances, i.id).toEqual(defaultEnvelopes(i.category, i.box));
    expect(Object.keys(libraryItem('refrigerator-900')!.clearances)).toEqual(['door']);
  });

  it('searches every word, and names categories for people', () => {
    expect(LIBRARY.filter((i) => matches(i, 'fridge')).length).toBe(0);
    expect(LIBRARY.filter((i) => matches(i, 'refrigerator')).map((i) => i.id)).toEqual(['refrigerator-900']);
    expect(LIBRARY.filter((i) => matches(i, 'wall cabinet')).map((i) => i.id)).toEqual(['wall-cabinet-600']);
    expect(categoryLabel('diningTable')).toBe('Dining table');
    expect(mountingOf('wallCabinet')).toBe('wall');
    expect(mountingOf('cooktop')).toBe('builtIn');
  });

  it('writes an item’s size as width × depth × height', () => {
    const fridge = libraryItem('refrigerator-900')!;
    expect(sizeText(fridge.box, 'metric')).toBe('900 × 700 × 1780 mm');
    expect(sizeText(fridge.box, 'imperial')).toBe('35 × 28 × 70 in');
  });
});

describe('placing an item (one batch, one undo)', () => {
  it('declares FS_furniture, adds the two assets and places the element, and the document is valid', () => {
    const doc = place(HOUSE, 'refrigerator-900', 'KIT');
    const d = JSON.parse(doc) as FloorspecDocument & { extensionsUsed: Record<string, string>; extensions: { FS_furniture: { collections: { appliances: Record<string, Record<string, unknown>> } } } };
    expect(d.extensionsUsed['FS_furniture']).toBe('0.1.0');
    const [id, el] = Object.entries(d.extensions.FS_furniture.collections.appliances)[0]!;
    expect(el).toMatchObject({ category: 'refrigerator', catalogue: 'refrigerator-900', clearances: { door: { purpose: 'swing' } }, fallback: { level: 'MAIN', box: libraryItem('refrigerator-900')!.box } });
    const fb = el['fallback'] as { asset: string; symbol: string };
    expect(d.assets?.[fb.asset]).toMatchObject({ mediaType: 'model/gltf-binary', sha256: libraryItem('refrigerator-900')!.model.sha256 });
    expect(d.assets?.[fb.symbol]).toMatchObject({ mediaType: 'image/svg+xml' });
    const m = model(doc);
    expect(m.valid).toBe(true);
    // Backed onto the kitchen's longest wall, facing in, with nothing in its way.
    expect(lintsOf(m, id)).toEqual([]);
    expect(m.derived?.extensions?.FS_furniture?.items[id]).toMatchObject({ category: 'refrigerator', room: 'KIT', width: 1_152_000, depth: 896_000 });
  });

  it('upgrades a 0.2 plan to 0.3 in the same batch, and declares the extension once', () => {
    const v02 = { ...JSON.parse(HOUSE), floorspec: '0.2' } as FloorspecDocument;
    expect(declarationOps(v02)).toEqual([
      { op: 'setProperty', id: '$document', path: '/floorspec', value: '0.3' },
      { op: 'setProperty', id: '$document', path: '/extensionsUsed/FS_furniture', value: '0.1.0' },
    ]);
    const once = place(HOUSE, 'dining-chair-450', 'KIT');
    expect(declarationOps(JSON.parse(once) as FloorspecDocument)).toEqual([]);
  });

  it('refers four chairs of one design to the same two assets (FS_furniture 3.4)', () => {
    let doc = HOUSE;
    for (let i = 0; i < 4; i++) doc = place(doc, 'dining-chair-450', 'LIV');
    const d = JSON.parse(doc) as FloorspecDocument;
    expect(Object.keys(d.assets ?? {}).filter((k) => k.startsWith('FA'))).toHaveLength(2);
  });

  it('puts the next item where the first is not, until the room is full', () => {
    let doc = place(HOUSE, 'refrigerator-900', 'KIT');
    doc = place(doc, 'range-760', 'KIT');
    doc = place(doc, 'dishwasher-600', 'KIT');
    const m = model(doc);
    expect(m.valid).toBe(true);
    expect(m.diagnostics.filter((d) => d.code.startsWith('FS-FURN-LINT'))).toEqual([]);
  });

  it('hangs a wall cabinet on the wall face at its height, so it moves with the wall', () => {
    const doc = place(HOUSE, 'wall-cabinet-600', 'KIT');
    const d = JSON.parse(doc) as { extensions: { FS_furniture: { collections: { casework: Record<string, { host: Record<string, unknown> }> } } } };
    const el = Object.values(d.extensions.FS_furniture.collections.casework)[0]!;
    expect(el.host).toMatchObject({ mode: 'wallFace', height: 1_756_160 });
    expect(model(doc).diagnostics.filter((x) => x.code === 'FS-FURN-LINT-003')).toEqual([]);
  });

  it('reports an island blocking a refrigerator’s door, in words, and a move clears it', () => {
    let doc = place(HOUSE, 'refrigerator-900', 'KIT');
    const m0 = model(doc);
    const fridge = m0.levels[0]!.devices.find((x) => x.element['category'] === 'refrigerator')!;
    // An island right in front of the door.
    const u: [number, number] = [Math.cos((fridge.placement!.facing * Math.PI) / 180e6), Math.sin((fridge.placement!.facing * Math.PI) / 180e6)];
    const at: [number, number] = [Math.round(fridge.placement!.point[0] + u[0] * 1_100_000), Math.round(fridge.placement!.point[1] + u[1] * 1_100_000)];
    const island = libraryItem('island-1800')!;
    doc = commit(doc, placeFurniture(m0, { kind: 'casework', category: 'island', box: island.box, clearances: island.clearances, ...stored(island), host: { mode: 'surface', room: 'KIT', surface: 'floor', at } })(0));
    const m = model(doc);
    const lint = m.diagnostics.find((x) => x.code === 'FS-FURN-LINT-004' && x.elements.includes(fridge.id));
    expect(lint).toBeDefined();
    expect(lintText(m, lint!, fridge.id, (e) => e)).toMatch(/Its clearance runs into/);
    const islandId = lint!.elements.find((e) => e !== fridge.id)!;
    expect(lintText(m, lint!, islandId, (e) => e)).toMatch(/stands in the clearance of/);
    // Moved back out of the door's way, facing the same way as the refrigerator, the door can open.
    const away: [number, number] = [Math.round(fridge.placement!.point[0] + u[0] * 2_300_000), Math.round(fridge.placement!.point[1] + u[1] * 2_300_000)];
    const far = commit(doc, moveFurniture(islandId, { mode: 'surface', room: 'KIT', surface: 'floor', at: away, rotation: fridge.placement!.facing }));
    const after = model(far);
    expect(after.valid).toBe(true);
    expect(after.diagnostics.filter((x) => x.code.startsWith('FS-FURN-LINT'))).toEqual([]);
  });
});

describe('moving and turning', () => {
  it('turns an item on a floor by quarters, normalised to (−180°, 180°], and not one on a wall', () => {
    expect(turnFurniture('X1', { mode: 'surface', rotation: 90_000_000 }, 90_000_000)).toEqual([{ op: 'setProperty', id: 'X1', path: '/host/rotation', value: 180_000_000 }]);
    expect(turnFurniture('X1', { mode: 'surface', rotation: 90_000_000 }, -90_000_000)).toEqual([{ op: 'unsetProperty', id: 'X1', path: '/host/rotation' }]);
    expect(turnFurniture('X1', { mode: 'wallFace' }, 90_000_000)).toBeNull();
    expect(normalAngle(-180_000_000)).toBe(180_000_000);
    expect(normalAngle(270_000_000)).toBe(-90_000_000);
  });

  it('nudges an item on a floor by its position, through the arrow keys’ batch', () => {
    const doc = place(HOUSE, 'armchair-850', 'LIV');
    const m = model(doc);
    const id = m.levels[0]!.devices[0]!.id;
    const host = m.levels[0]!.devices[0]!.host as { position: [number, number] };
    const batch = nudgeBatch(m.levels[0]!, m.document, id, 'ArrowRight', 32_512);
    expect(batch).toEqual([{ op: 'moveElement', element: id, host: expect.objectContaining({ mode: 'surface', at: [host.position[0] + 32_512, host.position[1]] }) as unknown }]);
    expect(model(commit(doc, batch!)).valid).toBe(true);
  });
});

describe('drawing it', () => {
  it('stretches the symbol over the footprint as Core 12.6’s corner table says', () => {
    const doc = place(HOUSE, 'refrigerator-900', 'KIT');
    const m = model(doc);
    const d = m.levels[0]!.devices[0]!;
    const view = { cx: 0, cy: 0, s: 1 / 1280, w: 1000, h: 1000 };
    const matrix = symbolMatrix(view, d)!;
    const [a, b, c, dd, e, f] = matrix.slice(7, -1).split(' ').map(Number) as [number, number, number, number, number, number];
    const toScreen = (p: readonly [number, number]) => [(p[0] - view.cx) * view.s + view.w / 2, view.h / 2 - (p[1] - view.cy) * view.s];
    // The image's corners land on the footprint's: top left (min x, min y), top right (min x, max y), bottom left (max x, min y).
    const box = libraryItem('refrigerator-900')!.box;
    const o = d.placement!.point;
    const ang = (d.placement!.facing * Math.PI) / 180e6;
    const at = (x: number, y: number): [number, number] => [o[0] + x * Math.cos(ang) - y * Math.sin(ang), o[1] + x * Math.sin(ang) + y * Math.cos(ang)];
    const near = (p: number[], q: number[]) => { expect(p[0]).toBeCloseTo(q[0]!, 0); expect(p[1]).toBeCloseTo(q[1]!, 0); };
    near([e, f], toScreen(at(box.min[0], box.min[1])));
    near([a + e, b + f], toScreen(at(box.min[0], box.max[1])));
    near([c + e, dd + f], toScreen(at(box.max[0], box.min[1])));
  });

  it('places each model at its element’s frame for the 3D view', () => {
    const doc = place(HOUSE, 'sofa-2100', 'LIV');
    const m = model(doc);
    const [item] = furnitureModels(m);
    const d = m.levels[0]!.devices[0]!;
    expect(item).toMatchObject({ id: d.id, sha256: libraryItem('sofa-2100')!.model.sha256, origin: [d.placement!.point[0], d.placement!.point[1], d.placement!.z], facing: d.placement!.facing });
  });

  it('finds overlapping footprints and leaves touching ones be', () => {
    const a = footprintAt([0, 0], [1, 0], { min: [0, 0], max: [10, 10] });
    expect(overlaps(a, footprintAt([5, 5], [1, 0], { min: [0, 0], max: [10, 10] }))).toBe(true);
    expect(overlaps(a, footprintAt([10, 0], [1, 0], { min: [0, 0], max: [10, 10] }))).toBe(false);
  });
});
