/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { describe, expect, it } from 'vitest';
import { clockAt, formatDate, formatOffset, formatTime, formatTimeShort, instantOfClock, midnightOf, summaryOf, type Clock } from '../src/editor/three/sun/clock';
import { compassPoint, julianDay, refraction, seasonInstant, sunAt, sunAtJulian, sunCoordinates, sunDay, sunVector } from '../src/editor/three/sun/solar';
import { dayOf, shadowMapSize, studyOf, type Site } from '../src/editor/three/sun/study';
import { formatDegrees, parseDegrees } from '../src/editor/three/sun/degrees';

/**
 * FLR-T-8.6: the sun and shadow study's arithmetic. The solar position is held to published
 * reference values — Meeus's worked examples and NREL's SPA paper — within 0.1° (in practice it is
 * within a few thousandths); the sun's direction is turned into the project's frame by the site's
 * true north (Core 1.8: from project north, +Y, to true north, counter-clockwise positive).
 */

const MIN = 60_000;

describe('the solar position (NOAA / Meeus low accuracy), against published values', () => {
  it('Julian day: Meeus, Astronomical Algorithms, example 7.a — 1957 October 4.81 is JD 2436116.31', () => {
    expect(julianDay(Date.UTC(1957, 9, 4) + 0.81 * 86_400_000)).toBeCloseTo(2_436_116.31, 6);
  });

  it("the sun's apparent place: Meeus example 25.a — 1992 October 13.0 TD, λ 199.90895°, δ −7.78507°", () => {
    const c = sunCoordinates(2_448_908.5);
    expect(Math.abs(c.longitude - 199.90895)).toBeLessThan(0.0005);
    expect(Math.abs(c.declination - -7.78507)).toBeLessThan(0.0005);
  });

  it('the equation of time: Meeus example 28.b — 1992 October 13.0, +13 min 42.6 s by formula 28.3', () => {
    expect(Math.abs(sunCoordinates(2_448_908.5).equationOfTime - (13 + 42.6 / 60))).toBeLessThan(0.02);
  });

  it('NREL SPA (Reda & Andreas 2004), its worked example: Golden, CO, 2003-10-17 12:30:30 at UTC−7 — zenith 50.11162°, azimuth 194.34024°', () => {
    const p = sunAt(Date.UTC(2003, 9, 17, 19, 30, 30), 39.742476, -105.1786);
    // The requirement is 0.1°; the algorithm does better, and the test says so.
    expect(Math.abs(90 - p.altitude - 50.11162)).toBeLessThan(0.02);
    expect(Math.abs(p.azimuth - 194.34024)).toBeLessThan(0.02);
    expect(Math.abs(90 - p.altitude - 50.11162)).toBeLessThan(0.1);
    expect(Math.abs(p.azimuth - 194.34024)).toBeLessThan(0.1);
  });

  it('the same example: sunrise 06:12:43 and transit 11:46:04 local, within a minute', () => {
    const day = sunDay(Date.UTC(2003, 9, 17, 7), 39.742476, -105.1786);
    expect(Math.abs(day.sunrise! - Date.UTC(2003, 9, 17, 13, 12, 43))).toBeLessThan(MIN);
    expect(Math.abs(day.noon - Date.UTC(2003, 9, 17, 18, 46, 4))).toBeLessThan(MIN);
    expect(day.sunset).not.toBeNull();
    expect(day.always).toBeNull();
  });

  it("the 2026 equinoxes and solstices, against the U.S. Naval Observatory's times, within a quarter-hour", () => {
    const usno: [Parameters<typeof seasonInstant>[1], number][] = [
      ['march', Date.UTC(2026, 2, 20, 14, 46)],
      ['june', Date.UTC(2026, 5, 21, 8, 24)],
      ['september', Date.UTC(2026, 8, 23, 0, 5)],
      ['december', Date.UTC(2026, 11, 21, 20, 50)],
    ];
    for (const [season, at] of usno) expect(Math.abs(seasonInstant(2026, season) - at), season).toBeLessThan(15 * MIN);
  });

  it('at the June solstice, the noon sun in Sydney is due north at 90° − (33.87° + 23.44°)', () => {
    const solstice = seasonInstant(2026, 'june');
    const day = sunDay(solstice - 12 * 3_600_000, -33.8688, 151.2093);
    const p = sunAt(day.noon, -33.8688, 151.2093);
    expect(Math.abs(p.geometric - (90 - 33.8688 - 23.4365))).toBeLessThan(0.05);
    expect(Math.min(p.azimuth, 360 - p.azimuth)).toBeLessThan(0.5);
  });

  it('morning is east and afternoon west; the hour angle changes sign at solar noon', () => {
    const am = sunAt(Date.UTC(2026, 9, 4, 13), 42.3601, -71.0589); // 9 am EDT
    const pm = sunAt(Date.UTC(2026, 9, 4, 20), 42.3601, -71.0589); // 4 pm EDT
    expect(compassPoint(am.azimuth)).toBe('south-east');
    expect(compassPoint(pm.azimuth)).toBe('south-west');
    expect(am.hourAngle).toBeLessThan(0);
    expect(pm.hourAngle).toBeGreaterThan(0);
  });

  it('refraction lifts the sun at the horizon by about half a degree and not at all overhead', () => {
    expect(refraction(0)).toBeCloseTo(1735 / 3600, 6);
    expect(refraction(89)).toBe(0);
    expect(refraction(30)).toBeGreaterThan(0.02);
    expect(refraction(30)).toBeLessThan(0.03);
  });

  it('is well defined at the poles and with the sun overhead', () => {
    const p = sunAtJulian(2_461_213, 90, 0);
    expect(Number.isFinite(p.azimuth)).toBe(true);
    expect(Number.isFinite(p.altitude)).toBe(true);
  });

  it('knows polar day and polar night', () => {
    const june = Date.UTC(2026, 5, 21);
    expect(sunDay(june, 80, 15).always).toBe('up');
    expect(sunDay(june, -80, 15).always).toBe('down');
  });
});

describe('the sun in the project frame: true north', () => {
  const close = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) < 1e-12);

  it('with true north up the plan, east is +x, south −y, and the zenith +z', () => {
    expect(close(sunVector(90, 0, 0), [1, 0, 0])).toBe(true);
    expect(close(sunVector(180, 0, 0), [0, -1, 0])).toBe(true);
    expect(close(sunVector(0, 90, 0), [0, 0, 1])).toBe(true);
  });

  it('true north 90° anticlockwise of the plan’s up puts the north sun on −x and the east sun on +y', () => {
    expect(close(sunVector(0, 0, 90), [-1, 0, 0])).toBe(true);
    expect(close(sunVector(90, 0, 90), [0, 1, 0])).toBe(true);
  });

  it("the starter house's −12.5°: true north is 12.5° clockwise of +Y", () => {
    const [x, y, z] = sunVector(0, 0, -12.5);
    expect(x).toBeCloseTo(Math.sin((12.5 * Math.PI) / 180), 12);
    expect(y).toBeCloseTo(Math.cos((12.5 * Math.PI) / 180), 12);
    expect(z).toBe(0);
  });

  it('is a unit vector, with altitude its elevation', () => {
    const v = sunVector(214, 32, -12.5);
    expect(Math.hypot(...v)).toBeCloseTo(1, 12);
    expect((Math.asin(v[2]) * 180) / Math.PI).toBeCloseTo(32, 10);
  });
});

describe('the study: a site and a clock', () => {
  const boston: Site = { latitude: 42.3601, longitude: -71.0589, trueNorth: -12.5, present: true };
  const clock: Clock = { date: '2026-10-04', minutes: 15 * 60, offset: -240 };

  it('reads the clock at the site in its offset', () => {
    expect(instantOfClock(clock)).toBe(Date.UTC(2026, 9, 4, 19));
    expect(midnightOf(clock)).toBe(Date.UTC(2026, 9, 4, 4));
    expect(clockAt(Date.UTC(2026, 9, 4, 19), -240)).toEqual({ date: '2026-10-04', minutes: 900 });
    expect(clockAt(Date.UTC(2026, 9, 5, 2, 30), -240)).toEqual({ date: '2026-10-04', minutes: 22 * 60 + 30 });
  });

  it('places the sun and turns it by true north', () => {
    const s = studyOf(boston, clock)!;
    const p = sunAt(Date.UTC(2026, 9, 4, 19), 42.3601, -71.0589);
    expect(s.position.azimuth).toBeCloseTo(p.azimuth, 12);
    expect(s.vector).toEqual(sunVector(p.azimuth, p.altitude, -12.5));
    expect(s.night).toBe(false);
    expect(s.daylight).toBe(1);
  });

  it('is night after sunset, with no daylight', () => {
    const s = studyOf(boston, { ...clock, minutes: 22 * 60 })!;
    expect(s.night).toBe(true);
    expect(s.daylight).toBe(0);
    expect(s.position.altitude).toBeLessThan(0);
  });

  it('has nothing to place without a location', () => {
    expect(studyOf({ latitude: null, longitude: null, trueNorth: 0, present: false }, clock)).toBeNull();
    expect(dayOf({ latitude: null, longitude: null, trueNorth: 0, present: false }, clock)).toBeNull();
  });

  it("gives the day's sunrise, noon and sunset in order", () => {
    const d = dayOf(boston, clock)!;
    expect(d.sunrise!).toBeLessThan(d.noon);
    expect(d.noon).toBeLessThan(d.sunset!);
    // Boston on 4 October: sunrise about 6:46 am and sunset about 6:24 pm EDT.
    expect(Math.abs(clockAt(d.sunrise!, -240).minutes - (6 * 60 + 46))).toBeLessThan(5);
    expect(Math.abs(clockAt(d.sunset!, -240).minutes - (18 * 60 + 24))).toBeLessThan(5);
  });

  it('sizes the shadow map to the house: about 2 cm a texel, 1024 to 4096, halved in the split view', () => {
    expect(shadowMapSize(5, { compact: false, max: 16384 })).toBe(1024);
    expect(shadowMapSize(15, { compact: false, max: 16384 })).toBe(2048);
    expect(shadowMapSize(30, { compact: false, max: 16384 })).toBe(4096);
    expect(shadowMapSize(300, { compact: false, max: 16384 })).toBe(4096);
    expect(shadowMapSize(30, { compact: true, max: 16384 })).toBe(2048);
    expect(shadowMapSize(30, { compact: false, max: 2048 })).toBe(2048);
  });
});

describe('words and fields', () => {
  it('formats the clock as the board does', () => {
    expect(formatTime(900)).toBe('3:00 pm');
    expect(formatTime(0)).toBe('12:00 am');
    expect(formatTime(735)).toBe('12:15 pm');
    expect(formatTimeShort(900)).toBe('3 pm');
    expect(formatTimeShort(915)).toBe('3:15 pm');
    expect(formatDate('2026-10-04')).toBe('Oct 4');
    expect(formatOffset(-240)).toBe('UTC−04:00');
    expect(formatOffset(330)).toBe('UTC+05:30');
    expect(formatOffset(0)).toBe('UTC');
    expect(summaryOf({ date: '2026-10-04', minutes: 900, offset: 'auto' })).toBe('Sun · Oct 4 · 3 pm');
  });

  it('reads degrees as a person types them, into whole microdegrees within Core 1.8’s ranges', () => {
    expect(parseDegrees('42.3601', 'latitude')).toEqual({ value: 42_360_100 });
    expect(parseDegrees('42.36° N', 'latitude')).toEqual({ value: 42_360_000 });
    expect(parseDegrees('33.87 S', 'latitude')).toEqual({ value: -33_870_000 });
    expect(parseDegrees('71.0589 W', 'longitude')).toEqual({ value: -71_058_900 });
    expect(parseDegrees('-71.0589', 'longitude')).toEqual({ value: -71_058_900 });
    expect(parseDegrees('−12.5', 'north')).toEqual({ value: -12_500_000 });
    expect(parseDegrees('180', 'longitude')).toEqual({ value: 180_000_000 });
    expect(parseDegrees('-180', 'longitude')).toHaveProperty('error');
    expect(parseDegrees('-180', 'north')).toHaveProperty('error');
    expect(parseDegrees('90.5', 'latitude')).toHaveProperty('error');
    expect(parseDegrees('42 E', 'latitude')).toHaveProperty('error');
    expect(parseDegrees('12 N', 'north')).toHaveProperty('error');
    expect(parseDegrees('north-ish', 'latitude')).toHaveProperty('error');
  });

  it('writes degrees back the way it reads them', () => {
    expect(formatDegrees(42.3601, 'latitude')).toBe('42.3601° N');
    expect(formatDegrees(-71.0589, 'longitude')).toBe('71.0589° W');
    expect(formatDegrees(-12.5, 'north')).toBe('-12.5°');
    for (const [v, axis] of [[42.3601, 'latitude'], [-71.0589, 'longitude'], [-12.5, 'north']] as const) {
      expect(parseDegrees(formatDegrees(v, axis), axis)).toEqual({ value: Math.round(v * 1e6) });
    }
  });
});
