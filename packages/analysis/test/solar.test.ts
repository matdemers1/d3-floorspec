/** The clear-sky sun against what its geometry has to be. */
import { describe, expect, test } from 'vitest';
import { clearSky, dailyVertical, declination, JANUARY_21, JULY_21, sunAt, TAU, verticalAt } from '../src/index.js';
import { range, plain, sig2, loadRange } from '../src/index.js';

describe('the sun', () => {
  test('declination: about +20.4° on July 21 and −20.1° on January 21', () => {
    expect(declination(JULY_21)).toBeCloseTo(20.4, 0);
    expect(declination(JANUARY_21)).toBeCloseTo(-20.1, 0);
  });

  test('at solar noon it is due south at 90 − latitude + declination', () => {
    const s = sunAt(40, JULY_21, 12);
    expect(s.azimuth).toBeCloseTo(180, 6);
    expect(s.altitude).toBeCloseTo(90 - 40 + declination(JULY_21), 6);
  });

  test('morning sun is in the east, afternoon sun in the west, symmetric about noon', () => {
    const am = sunAt(40, JULY_21, 9);
    const pm = sunAt(40, JULY_21, 15);
    expect(am.azimuth).toBeLessThan(180);
    expect(pm.azimuth).toBeGreaterThan(180);
    expect(am.azimuth + pm.azimuth).toBeCloseTo(360, 6);
    expect(am.altitude).toBeCloseTo(pm.altitude, 6);
  });

  test('a clear July noon: beam about 750 W/m², diffuse about 200 (a humid summer sky)', () => {
    const s = sunAt(40, JULY_21, 12);
    const sky = clearSky(s.altitude, JULY_21, TAU.july);
    expect(sky.beam).toBeGreaterThan(650);
    expect(sky.beam).toBeLessThan(900);
    expect(sky.diffuse).toBeGreaterThan(150);
    expect(sky.diffuse).toBeLessThan(260);
    expect(clearSky(-5, JULY_21, TAU.july)).toEqual({ beam: 0, diffuse: 0 });
  });

  test('south glass takes more sun in January than in July; west takes the afternoon', () => {
    expect(dailyVertical(40, JANUARY_21, 180, TAU.january)).toBeGreaterThan(dailyVertical(40, JULY_21, 180, TAU.july));
    expect(verticalAt(40, JULY_21, 16, 270, TAU.july)).toBeGreaterThan(3 * verticalAt(40, JULY_21, 16, 90, TAU.july));
    expect(dailyVertical(40, JULY_21, 270, TAU.july)).toBeCloseTo(dailyVertical(40, JULY_21, 90, TAU.july), 6);
  });
});

describe('honest rounding', () => {
  test('two significant figures, ranges ±20%', () => {
    expect(sig2(31_416)).toBe(31_000);
    expect(sig2(0.0123)).toBeCloseTo(0.012, 12);
    expect(plain(9.4)).toBe('9.4');
    expect(plain(14.4)).toBe('14');
    expect(plain(1234)).toBe('1,200');
    expect(range(10).text).toBe('8–12');
    // 7 kW is 23.9 kBtu/h: 19–29.
    expect(loadRange(7000, 'imperial')).toEqual({ text: '19–29', unit: 'kBtu/h' });
    expect(loadRange(7000, 'metric')).toEqual({ text: '5.6–8.4', unit: 'kW' });
  });
});
