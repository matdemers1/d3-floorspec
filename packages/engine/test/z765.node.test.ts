/**
 * The ANSI Z765-2021 house-area measure (FLR-T-7.6) — a D3 Floorspec application measure, not part
 * of the standard. Tested on the app's template (the three-room house) and on a two-storey house
 * built to exercise each part of the method as src/measures/z765.ts paraphrases it: exterior
 * dimensions, a garage left out, a stair counted on the level it descends from, an opening to the
 * floor below left out, a vaulted room cut back where it is under 5 ft, a flat ceiling under 7 ft,
 * and a level below grade reported apart.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, FOOT, z765 } from '../src/index.js';

const SQ_FT = FOOT * FOOT;
/** Square feet, rounded half to even, from an exact area in square base units. */
const sqft = (a: bigint): number => {
  const q = a / SQ_FT;
  const r = a % SQ_FT;
  return Number(2n * r > SQ_FT || (2n * r === SQ_FT && q % 2n === 1n) ? q + 1n : q);
};

describe('Z765 on the app templates', () => {
  const template = readFileSync(join(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'src', 'projects', 'templates', 'three-room-house.floorspec.json'), 'utf8');

  it('measures the three-room house to the outside of its siding: 876 sq ft finished above grade', () => {
    const r = z765(template);
    // The core faces of the exterior walls are a 36 ft × 24 ft rectangle; siding (24,384) and OSB
    // (14,224) lie outside them, so the exterior outline is 38,608 base units larger on every side.
    const area = (14_045_184n + 2n * 38_608n) * (9_363_456n + 2n * 38_608n);
    expect(r.method).toContain('ANSI Z765-2021');
    expect(r.buildings).toEqual([
      {
        building: 'HOUSE',
        aboveGradeSqFt: 876,
        belowGradeSqFt: 0,
        levels: [
          { level: 'MAIN', aboveGrade: true, grossSqFt: 876, unfinishedSqFt: 0, lowCeilingSqFt: 0, openToBelowSqFt: 0, finishedArea: Number(area), finishedSqFt: sqft(area), excluded: [] },
        ],
      },
    ]);
    expect(sqft(area)).toBe(876);
  });

  it('is the same house as the conformance example it was made from', () => {
    const example = readFileSync(join(import.meta.dirname, '..', 'standard', 'conformance', 'core', '0.1', 'examples', '001-three-room-house', 'input.json'), 'utf8');
    expect(z765(example).buildings[0]!.aboveGradeSqFt).toBe(876);
  });
});

// ── a two-storey house ─────────────────────────────────────────────────────────

const W = 12_800_000;
const H = 10_240_000;
const X = 8_960_000; // the interior wall between the west and east rooms
const T = 128_000; // every wall: one 100 mm core layer, centred

function storey(level: string, p: string, extra: { holes?: [number, number, number, number][] } = {}): { junctions: Record<string, unknown>; walls: Record<string, unknown> } {
  const junctions: Record<string, unknown> = {};
  const walls: Record<string, unknown> = {};
  const j = (id: string, x: number, y: number): void => {
    junctions[`${p}${id}`] = { level, position: [x, y] };
  };
  const w = (id: string, a: string, b: string): void => {
    walls[`${p}${id}`] = { level, start: `${p}${a}`, end: `${p}${b}`, layers: [{ thickness: T, function: 'core' }] };
  };
  j('1', 0, 0);
  j('2', 0, H);
  j('3', W, H);
  j('4', W, 0);
  j('5', X, H);
  j('6', X, 0);
  w('a', '1', '2');
  w('b', '2', '5');
  w('c', '5', '3');
  w('d', '3', '4');
  w('e', '4', '6');
  w('f', '6', '1');
  w('g', '5', '6');
  (extra.holes ?? []).forEach(([x0, y0, x1, y1], i) => {
    const k = `h${i}`;
    j(`${k}1`, x0, y0);
    j(`${k}2`, x0, y1);
    j(`${k}3`, x1, y1);
    j(`${k}4`, x1, y0);
    w(`${k}a`, `${k}1`, `${k}2`);
    w(`${k}b`, `${k}2`, `${k}3`);
    w(`${k}c`, `${k}3`, `${k}4`);
    w(`${k}d`, `${k}4`, `${k}1`);
  });
  return { junctions, walls };
}

function twoStorey(): Record<string, unknown> {
  const lower = storey('L1', 'D');
  // Upstairs: the stair's well (its head lands in it), and an opening to below with no stair.
  const upper = storey('L2', 'U', { holes: [[1_500_000, 900_000, 6_500_000, 2_100_000], [1_500_000, 6_000_000, 3_500_000, 8_000_000]] });
  return {
    floorspec: '0.3',
    project: { name: 'Two storeys' },
    buildings: { B1: {} },
    levels: { L1: { building: 'B1', elevation: 0, height: 3_456_000 }, L2: { building: 'B1', elevation: 3_840_000, height: 3_600_000 } },
    junctions: { ...lower.junctions, ...upper.junctions },
    walls: { ...lower.walls, ...upper.walls },
    rooms: {
      LIV: { level: 'L1', anchor: [4_000_000, 5_000_000], function: 'living' },
      GAR: { level: 'L1', anchor: [10_000_000, 5_000_000], function: 'garage' },
      BED: { level: 'L2', anchor: [6_000_000, 5_000_000], function: 'sleeping' },
      // A vault along the east room's middle, 12:12: 5 ft high 1,649,280 either side of the ridge.
      ATT: { level: 'L2', anchor: [10_000_000, 5_000_000], function: 'storage', ceiling: { kind: 'vaulted', ridge: [[10_880_000, 0], [10_880_000, H]], pitch: { rise: 12, run: 12 } } },
    },
    stairs: { ST1: { level: 'L1', to: 'L2', position: [2_000_000, 1_500_000], width: 900_000, tread: 250_000, risers: 16 } },
  };
}

describe('Z765 on a two-storey house', () => {
  const d = twoStorey();

  it('is a valid document whose stair rises into its well', () => {
    const r = check(d);
    expect(r.valid, JSON.stringify(r.diagnostics)).toBe(true);
    expect(r.derived!.stairs!.ST1!.head).toEqual([5_750_000, 1_500_000]);
    expect(r.derived!.stairs!.ST1!.headRoom).toBeUndefined();
  });

  const gross = BigInt(W + T) * BigInt(H + T);
  const roomH = BigInt(H - T); // every room runs from wall to wall north–south
  const garage = BigInt(W - X - T) * roomH;
  const openToBelow = (2_000_000n - BigInt(T)) * (2_000_000n - BigInt(T));
  // The attic is 3,712,000 wide; the part at least 5 ft high is 2 × 1,649,280 wide (and the part at
  // least 7 ft high, 2 × 868,992, is more than half of it), so the strips beyond are left out.
  const under5 = (3_712_000n - 2n * 1_649_280n) * roomH;

  it('leaves out the garage downstairs and counts the stair upstairs, where it descends from', () => {
    const r = z765(d).buildings[0]!;
    const [l1, l2] = r.levels;
    expect(l1).toMatchObject({ level: 'L1', aboveGrade: true, finishedArea: Number(gross - garage), excluded: [{ id: 'GAR', reason: 'unfinished' }] });
    expect(l1!.finishedSqFt).toBe(sqft(gross - garage));
    expect(l2!.excluded).toEqual([
      { id: 'ATT', reason: 'slopedUnder5ft' },
      { id: 'face@1564000,6064000', reason: 'openToBelow' },
    ]);
    expect(l2!.finishedArea).toBe(Number(gross - openToBelow - under5));
    expect(l2!.finishedSqFt).toBe(sqft(gross - openToBelow - under5));
    expect(r.aboveGradeSqFt).toBe(sqft(gross - garage + gross - openToBelow - under5));
    expect(r.belowGradeSqFt).toBe(0);
  });

  it('leaves out a vaulted room whole when less than half of it is 7 ft high', () => {
    const low = structuredClone(d) as { rooms: Record<string, { ceiling: Record<string, unknown> }> };
    low.rooms.ATT!.ceiling.height = 2_700_000; // the ridge is now under 7 ft
    const l2 = z765(low).buildings[0]!.levels[1]!;
    expect(l2.excluded[0]).toEqual({ id: 'ATT', reason: 'slopedLessThanHalfAt7ft' });
    expect(l2.finishedArea).toBe(Number(gross - openToBelow - 3_712_000n * roomH));
  });

  it('leaves out a room whose flat ceiling is under 7 ft', () => {
    const low = structuredClone(d) as { rooms: Record<string, Record<string, unknown>> };
    low.rooms.LIV!.ceiling = { kind: 'flat', height: 2_700_000 }; // 6 ft 11 in
    const l1 = z765(low).buildings[0]!.levels[0]!;
    expect(l1.excluded).toEqual([
      { id: 'GAR', reason: 'unfinished' },
      { id: 'LIV', reason: 'ceilingUnder7ft' },
    ]);
  });

  it('reports a level below grade apart, never adding it to the area above', () => {
    const r = z765(d, { grade: 1_280_000 }).buildings[0]!;
    expect(r.levels.map((l) => l.aboveGrade)).toEqual([false, true]);
    expect(r.belowGradeSqFt).toBe(sqft(gross - garage));
    expect(r.aboveGradeSqFt).toBe(sqft(gross - openToBelow - under5));
  });

  it('counts other functions as unfinished when asked', () => {
    const r = z765(d, { unfinished: ['garage', 'storage'] }).buildings[0]!.levels[1]!;
    expect(r.excluded[0]).toEqual({ id: 'ATT', reason: 'unfinished' });
  });
});
