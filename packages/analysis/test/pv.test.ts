import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FloorspecDocument } from '@floorspec/engine';
import { CLEARNESS, DAYS_IN_MONTH, estimateSolar, MONTH_DAYS, monthSky, normalOf, occludersOf, PERFORMANCE_RATIO, planeYear, PV_ADVISORY, pvRange, yearSky, beamReaching } from '../src/index.js';

/**
 * FLR-T-16.1: the solar production estimate. A hand-checked day — the extraterrestrial irradiation on the
 * equator at the March equinox, and its quarter hours summing to the day — the faces in their order, the
 * shade of a wall in front of a point, the Courtyard House's arrays, and every figure a range with its
 * method, the same every time.
 */

const courtyard = JSON.parse(readFileSync(new URL('../../../apps/worker/test/fixtures/courtyard-house-solar.json', import.meta.url), 'utf8')) as FloorspecDocument;
const RAD = Math.PI / 180;
const site = (latitude: number, clearness = CLEARNESS.A) => ({ latitude, latitudeSource: 'site' as const, trueNorth: 0, zone: '3A', zoneSource: 'yours' as const, clearness });

describe('the sky of a month', () => {
  it('works the March day on the equator by hand: H0 = 24/π · 1.367 · (1 + 0.033 cos(2π·75/365)) · cos δ sin ωs, and K·H0 on the ground', () => {
    const n = MONTH_DAYS[2]!;
    expect(n).toBe(75);
    const delta = 23.45 * Math.sin((360 * (284 + n) / 365) * RAD) * RAD;
    const h0 = (24 / Math.PI) * 1.367 * (1 + 0.033 * Math.cos((2 * Math.PI * n) / 365)) * Math.cos(delta) * 1; // ωs = 90° on the equator
    const m = monthSky(0, 2, 0.5);
    expect(m.H).toBeCloseTo(0.5 * h0, 6);
    expect(h0).toBeGreaterThan(10.3);
    expect(h0).toBeLessThan(10.6);
    // the Collares-Pereira–Rabl hours sum to the day, within the quarter-hour sampling
    const sum = m.steps.reduce((s, x) => s + x.global, 0);
    expect(Math.abs(sum - m.H) / m.H).toBeLessThan(0.02);
    expect(m.days).toBe(DAYS_IN_MONTH[2]);
  });

  it('puts more on a south face than a flat one than a north one in the northern hemisphere, and June over December', () => {
    const sky = yearSky(site(33.75));
    const year = (tilt: number, bearing: number) => planeYear(sky, normalOf(tilt, bearing), [], null, 33.75).monthly;
    const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const south = year(25, 180);
    expect(total(south)).toBeGreaterThan(total(year(0, 0)));
    expect(total(year(0, 0))).toBeGreaterThan(total(year(25, 0)));
    expect(year(0, 0)[5]!).toBeGreaterThan(year(0, 0)[11]! * 2);
    // a kW facing south at 25° in Atlanta: about 1,300–1,500 kWh a year after the performance ratio
    expect(total(south) * PERFORMANCE_RATIO).toBeGreaterThan(1250);
    expect(total(south) * PERFORMANCE_RATIO).toBeLessThan(1550);
  });
});

describe('shade', () => {
  it('stops the beam behind a wall and lets some through a crown', () => {
    const occ = occludersOf(courtyard);
    // straight up from the middle of the courtyard is clear
    expect(beamReaching(occ, [20 / 3.28, 40 / 3.28, 1], [0, 0, 1], 5, 33.75)).toBe(1);
    // looking east from just west of the east wing, low: its wall is in the way
    expect(beamReaching(occ, [9, 10, 1], [1, 0, 0.05], 5, 33.75)).toBe(0);
  });
});

describe('the Courtyard House’s arrays', () => {
  it('estimates each array’s year as a range around it, with its method and never a guarantee', () => {
    const e = estimateSolar(courtyard);
    expect(e.advisory).toBe(PV_ADVISORY);
    expect(e.site.latitudeSource).toBe('site');
    expect(e.arrays.map((a) => a.id)).toEqual(['PV1', 'PV2']);
    for (const a of e.arrays) {
      expect(pvRange(a.annual)).toEqual({ low: a.low, high: a.high });
      expect(a.low).toBeCloseTo(a.annual * 0.8, -3);
    }
    expect(e.total.annual).toBeCloseTo(e.arrays[0]!.annual + e.arrays[1]!.annual, 6);
    expect(e.assumptions.join(' ')).not.toMatch(/compliant/i);
    expect(JSON.stringify(estimateSolar(courtyard))).toBe(JSON.stringify(e));
  });

  it('loses more of the north-facing guest wing’s year to shade than of the east wing’s', () => {
    const [east, guest] = estimateSolar(courtyard).arrays;
    expect(guest!.shade).toBeGreaterThan(east!.shade);
    expect(estimateSolar(courtyard, { shade: false }).arrays[1]!.annual).toBeGreaterThan(guest!.annual);
  });
});
