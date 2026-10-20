/** FLR-T-14.7: the daylight bands, the hours, the desks and beds a glare flag is pinned to, and the words. */
import { describe, expect, test } from 'vitest';
import {
  bandOf,
  bandShares,
  DAYLIGHT_BANDS,
  describeDaylight,
  glareText,
  glareZones,
  hourRanges,
  median,
  rangeText,
  SUN_BANDS,
  sunBandOf,
  WORK_PLANE,
  YEAR_DAYS,
  type DaylightStudy,
} from '../src/index.js';

describe('the four bands', () => {
  test('dim under 100 lx, a lamp 100–300, useful 300–3,000, bright over 3,000', () => {
    expect([0, 99.9, 100, 299, 300, 1000, 3000, 3000.1, 80_000].map(bandOf)).toEqual(['dim', 'dim', 'lamp', 'lamp', 'useful', 'useful', 'useful', 'bright', 'bright']);
  });

  test('the legend reads brightest first, each band with a name and a range, and the ranges meet', () => {
    expect(DAYLIGHT_BANDS.map((b) => b.label)).toEqual(['Bright — glare likely', 'Useful daylight', 'Needs a lamp for tasks', 'Dim']);
    for (let i = 0; i + 1 < DAYLIGHT_BANDS.length; i++) expect(DAYLIGHT_BANDS[i]!.min).toBe(DAYLIGHT_BANDS[i + 1]!.max);
    for (const b of DAYLIGHT_BANDS) expect(b.range).toMatch(/lx$/);
  });

  test('sun-hours in a year in four bands too', () => {
    expect([0, 0.5, 1, 249, 250, 1000, 1001].map(sunBandOf)).toEqual(['none', 'none', 'little', 'little', 'some', 'some', 'lots']);
    expect(SUN_BANDS).toHaveLength(4);
  });

  test('shares by band and the median', () => {
    expect(bandShares([50, 150, 500, 5000])).toEqual({ dim: 0.25, lamp: 0.25, useful: 0.25, bright: 0.25 });
    expect(bandShares([])).toEqual({ dim: 0, lamp: 0, useful: 0, bright: 0 });
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  test('the work plane is 2′-6″', () => {
    expect(WORK_PLANE).toBeCloseTo(30 * 0.0254, 6);
  });

  test('the year is the 21st of each month, standing for 365 days', () => {
    expect(YEAR_DAYS).toHaveLength(12);
    expect(YEAR_DAYS.reduce((s, d) => s + d.days, 0)).toBe(365);
  });
});

describe('hours', () => {
  test('ten-minute moments merge into ranges where they touch', () => {
    expect(hourRanges([15 * 60 + 10, 15 * 60 + 20, 15 * 60 + 30, 16 * 60 + 30, 7 * 60])).toEqual([
      { from: 7 * 60, to: 7 * 60 + 10 },
      { from: 15 * 60 + 10, to: 15 * 60 + 40 },
      { from: 16 * 60 + 30, to: 16 * 60 + 40 },
    ]);
    expect(hourRanges([])).toEqual([]);
  });

  test('as the board writes them', () => {
    expect(rangeText({ from: 15 * 60 + 10, to: 16 * 60 + 40 })).toBe('3:10–4:40 pm');
    expect(rangeText({ from: 6 * 60 + 50, to: 7 * 60 + 30 })).toBe('6:50–7:30 am');
    expect(rangeText({ from: 11 * 60 + 50, to: 12 * 60 + 30 })).toBe('11:50 am–12:30 pm');
    const flag = { id: 'D', name: 'Desk', kind: 'desk' as const, level: 'L1', at: [0, 0] as const, z: 0.75, hours: [{ from: 14 * 60, to: 15 * 60 + 30 }], now: true, low: true };
    expect(glareText(flag, 'Den')).toBe('Den desk · low sun 2:00–3:30 pm');
    expect(glareText({ ...flag, low: false })).toBe('Desk · sun 2:00–3:30 pm');
  });
});

describe('glare zones', () => {
  const M = 1_280_000;
  const piece = (category: string, rotation: number, box: { min: number[]; max: number[] }) => ({
    category,
    name: category === 'bed' ? 'Queen bed' : 'Desk',
    fallback: { box, level: 'L1' },
    host: { mode: 'surface', surface: 'floor', room: 'R1', position: [2 * M, 3 * M], rotation: rotation * 1e6 },
  });
  const doc = (pieces: Record<string, unknown>) => ({ extensions: { FS_furniture: { collections: { pieces } } } });

  test("a desk's whole top, 5 cm in from its edges, at its height", () => {
    const [z] = glareZones(doc({ D: piece('desk', 0, { min: [0, -0.6 * M, 0], max: [0.75 * M, 0.6 * M, 0.75 * M] }) }));
    expect(z!.kind).toBe('desk');
    expect(z!.height).toBeCloseTo(0.75, 6);
    const xs = z!.corners.map((c) => c[0]);
    const ys = z!.corners.map((c) => c[1]);
    expect(Math.min(...xs)).toBeCloseTo(2.05, 6);
    expect(Math.max(...xs)).toBeCloseTo(2.7, 6);
    expect(Math.min(...ys)).toBeCloseTo(2.45, 6);
    expect(Math.max(...ys)).toBeCloseTo(3.55, 6);
  });

  test("a bed's pillow end: 60 cm from its head, turned with it, at the mattress", () => {
    // Turned 90°: the bed's +x (head to foot) points north.
    const [z] = glareZones(doc({ B: piece('bed', 90, { min: [0, -0.8 * M, 0], max: [2.05 * M, 0.8 * M, 1.0 * M] }) }));
    expect(z!.kind).toBe('bed');
    expect(z!.height).toBeCloseTo(0.55, 6);
    const xs = z!.corners.map((c) => c[0]);
    const ys = z!.corners.map((c) => c[1]);
    expect(Math.min(...ys)).toBeCloseTo(3, 6);
    expect(Math.max(...ys)).toBeCloseTo(3.6, 6);
    expect(Math.min(...xs)).toBeCloseTo(1.3, 6);
    expect(Math.max(...xs)).toBeCloseTo(2.7, 6);
  });

  test('other furniture, and pieces with no place, are not zones', () => {
    expect(glareZones(doc({ S: piece('sofa', 0, { min: [0, 0, 0], max: [M, M, M] }), X: { category: 'desk' } }))).toEqual([]);
    expect(glareZones(null)).toEqual([]);
  });
});

describe('in words', () => {
  const study: DaylightStudy = {
    at: '2026-06-21T15:00',
    offset: -240,
    sky: 'clear',
    sun: { azimuth: 250, altitude: 52 },
    site: { latitude: 33.7, longitude: -84.4, assumed: false },
    outside: { sky: 20_000, sun: 70_000 },
    workPlane: WORK_PLANE,
    spacing: 0.3048,
    samples: 64,
    levels: [],
    rooms: [{ id: 'R6', name: 'Den', level: 'L1', cells: 100, median: 540, mean: 900, shares: { bright: 0.1, useful: 0.62, lamp: 0.2, dim: 0.08 }, sunToday: 5.2, sunYear: 1140 }],
    glare: [{ id: 'DEN-DESK', name: 'Desk', kind: 'desk', room: 'R6', roomName: 'Den', level: 'L1', at: [0, 0], z: 0.75, hours: [{ from: 15 * 60 + 10, to: 16 * 60 + 40 }], now: false, low: false }],
    advisory: 'Advisory, not a compliance check.',
    ms: 1,
  };

  test('when, the rooms in bands, the glare, and that it is advisory — never "compliant"', () => {
    const text = describeDaylight(study);
    expect(text).toContain('2026-06-21 at 3:00 pm');
    expect(text).toContain('Advisory, not a compliance check.');
    expect(text).toContain('Den (R6, L1): median 540 lx; 10 % bright — glare likely, 62 % useful daylight');
    expect(text).toContain('1,140 h a year');
    expect(text).toContain('Glare: Desk (DEN-DESK, Den) — sun 3:10–4:40 pm');
    expect(text.toLowerCase()).not.toMatch(/\bcompliant\b/);
  });

  test('one room by ID or by name', () => {
    expect(describeDaylight(study, ['Den'])).toContain('Den (R6');
    expect(describeDaylight(study, ['R1'])).not.toContain('Den (R6');
  });
});
