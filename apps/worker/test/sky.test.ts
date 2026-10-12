/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { sunAt } from '@floorspec/mesh/sky';
import { parseAt, renderStill, resolveSky, siteOf } from '../src/pathtrace/index.js';
import { render3dParams, stillParams } from '../src/queue/handlers.js';
import { render3dPng } from '../src/render3d/index.js';
import { pngSize } from '../src/render/png.js';

/**
 * FLR-T-13.4, FLR-T-13.9 on the worker: a render's `sky` and `at` — the preset chosen, the sun
 * placed by the NOAA algorithm from the document's site at a date and time — and the headless
 * render and the path tracer drawn under it: the lawn, the sky, the sun's shadows.
 */

type Json = Record<string, unknown>;
const load = (p: string): Json => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as Json;
const HOUSE = load('./fixtures/two-storey.json');
const ATLANTA = { location: { latitude: 33_749_000, longitude: -84_388_000 }, trueNorth: 0 };
const sited = (site: Json): Json => ({ ...structuredClone(HOUSE), site });

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
/** The mean colour of a square of pixels. */
function patch(img: { width: number; rgb: Uint8Array }, cx: number, cy: number, r: number): [number, number, number] {
  const s = [0, 0, 0];
  let n = 0;
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) {
      for (let c = 0; c < 3; c++) s[c] = s[c]! + img.rgb[3 * (y * img.width + x) + c]!;
      n++;
    }
  return [s[0]! / n, s[1]! / n, s[2]! / n];
}

describe('a date and time at the site', () => {
  it('reads ISO 8601 with an offset, Z, or none — then the site’s zone by its longitude', () => {
    const edt = parseAt('2026-06-21T19:30-04:00', -84.388)!;
    expect(edt.ms).toBe(Date.UTC(2026, 5, 21, 23, 30));
    expect(edt).toMatchObject({ offset: -240, assumed: false, midnight: Date.UTC(2026, 5, 21, 4) });
    expect(parseAt('2026-06-21T19:30:15Z', 0)!.ms).toBe(Date.UTC(2026, 5, 21, 19, 30, 15));
    // −84.4° is UTC−06:00 by longitude (15° an hour): Floorspec records no time zone.
    expect(parseAt('2026-06-21T19:30', -84.388)).toMatchObject({ offset: -360, assumed: true, ms: Date.UTC(2026, 5, 22, 1, 30) });
    for (const bad of ['June 21', '2026-02-30T12:00', '2026-06-21T25:00', '2026-06-21 19:30', '2026-06-21T19:30+15:00']) expect(parseAt(bad, 0), bad).toBeNull();
  });
});

describe('a render’s sky', () => {
  it('is the preset asked for — else the old time of day’s, else a clear day', () => {
    expect(resolveSky(HOUSE, { sky: 'overcast' }).light.preset).toBe('overcast');
    expect(resolveSky(HOUSE, { time: 'dusk' }).light.preset).toBe('dusk');
    expect(resolveSky(HOUSE, { time: 'night' }).light.preset).toBe('night');
    expect(resolveSky(HOUSE, { sky: 'studio', time: 'night' }).light.preset).toBe('studio');
    expect(resolveSky(HOUSE, {}).light.preset).toBe('clear');
    expect(() => resolveSky(HOUSE, { sky: 'sunny' as 'clear' })).toThrow(/sky is one of/);
    expect(() => resolveSky(HOUSE, { at: 'tomorrow' })).toThrow(/date and time at the site/);
  });

  it('places the sun from the document’s site at `at` (NOAA): west, low, on a June evening in Atlanta', () => {
    const r = resolveSky(sited(ATLANTA), { sky: 'clear', at: '2026-06-21T19:30-04:00' });
    const want = sunAt(Date.UTC(2026, 5, 21, 23, 30), 33.749, -84.388);
    expect(r.sun).toMatchObject({ source: 'at' });
    expect(r.sun!.azimuth).toBeCloseTo(want.azimuth, 9);
    expect(r.sun!.altitude).toBeCloseTo(want.altitude, 9);
    expect(r.sun!.azimuth).toBeGreaterThan(280);
    expect(r.sun!.azimuth).toBeLessThan(300);
    expect(r.sun!.altitude).toBeGreaterThan(5);
    expect(r.sun!.altitude).toBeLessThan(25);
    expect(r.site).toEqual({ latitude: 33.749, longitude: -84.388, trueNorth: 0, assumed: false });
    // Dusk that day: the sun just under the horizon where it set.
    const dusk = resolveSky(sited(ATLANTA), { sky: 'dusk', at: '2026-06-21T12:00-04:00' });
    expect(dusk.sun!.altitude).toBe(-3);
    expect(dusk.sun!.azimuth).toBeGreaterThan(295);
    // No location: the assumed site, and it says so.
    expect(siteOf(HOUSE)).toMatchObject({ latitude: 40, longitude: -75, assumed: true });
    expect(resolveSky(HOUSE, { at: '2026-06-21T12:00-04:00' }).site.assumed).toBe(true);
  });

  it('is read from a job row, and what is not a preset or a date and time is dropped', () => {
    expect(render3dParams({ sky: 'dusk', at: '2026-06-21T19:30-04:00' })).toMatchObject({ sky: 'dusk', at: '2026-06-21T19:30-04:00' });
    expect(render3dParams({ sky: 'sunny', at: 'soon' })).toEqual({});
    expect(stillParams({ sky: 'night' })).toMatchObject({ sky: 'night' });
  });
});

describe('the headless render under a sky', () => {
  it('stands the house on a green lawn, where the studio drawing has its muted plate', async () => {
    const drawing = decode((await render3dPng(HOUSE, { width: 160 })).png);
    const clear = await render3dPng(sited(ATLANTA), { width: 160, sky: 'clear', at: '2026-06-21T15:00-04:00' });
    expect(clear.sky).toMatchObject({ preset: 'clear', sun: { source: 'at' }, site: { assumed: false } });
    const img = decode(clear.png);
    const lawn = patch(img, 8, 112, 4);
    expect(lawn[1]).toBeGreaterThan(lawn[0] + 5);
    expect(lawn[1]).toBeGreaterThan(lawn[2] + 15);
    expect(patch(drawing, 8, 112, 4)).not.toEqual(lawn);
    // Night: the lawn all but dark; the studio's floor is pale grey, not green.
    const night = decode((await render3dPng(HOUSE, { width: 160, sky: 'night' })).png);
    expect(patch(night, 8, 112, 4)[1]).toBeLessThan(lawn[1]);
    const studio = patch(decode((await render3dPng(HOUSE, { width: 160, sky: 'studio' })).png), 8, 112, 4);
    expect(Math.abs(studio[1] - studio[0])).toBeLessThan(6);
  });

  it('casts the sun’s shadow onto the lawn, away from the sun', async () => {
    // From above, the sun low in the east and then low in the west: the lawn beside the house darker
    // on the side away from the sun.
    const east = decode((await render3dPng(HOUSE, { width: 160, camera: 'top', sky: 'clear', at: '2026-06-21T07:30-04:00' })).png);
    const westSun = decode((await render3dPng(HOUSE, { width: 160, camera: 'top', sky: 'clear', at: '2026-06-21T19:00-04:00' })).png);
    const lum = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    // The lawn just west of the house and just east of it: in the morning the shadow is to the west,
    // in the evening to the east.
    const west = (img: ReturnType<typeof decode>) => lum(patch(img, 26, 60, 3));
    const eastOf = (img: ReturnType<typeof decode>) => lum(patch(img, 134, 60, 3));
    expect(west(east)).toBeLessThan(0.8 * eastOf(east));
    expect(eastOf(westSun)).toBeLessThan(0.8 * west(westSun));
  });
});

describe('a path-traced still under a sky', () => {
  it('reports its sky, and the same request makes the same picture', async () => {
    const opts = { pixels: { width: 48, height: 36 }, samples: 4, sky: 'clear' as const, at: '2026-06-21T19:30-04:00' };
    const a = await renderStill(sited(ATLANTA), opts);
    const b = await renderStill(sited(ATLANTA), opts);
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
    expect(a.sky).toMatchObject({ preset: 'clear', at: '2026-06-21T19:30-04:00', sun: { source: 'at' } });
    expect(a.sun.azimuth).toBeGreaterThan(280);
  });
});
