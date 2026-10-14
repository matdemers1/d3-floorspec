/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply } from '@floorspec/ops';
import { OFFICIAL_READER } from '@floorspec/engine';
import { readModel, type LevelView, type Point } from '../src/editor/model';
import type { Batch } from '../src/editor/ops';
import { nudgeBatch } from '../src/editor/nudge';
import { extentAcross, functionFromName, moveRoom, resizeRoom, roomDrag, roomSides, sideDrag, sidesOfRing, wandCandidates } from '../src/editor/rooms/edit';

/**
 * FLR-T-18.10: rooms you can grab — the sides a handle moves, the drags' arithmetic, the batches
 * through the real applier on the Courtyard House, and the magic wand's candidate spaces.
 */

const HOUSE = readFileSync(new URL('../../worker/test/fixtures/courtyard-house.json', import.meta.url), 'utf8');
const IN = 32_512;
const L1 = (doc: string): LevelView => readModel('h', doc).levels.find((l) => l.id === 'L1')!;

function commit(doc: string, batch: Batch): string {
  const r = apply(doc, { batch }, OFFICIAL_READER);
  if (r.status !== 'committed') throw new Error(`rejected: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
  return r.document;
}

describe('the sides of a room', () => {
  it('a rectangle has four sides, each handle at the middle of its edge', () => {
    const ring: Point[] = [[0, 0], [100, 0], [100, 50], [0, 50]];
    const sides = sidesOfRing(ring);
    expect(sides.map((s) => [s.side, s.ok, s.at])).toEqual([
      ['north', true, [50, 50]],
      ['east', true, [100, 25]],
      ['south', true, [50, 0]],
      ['west', true, [0, 25]],
    ]);
  });

  it('a clockwise ring reads the same, and collinear points along a side are one run', () => {
    const ring: Point[] = [[0, 0], [0, 50], [100, 50], [100, 20], [100, 0]];
    const east = sidesOfRing(ring).find((s) => s.side === 'east')!;
    expect(east.ok).toBe(true);
    expect(east.at).toEqual([100, 25]);
  });

  it('an L-shaped room: the side with two edges on two lines is jogged', () => {
    const ring: Point[] = [[0, 0], [100, 0], [100, 40], [60, 40], [60, 80], [0, 80]];
    const sides = sidesOfRing(ring);
    expect(sides.find((s) => s.side === 'north')).toMatchObject({ ok: false, why: 'is jogged: its edges do not lie on one line' });
    expect(sides.find((s) => s.side === 'east')).toMatchObject({ ok: false });
    expect(sides.find((s) => s.side === 'south')!.ok).toBe(true);
    expect(sides.find((s) => s.side === 'west')!.ok).toBe(true);
  });

  it('a room with a slanted side has no handle that way', () => {
    const ring: Point[] = [[0, 0], [100, 0], [80, 50], [0, 50]];
    expect(sidesOfRing(ring).map((s) => s.side).sort()).toEqual(['north', 'south', 'west']);
  });

  it('the Courtyard House pantry: four sides, 7′-6″ across east to west', () => {
    const level = L1(HOUSE);
    expect(roomSides(level, 'R9').filter((s) => s.ok).map((s) => s.side)).toEqual(['north', 'east', 'south', 'west']);
    expect(Math.round(extentAcross(level, 'R9', 'east') / IN)).toBe(90);
  });
});

describe('dragging', () => {
  it('a side moves by the pointer along its outward direction, on the grid, ⇧ free', () => {
    const o = { grid: IN / 2, free: false, extent: 100 * IN, min: 12 * IN };
    expect(sideDrag('east', [0, 0], [10.3 * IN, 999], o)).toBe(10.5 * IN);
    expect(sideDrag('west', [0, 0], [10.3 * IN, 0], o)).toBe(-10.5 * IN);
    expect(sideDrag('north', [0, 0], [0, 3 * IN], { ...o, free: true })).toBe(3 * IN);
    // Never thinner than the least room.
    expect(sideDrag('east', [0, 0], [-500 * IN, 0], o)).toBe(-88 * IN);
  });

  it('a room by its floor: on the grid, ⇧ along one axis', () => {
    expect(roomDrag([0, 0], [12.2 * IN, 3.1 * IN], { grid: IN / 2, free: false, axis: false })).toEqual([12 * IN, 3 * IN]);
    expect(roomDrag([0, 0], [12.2 * IN, 3.1 * IN], { grid: IN / 2, free: false, axis: true })).toEqual([12 * IN, 0]);
  });
});

describe('the Ops a room sends (through the real applier)', () => {
  it('the pantry pulled 18″ east: resizeRoom commits, the pantry is 18″ wider, and its walls follow', () => {
    const before = L1(HOUSE);
    const doc = commit(HOUSE, resizeRoom('R9', 'east', 18 * IN));
    const after = L1(doc);
    expect(extentAcross(after, 'R9', 'east') - extentAcross(before, 'R9', 'east')).toBe(18 * IN);
    expect(after.walls.length).toBeGreaterThanOrEqual(before.walls.length);
    expect(readModel('a', doc).valid).toBe(true);
  });

  it('the pantry moved 1 ft north: moveRoom commits, its floor outline moves with it', () => {
    const area = (l: LevelView) => l.faces.find((f) => f.room === 'R9')!.area2;
    const minY = (l: LevelView) => Math.min(...l.faces.find((f) => f.room === 'R9')!.outer.map((p) => p[1]));
    const before = L1(HOUSE);
    const doc = commit(HOUSE, moveRoom('R9', [0, 12 * IN]));
    const after = L1(doc);
    expect(minY(after)).toBe(minY(before) + 12 * IN);
    expect(area(after)).toBeGreaterThan(0n);
  });

  it('the arrows nudge a selected room with moveRoom', () => {
    const level = L1(HOUSE);
    expect(nudgeBatch(level, {}, 'R9', 'ArrowLeft', IN)).toEqual([{ op: 'moveRoom', room: 'R9', by: [-IN, 0] }]);
  });
});

describe('the magic wand', () => {
  // Two separators across the west end of the garage: two strips of floor with no room, side by side.
  const bare = commit(HOUSE, [
    { op: 'drawSeparator', level: 'L1', from: [2_000_000, 17_166_336], to: [2_000_000, 24_969_216] },
    { op: 'drawSeparator', level: 'L1', from: [3_500_000, 17_166_336], to: [3_500_000, 24_969_216] },
  ]);

  it('a click in the middle strip offers it first, then the strip beside it; Tab would cycle them', () => {
    const level = L1(bare);
    const c = wandCandidates(level, [2_750_000, 21_000_000]);
    expect(c.map((x) => x.how)).toEqual(['here', 'beside']);
    expect(c.every((x) => x.face.room === null)).toBe(true);
    expect(Math.max(...c[1]!.face.outer.map((p) => p[0]))).toBeLessThanOrEqual(2_000_000);
    // Each candidate's anchor point lies in its own face: addRoom there makes that face the room.
    const doc = commit(bare, [{ op: 'addRoom', level: 'L1', at: [c[1]!.at[0], c[1]!.at[1]], name: 'Bike store', function: 'storage' }]);
    const made = L1(doc).faces.find((f) => f.outer.every((p) => p[0] <= 2_000_000));
    expect(made?.room).not.toBeNull();
  });

  it('a click in a room that has one offers only the spaces beside it without one', () => {
    const level = L1(bare);
    // In the garage (R11), east of the strips.
    const c = wandCandidates(level, [6_000_000, 21_000_000]);
    expect(c.map((x) => x.how)).toEqual(['beside']);
    expect(c[0]!.face.room).toBeNull();
  });

  it('nothing to offer outside the walls', () => {
    expect(wandCandidates(L1(bare), [-50_000_000, -50_000_000])).toEqual([]);
  });

  it('a name suggests a function', () => {
    expect(functionFromName('Pantry')).toBe('storage');
    expect(functionFromName('Primary bedroom')).toBe('sleeping');
    expect(functionFromName('Powder room')).toBe('bath');
    expect(functionFromName('Room 4')).toBeNull();
  });
});
