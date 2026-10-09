import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildScene, exportGltf } from '../src/export/gltf/index.js';
import { handlers } from '../src/queue/handlers.js';
import { ROOM_PALETTE } from '@floorspec/mesh';
import { linear } from '../src/export/gltf/scene.js';
import { encodePng } from '../src/render3d/png.js';
import { centroid, cutOf, findRoom, PRESETS, presetCamera, render3dPng, renderGlb, renderScene, renderView, roomCamera, sceneTriangles, shoulder, tone } from '../src/render3d/index.js';
import { pngSize } from '../src/render/png.js';

/**
 * FLR-T-8.5: the headless 3D render — named views framed on the house, a person standing in a room,
 * a cutaway above a level, highlighted elements — drawn by the worker's software rasterizer, the
 * same picture every time; and an exported .glb drawn back through the same path, which shows the
 * file holds the house the scene does.
 */

type Json = Record<string, unknown>;
const load = (p: string): Json => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as Json;
const TWO_STOREY = load('./fixtures/two-storey.json');
const L_STAIR = load('../../web/e2e/fixtures/l-stair-hip-roof.json');
/**
 * The two-storey house with colourful walls (rooms' wallFinish), its living room's south wall a bay
 * (an arc wall, Core 21), a roof deck — an outdoor room — on the upper floor where a bedroom was, and
 * a hip roof over the rest (FLR-T-12.23).
 */
const APPEARANCE = load('./fixtures/appearance-house.json');

/** Our own PNGs back to RGB: one IDAT, 8-bit truecolour, every row filtered by Sub. */
function decode(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const { width, height } = pngSize(png);
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  const idat: Uint8Array[] = [];
  while (at < png.byteLength) {
    const len = v.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(1);
    for (let x = 0; x < stride; x++) rgb[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + (x >= 3 ? rgb[y * stride + x - 3]! : 0)) & 255;
  }
  return { width, height, rgb };
}

const pixel = (img: { width: number; rgb: Uint8Array }, x: number, y: number): [number, number, number] => {
  const o = 3 * (y * img.width + x);
  return [img.rgb[o]!, img.rgb[o + 1]!, img.rgb[o + 2]!];
};

function colours(img: { rgb: Uint8Array }): number {
  const seen = new Set<number>();
  for (let i = 0; i < img.rgb.length; i += 3) seen.add((img.rgb[i]! << 16) | (img.rgb[i + 1]! << 8) | img.rgb[i + 2]!);
  return seen.size;
}

describe('3D render', () => {
  it('draws a named view: 1024 × 768 by default, three quarters as high as it is wide', async () => {
    const r = await render3dPng(L_STAIR);
    expect(r.camera).toBe('SW iso');
    expect(pngSize(r.png)).toEqual({ width: 1024, height: 768 });
    const small = await render3dPng(L_STAIR, { camera: 'ne', width: 512 });
    expect(pngSize(small.png)).toEqual({ width: 512, height: 384 });
    // A house, not a blank: many shades, and the middle of the picture is the building, not the ground.
    const img = decode(r.png);
    expect(colours(img)).toBeGreaterThan(60);
    const ground = pixel(img, 4, 4);
    const middle = pixel(img, 512, 400);
    expect(Math.abs(middle[0] - ground[0]) + Math.abs(middle[1] - ground[1]) + Math.abs(middle[2] - ground[2])).toBeGreaterThan(30);
  });

  it('is deterministic: one version, one view, one picture', async () => {
    const a = await render3dPng(TWO_STOREY, { camera: 'se' });
    const b = await render3dPng(structuredClone(TWO_STOREY), { camera: 'se' });
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
  });

  it('frames each named view on the house, from its corner of the compass', async () => {
    const scene = await buildScene(TWO_STOREY);
    const box = scene.bounds!;
    for (const preset of PRESETS) {
      const c = presetCamera(preset, box, 4 / 3);
      const [dx, dy, dz] = [0, 1, 2].map((k) => c.eye[k]! - c.target[k]!) as [number, number, number];
      expect(dy, preset).toBeGreaterThan(0);
      // glTF's frame: east +X, north −Z.
      if (preset === 'sw') expect([dx < 0, dz > 0]).toEqual([true, true]);
      if (preset === 'se') expect([dx > 0, dz > 0]).toEqual([true, true]);
      if (preset === 'ne') expect([dx > 0, dz < 0]).toEqual([true, true]);
      if (preset === 'nw') expect([dx < 0, dz < 0]).toEqual([true, true]);
      if (preset === 'top') expect(Math.hypot(dx, dz)).toBeLessThan(1e-6);
    }
  });

  it('stands in a room: at eye height (lower under a low ceiling) in its doorway, looking at its middle', async () => {
    const scene = await buildScene(L_STAIR);
    const kitchen = findRoom(scene.rooms, 'kitchen')!;
    expect(kitchen.id).toBe('KIT');
    expect(findRoom(scene.rooms, 'KIT')).toBe(kitchen);
    const c = roomCamera(kitchen, scene.doors);
    expect(c.label).toMatch(/^Kitchen \(KIT\) from its doorway /);
    expect(c.eye[1] - kitchen.floor).toBeCloseTo(Math.min(1.6, (kitchen.ceiling - kitchen.floor) * 0.62), 6);
    const [cx, cy] = centroid(kitchen.outer);
    expect(c.target[0]).toBeCloseTo(cx, 6);
    expect(c.target[2]).toBeCloseTo(-cy, 6);
    const r = renderScene(scene, { room: 'Kitchen', width: 640 });
    expect(r.camera).toBe(c.label);
    expect(pngSize(r.png)).toEqual({ width: 640, height: 480 });
    expect(colours(decode(r.png))).toBeGreaterThan(50);
    // A room with no door into it is seen from a corner.
    const corner = roomCamera({ ...kitchen }, []);
    expect(corner.label).toBe('Kitchen (KIT) from its corner');
  });

  it('says which rooms there are when asked for one that is not', async () => {
    await expect(render3dPng(L_STAIR, { room: 'Attic' })).rejects.toThrow(/no room Attic; its rooms are .*KIT \(Kitchen\)/);
    await expect(render3dPng(L_STAIR, { level: 'L9' })).rejects.toThrow(/no level L9/);
    await expect(render3dPng(L_STAIR, { width: 4096 })).rejects.toThrow(/width/);
  });

  it('cuts away above a level, and highlights what it is asked to', async () => {
    const scene = await buildScene(L_STAIR);
    const whole = decode(renderScene(scene, { camera: 'sw', width: 512 }).png);
    const cut = decode(renderScene(scene, { camera: 'sw', width: 512, level: 'L1' }).png);
    expect(Buffer.from(cut.rgb).equals(Buffer.from(whole.rgb))).toBe(false);
    const roof = scene.levels.flatMap((l) => l.nodes).find((n) => n.kind === 'roof')!;
    const lit = decode(renderScene(scene, { camera: 'sw', width: 512, highlight: [roof.id] }).png);
    let changed = 0;
    for (let i = 0; i < lit.rgb.length; i += 3) if (lit.rgb[i] !== whole.rgb[i] || lit.rgb[i + 2] !== whole.rgb[i + 2]) changed++;
    expect(changed).toBeGreaterThan(10_000);
  });

  it('draws an exported .glb back as the scene it was written from', async () => {
    for (const doc of [TWO_STOREY, L_STAIR]) {
      const scene = await buildScene(doc);
      const fromScene = decode(renderScene(scene, { camera: 'se', width: 512 }).png);
      const fromGlb = decode(renderGlb((await exportGltf(doc, { version: { hash: '0'.repeat(64) } })).bytes, { camera: 'se', width: 512 }).png);
      let diff = 0;
      for (let i = 0; i < fromScene.rgb.length; i++) diff += Math.abs(fromScene.rgb[i]! - fromGlb.rgb[i]!);
      // The same triangles in the same colours from the same camera: at most a few edge pixels apart.
      expect(diff / fromScene.rgb.length).toBeLessThan(0.5);
    }
  });

  it('draws a fixture model: a lens unshaded, a round piece without ink between its facets (FLR-T-12.21)', async () => {
    const scene = await buildScene(load('../../../packages/mesh/test/fixtures/showcase.floorspec.json'));
    const tris = sceneTriangles(scene);
    expect(tris.filter((t) => t.unlit === true).length).toBeGreaterThan(0);
    // Each round primitive is one outline key, far past the planes' keys.
    const round = tris.filter((t) => t.key !== undefined && t.key >= 1 << 24);
    expect(round.length).toBeGreaterThan(100);
    expect(new Set(round.map((t) => t.key)).size).toBeLessThan(round.length / 10);
    const kitchen = decode(renderScene(scene, { room: 'R1', width: 320 }).png);
    expect(colours(kitchen)).toBeGreaterThan(200);
  });

  it('runs as a render.3d job: a PNG and what the camera was', async () => {
    const job = { id: 'j', projectId: 'p', kind: 'render.3d', versionHash: 'c'.repeat(64), params: { room: 'BED', width: 320, design: {} } };
    const file = await handlers['render.3d']!(L_STAIR, job);
    expect(file.contentType).toBe('image/png');
    expect(pngSize(file.bytes)).toEqual({ width: 320, height: 240 });
    expect(file.summary).toMatchObject({ width: 320, height: 240, camera: expect.stringMatching(/^Bedroom \(BED\)/) as string });
    const gltf = await handlers['export.gltf']!(L_STAIR, { ...job, kind: 'export.gltf', params: { versionSeq: 7, versionAt: new Date(0).toISOString() } });
    expect(gltf).toMatchObject({ name: 'stair-and-hip-roof-house-v7.glb', contentType: 'model/gltf-binary' });
  });
});

describe('doorways and corners (FLR-T-12.20)', () => {
  it('floors every door and cased opening whose sill is its wall’s base, flush with the floors, in the floor’s material', async () => {
    const scene = await buildScene(TWO_STOREY);
    const openings = TWO_STOREY['openings'] as Record<string, { fill?: string }>;
    const types = TWO_STOREY['types'] as Record<string, { kind: string }>;
    let floored = 0;
    for (const level of scene.levels) {
      // The tops of the level's floors (glTF +Y is up).
      const tops = new Set<string>();
      const floors = new Set<number>();
      for (const n of level.nodes)
        for (const p of n.primitives.filter((q) => q.part === 'floor')) {
          floors.add(p.material);
          for (let i = 1; i < p.positions.length; i += 3) tops.add(p.positions[i]!.toFixed(5));
        }
      for (const n of level.nodes.filter((x) => x.kind === 'opening')) {
        const kind = openings[n.id]!.fill === undefined ? 'empty' : types[openings[n.id]!.fill!]!.kind;
        const ths = n.primitives.filter((p) => p.part === 'threshold');
        if (kind === 'windowType') {
          expect(ths, n.id).toHaveLength(0);
          continue;
        }
        expect(ths.length, `${n.id}: a threshold`).toBeGreaterThan(0);
        expect(n.parts).toEqual(['opening', 'threshold']);
        for (const p of ths) {
          // The floor of the room it continues: no finish named, so that room's default floor (FLR-T-12.23).
          expect(scene.materials[p.material]!.key, n.id).toMatch(/^default:floor:/);
          expect(floors.has(p.material), `${n.id}: a floor's material`).toBe(true);
          for (let i = 1; i < p.positions.length; i += 3) expect(tops.has(p.positions[i]!.toFixed(5)), `${n.id}: flush with a floor`).toBe(true);
        }
        floored++;
      }
    }
    // The front door, the cased opening and six interior doors.
    expect(floored).toBe(8);
  });

  it('closes the corners a separator leaves, its faces the walls’ finishes and its top their core', async () => {
    const scene = await buildScene(load('../../../packages/engine/standard/conformance/core/0.3/examples/001-three-room-house/input.json'));
    const tm = scene.levels.flatMap((l) => l.nodes).find((n) => n.id === 'TM')!;
    expect(tm.kind).toBe('junction');
    const names = new Set(tm.primitives.map((p) => scene.materials[p.material]!.key));
    // The partitions' gypsum board on the faces that continue theirs, their studs on top; no flat fill colour.
    expect([...names].sort()).toEqual(['M:GWB', 'M:STUD']);
    for (const p of tm.primitives) {
      // A primitive is one material: any triangle facing up (the top) is in the studs'.
      const up = Array.from({ length: p.normals.length / 3 }, (_, i) => p.normals[3 * i + 1]!).some((y) => y > 0.99);
      if (up) expect(scene.materials[p.material]!.key).toBe('M:STUD');
    }
  });
});

describe('appearance (FLR-T-12.23)', () => {
  type Tri = { a: number[]; b: number[]; c: number[] };
  const area = (t: Tri): number => {
    const u = [0, 1, 2].map((k) => t.b[k]! - t.a[k]!);
    const v = [0, 1, 2].map((k) => t.c[k]! - t.a[k]!);
    return Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
  };

  it('draws an arc wall’s faces in their finishes, one curved surface each, not its framing in stripes', async () => {
    const scene = await buildScene(APPEARANCE);
    const bay = scene.levels.flatMap((l) => l.nodes).find((n) => n.id === 'S3')!;
    const byMaterial = new Map<string, number>();
    for (const p of bay.primitives) {
      const key = scene.materials[p.material]!.key;
      let a = 0;
      for (let k = 0; k < p.indices.length; k += 3) {
        const at = (i: number) => [p.positions[3 * i]!, p.positions[3 * i + 1]!, p.positions[3 * i + 2]!];
        a += area({ a: at(p.indices[k]!), b: at(p.indices[k + 1]!), c: at(p.indices[k + 2]!) });
      }
      byMaterial.set(key, (byMaterial.get(key) ?? 0) + a);
      // The siding outside and the living room's terracotta inside, each a curved surface: no ink between its segments.
      if (key === 'M:SIDING' || key === 'M:TERRA') expect(p.smooth, key).toBe(true);
    }
    const siding = byMaterial.get('M:SIDING') ?? 0;
    expect(siding).toBeGreaterThan(15);
    expect(byMaterial.get('M:TERRA') ?? 0).toBeGreaterThan(0.8 * siding);
    // The framing is only the wall's top and bottom, its ends and its window's reveals — not stripes down its faces.
    expect(byMaterial.get('M:STUD') ?? 0).toBeLessThan(0.3 * siding);
  });

  it('draws an outdoor room with nothing over it open to the sky, and a room with no finishes in its function’s palette', async () => {
    const scene = await buildScene(APPEARANCE);
    const node = (id: string) => scene.levels.flatMap((l) => l.nodes).find((n) => n.id === id)!;
    expect(node('BED2U').parts).toEqual(['floor']);
    expect(node('LIVU').parts).toEqual(['floor', 'ceiling']);
    const floorOf = (id: string) => scene.materials[node(id).primitives.find((p) => p.part === 'floor')!.material]!;
    expect(floorOf('BED2U')).toMatchObject({ key: 'default:floor:exterior', color: ROOM_PALETTE.exterior.floor });
    expect(floorOf('BATH')).toMatchObject({ key: 'default:floor:bath', color: ROOM_PALETTE.bath.floor });
    expect(floorOf('LIV')).toMatchObject({ key: 'default:floor:living', color: ROOM_PALETTE.living.floor });
  });

  it('draws a material with a map and no colour in its map’s average colour, else in the surface’s default', async () => {
    const doc = structuredClone(APPEARANCE) as Json & { materials: Json; rooms: Record<string, Json> };
    doc.materials['PHOTO'] = { name: 'A photo of a rug', texture: { asset: 'RUG', size: [390_144, 390_144] } };
    doc['assets'] = { RUG: { path: 'assets/rug.png', sha256: 'd'.repeat(64), mediaType: 'image/png' } };
    doc.rooms['LIV']!['floorFinish'] = 'PHOTO';
    // A 2 × 2 map: two red texels, two blue — its average in linear light.
    const png = encodePng(Uint8Array.from([200, 40, 40, 40, 40, 200, 40, 40, 200, 200, 40, 40]), 2, 2);
    const seen: string[] = [];
    const withMap = await buildScene(doc, { images: (a) => (seen.push(a.id), png) });
    expect(seen).toContain('RUG');
    const rug = withMap.materials.find((m) => m.key === 'M:PHOTO')!;
    const [r, , b] = linear('#c82828');
    const [r2, , b2] = linear('#2828c8');
    expect(rug.baseColor[0]).toBeCloseTo((r + r2) / 2, 3);
    expect(rug.baseColor[2]).toBeCloseTo((b + b2) / 2, 3);
    const without = (await buildScene(doc)).materials.find((m) => m.key === 'M:PHOTO')!;
    expect(without.baseColor.slice(0, 3)).toEqual(linear(ROOM_PALETTE.living.floor));
  });

  it('draws the whole house — every ceiling and every roof — for level "all", as for no level', async () => {
    const scene = await buildScene(APPEARANCE);
    expect(cutOf(scene, undefined)).toBeUndefined();
    expect(cutOf(scene, 'all')).toBeUndefined();
    expect(cutOf(scene, 'UPPER')).toBe(1);
    expect(() => cutOf(scene, 'ATTIC')).toThrow(/no level ATTIC.*"all" draws the whole house/);
    // A model with a level called "all" means that level.
    expect(cutOf({ levels: [{ id: 'G', elevation: 0, nodes: [] }, { id: 'all', elevation: 3, nodes: [] }] }, 'all')).toBe(1);
    const all = sceneTriangles(scene, { level: 'all' });
    expect(all.length).toBe(sceneTriangles(scene).length);
    expect(all.length).toBeGreaterThan(sceneTriangles(scene, { level: 'UPPER' }).length);
    const a = renderScene(scene, { camera: 'sw', width: 320, level: 'all' });
    const b = renderScene(scene, { camera: 'sw', width: 320 });
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
    const job = { id: 'j', projectId: 'p', kind: 'render.3d', versionHash: 'c'.repeat(64), params: { level: 'all', width: 320 } };
    expect((await handlers['render.3d']!(APPEARANCE, job)).summary).toMatchObject({ camera: 'SW iso' });
  });

  it('tone-maps with a gentle shoulder that keeps a finish’s hue, and leaves the paper behind a drawing white', async () => {
    expect(shoulder(0.3)).toBe(0.3);
    let last = 0;
    for (let x = 0; x <= 4; x += 0.05) {
      const y = shoulder(x);
      expect(y).toBeGreaterThanOrEqual(last);
      expect(y).toBeLessThan(1);
      last = y;
    }
    // A bright terracotta keeps its hue: its channels in the same order and proportion where none clips.
    const [r, g, b] = tone(1.1, 0.33, 0.16);
    expect(r).toBeLessThanOrEqual(1);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    const [r2, g2, b2] = tone(0.4, 0.12, 0.06);
    expect(g2 / r2).toBeCloseTo(0.12 / 0.4, 9);
    expect(b2 / r2).toBeCloseTo(0.06 / 0.4, 9);
    const view = renderView(await buildScene(APPEARANCE), { width: 200, height: 150 })!;
    expect(pixel(decode(view.png), 1, 1)).toEqual([255, 255, 255]);
  });

  it('draws the house in its own colours: many more than the old greige', async () => {
    const img = decode((await render3dPng(APPEARANCE, { camera: 'se', level: 'UPPER', width: 512 })).png);
    expect(colours(img)).toBeGreaterThan(200);
    const again = await render3dPng(structuredClone(APPEARANCE), { camera: 'se', level: 'UPPER', width: 512 });
    expect(Buffer.from(again.png).equals(Buffer.from(encodePng(img.rgb, img.width, img.height)))).toBe(true);
  });
});
