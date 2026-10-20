/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { LOOK_SEASONS, WEATHERS } from '@floorspec/mesh/sky';
import { buildScene, type Scene } from '../src/export/gltf/scene.js';
import { resolveSky, SEASON_NAMES, WEATHER_NAMES } from '../src/pathtrace/index.js';
import { exportParams, filmParams, pairParams, render3dParams, shotsParams, stillParams } from '../src/queue/handlers.js';
import { render3dPng } from '../src/render3d/index.js';
import { pngSize } from '../src/render/png.js';

/**
 * FLR-T-15.4 on the worker: a render's `season` and `weather` — read from a job, resolved into the
 * sky they are seen under, and drawn on the Courtyard House: its deciduous trees bare in winter, its
 * roofs under a light snow, its outside wet in the rain — while a render that names neither is the
 * scene it was.
 */

const HOUSE = JSON.parse(readFileSync(new URL('./fixtures/courtyard-house.json', import.meta.url), 'utf8')) as object;
const TREES = ['LS-T1', 'LS-T2', 'LS-T3', 'LS-T4'];

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
  for (let y = 0; y < height; y++)
    for (let x = 0; x < stride; x++) rgb[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + (x >= 3 ? rgb[y * stride + x - 3]! : 0)) & 255;
  return { width, height, rgb };
}
const mean = (img: { rgb: Uint8Array }): number => img.rgb.reduce((s, v) => s + v, 0) / img.rgb.length;

/** The material keys of every primitive of a node, by element ID. */
function materialsOf(scene: Scene, id: string): string[] {
  const node = scene.levels.flatMap((l) => l.nodes).find((n) => n.id === id);
  return [...new Set((node?.primitives ?? []).map((p) => scene.materials[p.material]!.key))].sort();
}
const triangles = (scene: Scene, id: string): number => (scene.levels.flatMap((l) => l.nodes).find((n) => n.id === id)?.primitives ?? []).reduce((n, p) => n + p.indices.length / 3, 0);

describe('a job’s season and weather', () => {
  it('names @floorspec/mesh’s looks', () => {
    expect(SEASON_NAMES).toEqual(LOOK_SEASONS);
    expect(WEATHER_NAMES).toEqual(WEATHERS);
  });

  it('is read from every render and export job that draws the house, and left out when it is not one', () => {
    const look = { season: 'winter', weather: 'snow' };
    expect(render3dParams({ ...look }).look).toEqual(look);
    expect(stillParams({ ...look }).look).toEqual(look);
    expect(shotsParams({ ...look }).look).toEqual(look);
    expect(exportParams({ ...look }).look).toEqual(look);
    expect(filmParams({ film: 'F1', ...look }).look).toEqual(look);
    expect(pairParams({ pair: { hash: 'a'.repeat(64) }, ...look }).look).toEqual(look);
    expect(render3dParams({ season: 'autumn' }).look).toEqual({ season: 'autumn' });
    expect(render3dParams({ season: 'fall', weather: 'hail' }).look).toBeUndefined();
    expect('look' in render3dParams({})).toBe(false);
  });

  it('sets the sky it is seen under, and says so', () => {
    const rain = resolveSky(HOUSE, { sky: 'clear', weather: 'rain', season: 'autumn' });
    expect(rain.light.preset).toBe('overcast');
    expect(rain.light.look).toEqual({ season: 'autumn', weather: 'rain' });
    const dusk = resolveSky(HOUSE, { sky: 'dusk', weather: 'clear' });
    expect(dusk.light.preset).toBe('dusk');
    // A request that names neither is the sky it was.
    expect(resolveSky(HOUSE, { sky: 'overcast' }).light.look).toEqual({ season: 'summer', weather: 'overcast' });
  });
});

describe('the scene in a season and a weather', () => {
  it('is the scene it was when the look is summer and dry', async () => {
    const plain = await buildScene(HOUSE);
    const summer = await buildScene(HOUSE, { look: { season: 'summer', weather: 'clear' } });
    expect(summer.materials.map((m) => m.key)).toEqual(plain.materials.map((m) => m.key));
    for (const id of [...TREES, 'R1']) expect(triangles(summer, id)).toBe(triangles(plain, id));
  });

  it('strips the deciduous trees bare in winter, and keeps the evergreens', async () => {
    const plain = await buildScene(HOUSE);
    const winter = await buildScene(HOUSE, { look: { season: 'winter' } });
    for (const id of TREES) {
      expect(materialsOf(plain, id).some((k) => k.startsWith('role:foliage'))).toBe(true);
      expect(materialsOf(winter, id)).toEqual(['role:trunk']);
      expect(triangles(winter, id)).toBeGreaterThan(200);
    }
    expect(materialsOf(winter, 'LS-S2')).toEqual(materialsOf(plain, 'LS-S2'));
    expect(materialsOf(winter, 'LS-L1')).toEqual(['role:lawnWinter']);
  });

  it('lays a light snow on the roofs, and wets them in the rain', async () => {
    const plain = await buildScene(HOUSE);
    const roofs = plain.levels.flatMap((l) => l.nodes).filter((n) => n.kind === 'roof').map((n) => n.id);
    expect(roofs.length).toBeGreaterThan(0);
    const snow = await buildScene(HOUSE, { look: { weather: 'snow' } });
    for (const id of roofs) expect(materialsOf(snow, id)).toContain('role:snow');
    // The walk is left cleared.
    expect(materialsOf(snow, 'LS-H1')).not.toContain('role:snow');
    const rain = await buildScene(HOUSE, { look: { weather: 'rain' } });
    for (const id of roofs) {
      const keys = materialsOf(rain, id);
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) expect(k).toMatch(/:wet$/);
    }
    const dry = plain.materials.find((m) => m.key === materialsOf(plain, roofs[0]!)[0])!;
    const wet = rain.materials.find((m) => m.key === `${dry.key}:wet`)!;
    expect(wet.baseColor[1]).toBeLessThan(dry.baseColor[1]);
    expect(wet.roughness).toBeLessThan(dry.roughness);
    // Indoors stays dry.
    const floors = rain.levels.flatMap((l) => l.nodes).filter((n) => n.kind === 'room');
    for (const n of floors) for (const p of n.primitives) expect(rain.materials[p.material]!.key).not.toMatch(/:wet$/);
  });
});

describe('the headless render in a season and a weather', () => {
  it('draws a winter under light snow brighter than a clear summer, from above, and the same picture twice', async () => {
    const summer = decode((await render3dPng(HOUSE, { camera: 'top', width: 160, sky: 'clear', at: '2026-01-15T13:00' })).png);
    const snowy = await render3dPng(HOUSE, { camera: 'top', width: 160, sky: 'clear', at: '2026-01-15T13:00', look: { season: 'winter', weather: 'snow' } });
    const again = await render3dPng(HOUSE, { camera: 'top', width: 160, sky: 'clear', at: '2026-01-15T13:00', look: { season: 'winter', weather: 'snow' } });
    expect(Buffer.from(snowy.png).equals(Buffer.from(again.png))).toBe(true);
    expect(snowy.sky?.look).toEqual({ season: 'winter', weather: 'snow' });
    expect(snowy.sky?.preset).toBe('overcast');
    expect(mean(decode(snowy.png))).toBeGreaterThan(mean(summer) + 20);
  });

  it('draws a render that names no look as it did', async () => {
    const plain = await render3dPng(HOUSE, { camera: 'sw', width: 128, sky: 'clear', at: '2026-06-21T15:00' });
    const summer = await render3dPng(HOUSE, { camera: 'sw', width: 128, sky: 'clear', at: '2026-06-21T15:00', look: { season: 'summer' } });
    expect(Buffer.from(summer.png).equals(Buffer.from(plain.png))).toBe(true);
    expect(plain.sky?.look).toBeUndefined();
  });
});
