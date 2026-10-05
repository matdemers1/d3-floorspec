/** Chapter 8: wall lines, receptacles, circuits and levels, on small hand-made documents. */
import { describe, expect, it } from 'vitest';
import { stretches } from '../src/index.js';
import { box, doc, FT, HALF, level, measures, one, room, row, T, thing, type Spec } from './docs.js';

const W = 12 * FT;
const H = 10 * FT;
/** R1's wall line in a 12' × 10' box: around the inside faces. */
const LOOP = 2 * (W - T) + 2 * (H - T); // 16,654,336

const recep = (wall: string, offset: number, extra: Record<string, unknown> = {}, side: 'left' | 'right' = 'right'): Record<string, unknown> => ({
  ...thing({ min: [0, -51200, -76800], max: [32000, 51200, 76800] }, { mode: 'wallFace', wall, side, offset, height: FT }),
  ...extra,
});

const PANEL = {
  ...thing({ min: [0, -256000, -512000], max: [128000, 256000, 512000] }, { mode: 'wallFace', wall: 'W2', side: 'right', offset: 9 * FT, height: 1536000 }),
  volts: [120, 240],
  rating: 100,
  spaces: 20,
};

function withReceptacles(receptacles: Record<string, Record<string, unknown>>, extra: Partial<Spec> = {}, circuits?: Record<string, unknown>): Record<string, unknown> {
  return doc(
    box(W, H, {
      extensionsUsed: { FS_electrical: '0.1.0' },
      extensions: { FS_electrical: { collections: { panels: { X1: PANEL }, receptacles }, ...(circuits && { circuits }) } },
      ...extra,
    }),
  );
}

const both = (d: Record<string, unknown>, args?: Record<string, unknown>): [unknown, unknown, unknown] => {
  const [reach, run] = measures(d, [
    { target: room('R1'), measure: 'receptacleReach', ...(args && { args }) },
    { target: room('R1'), measure: 'wallRunBetweenReceptacles', ...(args && { args }) },
  ]);
  return [reach!.value, run!.value, run!.involved];
};

describe('stretches (8.1)', () => {
  it('a wall line with no break is one closed stretch; breaks merge; a stretch may wrap past the start', () => {
    expect(stretches(100n, [])).toEqual([[0n, 100n, true]]);
    expect(stretches(100n, [[10n, 20n]])).toEqual([[20n, 110n, false]]);
    expect(stretches(100n, [[50n, 60n], [10n, 20n], [15n, 30n]])).toEqual([
      [30n, 50n, false],
      [60n, 110n, false],
    ]);
    // Breaks that cover it all leave none; so does an empty wall line.
    expect(stretches(100n, [[0n, 100n]])).toEqual([]);
    expect(stretches(0n, [])).toEqual([]);
  });
});

describe('receptacleReach and wallRunBetweenReceptacles (8.2)', () => {
  it('a closed wall line with no receptacle: both are its whole length', () => {
    expect(both(withReceptacles({}))).toEqual([LOOP, LOOP, []]);
  });

  it('a closed wall line with one receptacle: the run is the whole loop, the reach half of it', () => {
    expect(both(withReceptacles({ X4: recep('W1', 2 * FT) }))).toEqual([LOOP / 2, LOOP, ['X4']]);
  });

  it('a closed wall line with two: the longer way round between them', () => {
    // X4 and X5 on W1, 5' apart; the other way round is the rest of the loop.
    expect(both(withReceptacles({ X4: recep('W1', 2 * FT), X5: recep('W1', 7 * FT) }))).toEqual([(LOOP - 5 * FT) / 2, LOOP - 5 * FT, ['X4', 'X5']]);
  });

  it('a door breaks the wall line into a stretch with ends', () => {
    // A 3' door in the east wall W3 (J3 → J4, south), from 2' to 5' along it: y from 8' down to 5'.
    const door = { openings: { O1: { wall: 'W3', offset: 2 * FT, fill: 'DOOR' } } };
    const stretch = LOOP - 3 * FT; // 15,483,904
    expect(both(withReceptacles({}, door))).toEqual([stretch, stretch, []]);
    // The stretch starts at the door's north jamb (y = 8'), runs up the east wall, across the
    // north wall and down the west wall: X5 (y = 7') is (2' − T/2) + (W − T) + (3' − T/2) along,
    // X4 (y = 2') 5' further; the end after X4 is the longest gap.
    const r5 = 2 * FT - HALF + (W - T) + (3 * FT - HALF);
    const r4 = r5 + 5 * FT;
    expect(r5).toBe(6376448);
    const end = stretch - r4;
    expect(both(withReceptacles({ X4: recep('W1', 2 * FT), X5: recep('W1', 7 * FT) }, door))).toEqual([end, Math.max(r5, 5 * FT, end), ['X4', 'X5']]);
  });

  it('counts only the receptacles that match, and that are low enough', () => {
    const door = { openings: { O1: { wall: 'W3', offset: 2 * FT, fill: 'DOOR' } } };
    const d = withReceptacles({ X4: recep('W1', 2 * FT), X5: recep('W1', 7 * FT, { amps: 20 }) }, door);
    const stretch = LOOP - 3 * FT;
    // Only X5 is 20 A: the run is the longer of before it and after it.
    const r5 = 2 * FT - HALF + (W - T) + (3 * FT - HALF);
    expect(both(d, { match: { amps: 20 } })).toEqual([Math.max(r5, stretch - r5), Math.max(r5, stretch - r5), ['X5']]);
    // Both are at 1' (390,144) above the floor: none is under 200 mm; both are at most 1'.
    expect(both(d, { maxHeight: 256000 })).toEqual([stretch, stretch, []]);
    expect(both(d, { maxHeight: FT })[2]).toEqual(['X4', 'X5']);
  });

  it('a receptacle on the other side of the wall is not on this room’s wall line', () => {
    expect(both(withReceptacles({ X4: recep('W1', 2 * FT, {}, 'left') }))).toEqual([LOOP, LOOP, []]);
  });

  it('a separator is a break along its whole run', () => {
    // Two rooms in a row with a separator between them instead of a wall.
    const s = row(W, H);
    delete s.walls.W7;
    s.separators = { S1: ['J6', 'J3'] };
    // R1's polygon runs to the separator's line: 2 × (W − T/2) + (H − T) of wall, and H − T of separator.
    const d = doc(s);
    expect(one(d, room('R1'), 'wallRunBetweenReceptacles', undefined, { known: false }).value).toBe(2 * (W - HALF) + (H - T));
  });
});

describe('circuitCount (8.3)', () => {
  const d = withReceptacles(
    { X4: recep('W1', 2 * FT), X5: recep('W1', 7 * FT, { amps: 20 }), X6: recep('W1', 4 * FT, {}, 'left') },
    {},
    {
      C1: { panel: 'X1', breaker: 20, volts: 120, loads: ['X4'] },
      C2: { panel: 'X1', breaker: 15, volts: 120, loads: ['X5'] },
      C3: { panel: 'X1', breaker: 20, volts: 120, loads: ['X6'] },
    },
  );

  it('counts the circuits with a load in the room, and names them', () => {
    expect(one(d, room('R1'), 'circuitCount')).toEqual({ type: 'count', value: 2, display: '2', involved: ['C1', 'C2'] });
  });

  it('of the circuits that match, with loads that match', () => {
    expect(one(d, room('R1'), 'circuitCount', { circuit: { breaker: 20 } })).toMatchObject({ value: 1, involved: ['C1'] });
    expect(one(d, room('R1'), 'circuitCount', { match: { amps: 20 } })).toMatchObject({ value: 1, involved: ['C2'] });
    // Circuits default to one pole (FS_electrical's default, read as 4.5 reads it).
    expect(one(d, room('R1'), 'circuitCount', { circuit: { poles: 1 } })).toMatchObject({ value: 2 });
    expect(one(d, room('R1'), 'circuitCount', { collection: 'lights' })).toMatchObject({ value: 0, involved: [] });
  });
});

describe('levels (8.4)', () => {
  it('roomCount counts the rooms on a level, of a function when given', () => {
    const d = doc(row(W, H, { rooms: { R1: { anchor: [W / 2, H / 2], function: 'sleeping' }, R2: [W + W / 2, H / 2] } }));
    const r = measures(
      d,
      [
        { target: level('L1'), measure: 'roomCount' },
        { target: level('L1'), measure: 'roomCount', args: { function: 'sleeping' } },
        { target: level('L1'), measure: 'roomCount', args: { function: 'unspecified' } },
        { target: level('L1'), measure: 'roomCount', args: { function: 'kitchen' } },
      ],
      { known: false },
    );
    expect(r.map((x) => x.value)).toEqual([2, 1, 1, 0]);
  });

  it('elementCount of a level counts by fallback level, in or out of a room', () => {
    const d = withReceptacles({ X4: recep('W1', 2 * FT), X6: recep('W1', 4 * FT, {}, 'left') });
    expect(one(d, level('L1'), 'elementCount', { extension: 'FS_electrical', collection: 'receptacles' }).value).toBe(2);
    expect(one(d, room('R1'), 'elementCount', { extension: 'FS_electrical', collection: 'receptacles' }).value).toBe(1);
  });
});
