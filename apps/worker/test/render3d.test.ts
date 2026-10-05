import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildScene, exportGltf } from '../src/export/gltf/index.js';
import { handlers } from '../src/queue/handlers.js';
import { centroid, findRoom, PRESETS, presetCamera, render3dPng, renderGlb, renderScene, roomCamera } from '../src/render3d/index.js';
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
    // A room with no door into it is seen from its far corner.
    const corner = roomCamera({ ...kitchen }, []);
    expect(corner.label).toBe('Kitchen (KIT) from its far corner');
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
