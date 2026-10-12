 
import { describe, expect, it } from 'vitest';
import {
  airMass,
  decodeHdr,
  DEFAULT_SKY,
  DEFAULT_SUN,
  encodeHdr,
  GRASS_SIZE,
  GRASS_TILE,
  grassTexture,
  groundAt,
  irradianceAt,
  isSkyPreset,
  lawnAlbedo,
  lawnAt,
  lawnMacro,
  mapsFor,
  placeVector,
  SKY_LABELS,
  SKY_PRESETS,
  skyField,
  skyHarmonics,
  skyLight,
  skyMapOf,
  skyRadiance,
  sunlight,
  type SkyMap,
} from '../src/sky/index.js';

/**
 * FLR-T-13.4, FLR-T-13.9: the sky every view of a house shares — its presets, the sun's light and
 * the sky's, its image-based light, the lawn — tested on its own, with a synthetic map where a map
 * is needed (the real ones are sky.node.test.ts's).
 */

/** A map the same brightness everywhere above the horizon: its illuminance is π times it. */
function evenMap(id: 'clear' | 'overcast' | 'dusk' | 'night', w = 64): SkyMap {
  const h = Math.round((w / 2) * (96 / 180));
  return skyMapOf(id, { width: w, height: h, data: new Float32Array(w * h * 3).fill(1) });
}
/** cos and sin of a fraction of a turn: a test's own discrete Fourier transform. */
const COS_OF = (turns: number): number => Math.cos(2 * Math.PI * turns);
const SIN_OF = (turns: number): number => Math.sin(2 * Math.PI * turns);
const maps = { clear: evenMap('clear'), overcast: evenMap('overcast'), dusk: evenMap('dusk'), night: evenMap('night') };

describe('the sky presets', () => {
  it('are clear day, overcast, dusk, night and studio, a clear day by default', () => {
    expect([...SKY_PRESETS]).toEqual(['clear', 'overcast', 'dusk', 'night', 'studio']);
    expect(SKY_PRESETS.map((p) => SKY_LABELS[p])).toEqual(['Clear day', 'Overcast', 'Dusk', 'Night', 'Studio']);
    expect(DEFAULT_SKY).toBe('clear');
    expect(isSkyPreset('dusk')).toBe(true);
    expect(isSkyPreset('sunny')).toBe(false);
    expect(isSkyPreset(undefined)).toBe(false);
  });

  it('a clear day: the sun where it is asked to be, lit through its air mass, over the clear map', () => {
    const s = skyLight('clear', { azimuth: 270, altitude: 30 }, 0);
    expect(s.band).toBe('day');
    expect(s.direct?.kind).toBe('sun');
    // Due west, 30° up, in the project's frame (x east, y north, z up).
    s.direct!.dir.forEach((c, k) => { expect(c).toBeCloseTo([-Math.cos(Math.PI / 6), 0, 0.5][k]!, 9); });
    expect(s.layers.map((l) => [l.map, l.weight])).toEqual([['clear', 1]]);
    expect(mapsFor(s)).toEqual(['clear']);
    expect(s.ground.grass).toBe(true);
    // Without a sun asked for, the default: mid-afternoon from the south-west.
    expect(skyLight('clear', null).sun).toEqual(DEFAULT_SUN);
  });

  it('a clear sky follows its sun: through sunset into the dusk sky, and past it into night with a moon', () => {
    const sunset = skyLight('clear', { azimuth: 295, altitude: -1 }, 0);
    expect(sunset.band).toBe('dusk');
    expect(sunset.direct).toBeNull();
    expect(sunset.layers.map((l) => l.map)).toContain('dusk');
    const night = skyLight('clear', { azimuth: 330, altitude: -20 }, 0);
    expect(night.band).toBe('night');
    expect(night.layers.map((l) => [l.map, l.weight])).toEqual([['night', 1]]);
    expect(night.direct?.kind).toBe('moon');
    // The moon opposite the sun, and faint.
    expect(night.direct!.place.azimuth).toBeCloseTo(150, 9);
    expect(night.direct!.lux).toBeLessThan(1);
    // The weights always come to one.
    for (let a = -15; a <= 10; a += 0.5) {
      const l = skyLight('clear', { azimuth: 280, altitude: a }, 0);
      expect(l.layers.reduce((n, x) => n + x.weight, 0)).toBeCloseTo(1, 9);
    }
  });

  it('overcast: no direct sun, the cloud as bright as the sun is high', () => {
    const s = skyLight('overcast', { azimuth: 200, altitude: 50 }, 0);
    expect(s.direct).toBeNull();
    expect(s.layers.map((l) => l.map)).toEqual(['overcast']);
    expect(s.layers[0]!.lux).toBeGreaterThan(skyLight('overcast', { azimuth: 200, altitude: 10 }, 0).layers[0]!.lux);
  });

  it('dusk: the sun 3° under the horizon at the bearing it set, no direct light; night: the moon', () => {
    const dusk = skyLight('dusk', { azimuth: 300, altitude: 25 }, 0);
    expect(dusk.sun).toEqual({ azimuth: 300, altitude: -3 });
    expect(dusk.direct).toBeNull();
    expect(dusk.band).toBe('dusk');
    expect(dusk.layers.map((l) => l.map)).toEqual(['dusk']);
    const night = skyLight('night', null, 0);
    expect(night.band).toBe('night');
    expect(night.direct?.kind).toBe('moon');
    // The night sky is seen blue.
    expect(night.layers[0]!.tint[2]).toBeGreaterThan(night.layers[0]!.tint[0]);
  });

  it('studio: an even bright dome, a soft key, a pale floor and no lawn', () => {
    const s = skyLight('studio', { azimuth: 90, altitude: 10 }, 0);
    expect(s.studio).toBeGreaterThan(0);
    expect(s.layers).toEqual([]);
    expect(s.ground.grass).toBe(false);
    expect(s.direct!.radius).toBeGreaterThan(0.1);
  });

  it('turns every direction by the site’s true north (Core 1.8)', () => {
    // True north 90° counter-clockwise of project north: a sun due true-south is at plan east.
    const v = placeVector({ azimuth: 180, altitude: 0 }, 90);
    expect(v[0]).toBeCloseTo(1, 9);
    expect(skyLight('clear', { azimuth: 180, altitude: 45 }, 90).direct!.dir[0]).toBeCloseTo(Math.SQRT1_2, 9);
  });
});

describe('the sun’s light', () => {
  it('is weaker and warmer as the sun is lower, and gone once it has set', () => {
    const noon = sunlight(80);
    const evening = sunlight(15);
    const setting = sunlight(1);
    expect(noon.lux).toBeGreaterThan(85_000);
    expect(noon.lux).toBeLessThan(110_000);
    expect(evening.lux).toBeGreaterThan(35_000);
    expect(evening.lux).toBeLessThan(65_000);
    expect(evening.color[0] / evening.color[2]).toBeGreaterThan(noon.color[0] / noon.color[2]);
    expect(setting.color[0] / setting.color[2]).toBeGreaterThan(evening.color[0] / evening.color[2]);
    expect(sunlight(-1).lux).toBe(0);
    // Its colour keeps a luminance of one.
    for (const s of [noon, evening, setting]) expect(0.2126 * s.color[0] + 0.7152 * s.color[1] + 0.0722 * s.color[2]).toBeCloseTo(1, 9);
    expect(airMass(90)).toBeCloseTo(1, 2);
    expect(airMass(0)).toBeGreaterThan(30);
  });
});

describe('the sky’s radiance and image-based light', () => {
  it('scales a map to its preset’s illuminance on a level surface', () => {
    const s = skyLight('overcast', { azimuth: 180, altitude: 40 }, 0);
    const f = skyField(s, maps);
    // An even map: the radiance straight up is the illuminance over π.
    const up = new Float64Array(3);
    skyRadiance(f, [0, 0, 1], up);
    expect(Math.abs((up[1]! * Math.PI) / s.layers[0]!.lux - 1)).toBeLessThan(0.01);
  });

  it('projects onto spherical harmonics as three.js reads them: an even sky lights every face to π L', () => {
    const f = skyField(skyLight('overcast', { azimuth: 180, altitude: 40 }, 0), maps);
    const sh = skyHarmonics(f);
    const out = new Float64Array(3);
    irradianceAt(sh, [0, 0, 1], out);
    const L = new Float64Array(3);
    skyRadiance(f, [0, 0, 1], L);
    // Up: the dome, a little less than π L (the ground below is darker and band-limited harmonics ring).
    expect(out[1]! / (Math.PI * L[1]!)).toBeGreaterThan(0.8);
    expect(out[1]! / (Math.PI * L[1]!)).toBeLessThan(1.1);
    // Down: the ground, far darker.
    irradianceAt(sh, [0, 0, -1], out);
    expect(out[1]!).toBeLessThan(0.3 * Math.PI * L[1]!);
  });

  it('below the horizon: the lawn far off, lost in the haze as it nears the horizon', () => {
    const f = skyField(skyLight('clear', null, 0), maps);
    const near = new Float64Array(3);
    const down = new Float64Array(3);
    skyRadiance(f, [0, Math.cos(0.002), -Math.sin(0.002)], near);
    skyRadiance(f, [0, 0, -1], down);
    near.forEach((c, k) => { expect(c).toBeCloseTo(f.horizon[k]!, 3); });
    down.forEach((c, k) => { expect(c).toBeCloseTo(f.ground[k]!, 3); });
    // The lawn is green.
    expect(f.ground[1]).toBeGreaterThan(f.ground[0]);
  });
});

describe('Radiance .hdr', () => {
  it('reads back what it writes, run-length encoded, to within RGBE’s precision', () => {
    const w = 40;
    const h = 3;
    const data = new Float32Array(w * h * 3);
    for (let i = 0; i < data.length; i++) data[i] = i % 7 === 0 ? 0 : 0.01 * (1 + (i % 13)) * (i % 5 === 0 ? 100 : 1);
    const back = decodeHdr(encodeHdr({ width: w, height: h, data }));
    expect([back.width, back.height]).toEqual([w, h]);
    for (let i = 0; i < data.length; i += 3) {
      const m = Math.max(data[i]!, data[i + 1]!, data[i + 2]!);
      for (let c = 0; c < 3; c++) expect(Math.abs(back.data[i + c]! - data[i + c]!)).toBeLessThanOrEqual(m / 100 + 1e-9);
    }
    expect(() => decodeHdr(new TextEncoder().encode('P6 2 2 255\n'))).toThrow(/Radiance/);
  });
});

describe('the lawn', () => {
  it('is a tile of GRASS_TILE metres, repeating at true scale, and a muted green', () => {
    const t = grassTexture();
    expect([t.width, t.height]).toEqual([GRASS_SIZE, GRASS_SIZE]);
    const a = new Float64Array(3);
    const b = new Float64Array(3);
    // The same texel a tile over, before the lawn's own variation across the site.
    lawnAt(1.3, 2.1, a);
    lawnAt(1.3 + GRASS_TILE, 2.1, b);
    const ratio = a[1]! / b[1]!;
    expect(ratio).toBeGreaterThan(0.75);
    expect(ratio).toBeLessThan(1.33);
    const mean = lawnAlbedo();
    expect(mean[1]).toBeGreaterThan(mean[0]);
    expect(mean[1]).toBeGreaterThan(mean[2]);
    const lum = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2];
    expect(lum).toBeGreaterThan(0.06);
    expect(lum).toBeLessThan(0.2);
  });

  it('has no stripes or bands: averaged along any line, the tile has no repeating swing across it, at every distance it is seen from (FLR-T-13.17)', () => {
    // Mowing stripes a metre wide along x, the same over the whole plane to the horizon, read from
    // above at dusk as diagonal bands. Lines along x, y and the diagonals, each averaged along its
    // whole repeat: across them the means have no strong harmonic — the lawn's variation is
    // lawnMacro's alone — at each footprint a view reads the tile with, from a pixel at your feet
    // to one on the far lawn. (With the stripes, lines along y swung 3.5% at the half-tile's harmonic.)
    const out = new Float64Array(3);
    const lum = (x: number, y: number, foot: number) => {
      lawnAt(x, y, out, foot);
      return (0.2126 * out[0]! + 0.7152 * out[1]! + 0.0722 * out[2]!) / lawnMacro(x, y);
    };
    const n = 512;
    const lines = 64;
    for (const foot of [0, 0.03, 0.12, 0.5])
      for (const [ax, ay, bx, by] of [[1, 0, 0, 1], [0, 1, 1, 0], [1, 1, -1, 1], [1, -1, 1, 1]] as const) {
        const means: number[] = [];
        const reach = ax !== 0 && ay !== 0 ? 2 * GRASS_TILE : GRASS_TILE;
        for (let i = 0; i < lines; i++) {
          const o = (i / lines) * GRASS_TILE;
          let sum = 0;
          for (let k = 0; k < n; k++) {
            const s = (k / n) * reach;
            sum += lum(o * bx + s * ax + 0.37, o * by + s * ay + 0.61, foot);
          }
          means.push(sum / n);
        }
        const avg = means.reduce((a, b) => a + b, 0) / lines;
        // The strongest harmonic across the lines, as a fraction of the mean: a stripe's amplitude.
        let swing = 0;
        for (let k = 1; k <= lines / 2; k++) {
          let re = 0;
          let im = 0;
          means.forEach((m, i) => {
            re += m * COS_OF((k * i) / lines);
            im += m * SIN_OF((k * i) / lines);
          });
          swing = Math.max(swing, (2 * Math.hypot(re, im)) / lines / avg);
        }
        expect(swing, `footprint ${String(foot)} m, along (${String(ax)}, ${String(ay)})`).toBeLessThan(0.015);
      }
  });

  it('blends between the tile\'s halvings as the footprint grows, with no step at any distance (FLR-T-13.17)', () => {
    const out = new Float64Array(3);
    const at = (foot: number) => {
      lawnAt(2.345, 7.891, out, foot);
      return out[1]!;
    };
    let worst = 0;
    for (let foot = 0.005; foot < 5; foot *= 1.02) worst = Math.max(worst, Math.abs(at(foot * 1.02) - at(foot)) / at(foot));
    expect(worst).toBeLessThan(0.05);
  });

  it('gives way where something is laid on the ground (FLR-T-13.5’s hook)', () => {
    const out = new Float64Array(3);
    const bed = { polygon: [[0, 0], [2, 0], [2, 2], [0, 2]] as [number, number][], rgb: [0.2, 0.1, 0.05] as [number, number, number] };
    groundAt(1, 1, [bed], out);
    expect([...out]).toEqual([0.2, 0.1, 0.05]);
    groundAt(3, 1, [bed], out);
    expect(out[1]).toBeGreaterThan(out[0]!);
  });
});
