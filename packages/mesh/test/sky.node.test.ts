 
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPOSURE_PER_NIT } from '../src/exposure.js';
import { NIGHT_SKY_EXPOSURE_MAX, SKY_MAP_FILES, SKY_MAP_IDS, skyExposure, skyField, skyIlluminance, skyLight, skyMapOf, skyRadiance, type SkyMaps } from '../src/sky/index.js';

/**
 * FLR-T-13.4, FLR-T-13.9: the sky maps as committed — the CC0 HDRIs prepared by
 * scripts/prepare-sky.ts — and the presets lit with them, calibrated in lux.
 */

const dir = new URL('../sky/', import.meta.url);
const bytes = (file: string) => new Uint8Array(readFileSync(new URL(file, dir)));
const sources = JSON.parse(readFileSync(new URL('SOURCES.json', dir), 'utf8')) as { licence: string; maps: { id: string; sha256: string; url: string; prepared: { file: string; sha256: string } }[] };
const maps: SkyMaps = Object.fromEntries(SKY_MAP_IDS.map((id) => [id, skyMapOf(id, bytes(SKY_MAP_FILES[id]))]));

describe('the sky maps', () => {
  it('are the prepared files SOURCES.json records, from CC0 originals', () => {
    expect(sources.licence).toMatch(/CC0/);
    expect(sources.maps.map((m) => m.id).sort()).toEqual([...SKY_MAP_IDS].sort());
    for (const m of sources.maps) {
      expect(m.url).toMatch(/^https:\/\/dl\.polyhaven\.org\//);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(createHash('sha256').update(bytes(m.prepared.file)).digest('hex')).toBe(m.prepared.sha256);
    }
  });

  it('are 2K skies from the zenith to 6° under the horizon, with their suns taken out', () => {
    for (const id of SKY_MAP_IDS) {
      const m = maps[id]!;
      expect(m.width).toBe(2048);
      expect(m.height).toBe(546);
      expect(m.illuminance).toBeGreaterThan(0);
      // No pixel left anywhere near the sun's thousands of times its sky.
      let max = 0;
      let sum = 0;
      for (let i = 0; i < m.width * m.height; i++) {
        const l = 0.2126 * m.data[3 * i]! + 0.7152 * m.data[3 * i + 1]! + 0.0722 * m.data[3 * i + 2]!;
        max = Math.max(max, l);
        sum += l;
      }
      // (A bright cloud edge or a star is a few hundred times the mean; the sun's disc was ten thousand.)
      expect(max / (sum / (m.width * m.height))).toBeLessThan(500);
    }
  });

  it('light a level surface as the presets are calibrated: a clear sky’s ten-odd thousand lux, dusk’s tens, night’s one', () => {
    const clear = skyIlluminance(skyLight('clear', { azimuth: 225, altitude: 35 }, 0), maps);
    expect(clear.sky).toBeGreaterThan(12_000);
    expect(clear.sky).toBeLessThan(20_000);
    expect(clear.direct).toBeGreaterThan(40_000);
    const overcast = skyIlluminance(skyLight('overcast', { azimuth: 225, altitude: 35 }, 0), maps);
    expect(overcast.direct).toBe(0);
    expect(overcast.sky).toBeGreaterThan(8_000);
    const dusk = skyIlluminance(skyLight('dusk', null, 0), maps);
    expect(dusk.sky).toBeGreaterThan(10);
    expect(dusk.sky).toBeLessThan(100);
    const night = skyIlluminance(skyLight('night', null, 0), maps);
    expect(night.sky).toBeLessThan(2);
  });

  it('glow where the sun is: the clear sky is brightest toward it, wherever it is placed', () => {
    for (const azimuth of [90, 200, 290]) {
      const f = skyField(skyLight('clear', { azimuth, altitude: 48 }, 0), maps);
      const L = new Float64Array(3);
      let best = -1;
      let at = 0;
      for (let a = 0; a < 360; a += 5) {
        const r = (a * Math.PI) / 180;
        const e = (40 * Math.PI) / 180;
        skyRadiance(f, [Math.sin(r) * Math.cos(e), Math.cos(r) * Math.cos(e), Math.sin(e)], L);
        if (L[1]! > best) {
          best = L[1]!;
          at = a;
        }
      }
      expect(Math.abs(((at - azimuth + 540) % 360) - 180)).toBeLessThan(25);
    }
  });

  it('is exposed for within FLR-T-13.1’s bands: by day the day band, after dark up to a moonlit night’s', () => {
    for (const altitude of [5, 20, 60]) {
      const e = skyExposure(skyLight('clear', { azimuth: 200, altitude }, 0), maps);
      expect(e).toBeGreaterThanOrEqual(EXPOSURE_PER_NIT.day);
      expect(e).toBeLessThanOrEqual(EXPOSURE_PER_NIT.dayMax);
    }
    const night = skyExposure(skyLight('night', null, 0), maps);
    expect(night).toBeGreaterThanOrEqual(EXPOSURE_PER_NIT.night);
    expect(night).toBeLessThanOrEqual(NIGHT_SKY_EXPOSURE_MAX);
  });
});
