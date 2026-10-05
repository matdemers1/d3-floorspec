/** Chapter 5: measures of rooms, on small hand-made documents (beyond the conformance suite). */
import { describe, expect, it } from 'vitest';
import { check } from '@floorspec/engine';
import { box, doc, element, free, FT, HALF, IN, level, measures, one, room, row, T, thing } from './docs.js';

const W = 12 * FT;
const H = 10 * FT;

describe('roomFunction (5.1)', () => {
  it('is the room function with its default, or an extension term as written', () => {
    const d = doc(row(W, H, { rooms: { R1: [W / 2, H / 2], R2: { anchor: [W + W / 2, H / 2], function: 'EXT_x:sunroom' } }, extensionsUsed: { EXT_x: '1.0.0' } }));
    expect(one(d, room('R1'), 'roomFunction')).toEqual({ type: 'term', value: 'unspecified', display: 'unspecified' });
    expect(one(d, room('R2'), 'roomFunction').value).toBe('EXT_x:sunroom');
  });
});

describe('roomNetArea (5.2)', () => {
  it('is the room polygon’s area inside the finished walls, exactly', () => {
    const d = doc(box(W, H));
    const r = one(d, room('R1'), 'roomNetArea');
    expect(r.type).toBe('area');
    expect(r.value).toBe(String(BigInt(W - T) * BigInt(H - T)));
    // 4,553,728 × 3,773,440 square base units is 112.89 sq ft (11 ft 8 3/8 in × 9 ft 8 1/16 in).
    expect(r.display).toBe('112.89 sq ft');
    expect(one(d, room('R1'), 'roomNetArea', undefined, { units: 'metric' }).display).toBe('10.49 m²');
  });

  it('subtracts a hole (a column standing free in the room)', () => {
    const c = [3 * FT, 3 * FT];
    const s = box(W, H);
    s.junctions = { ...s.junctions, K1: [c[0]!, c[1]!], K2: [c[0]!, c[1]! + FT], K3: [c[0]! + FT, c[1]! + FT], K4: [c[0]! + FT, c[1]!] };
    s.walls = { ...s.walls, C1: ['K1', 'K2'], C2: ['K2', 'K3'], C3: ['K3', 'K4'], C4: ['K4', 'K1'] };
    const r = one(doc(s), room('R1'), 'roomNetArea');
    // The column's outline is FT + T on a side.
    expect(r.value).toBe(String(BigInt(W - T) * BigInt(H - T) - BigInt(FT + T) ** 2n));
  });
});

describe('roomLeastWidth (5.3)', () => {
  it('is the shorter side of a rectangular room', () => {
    expect(one(doc(box(W, H)), room('R1'), 'roomLeastWidth')).toEqual({ type: 'length', value: H - T, display: "9' 8 1/16\"" });
  });

  it('is the width of the convex hull of an L, not of one of its legs', () => {
    // A 20' × 20' L whose legs are 4' wide: the hull's least width is across its diagonal edge.
    const d = doc({
      junctions: { J1: [0, 0], J2: [0, 20 * FT], J3: [4 * FT, 20 * FT], J4: [4 * FT, 4 * FT], J5: [20 * FT, 4 * FT], J6: [20 * FT, 0] },
      walls: { W1: ['J1', 'J2'], W2: ['J2', 'J3'], W3: ['J3', 'J4'], W4: ['J4', 'J5'], W5: ['J5', 'J6'], W6: ['J6', 'J1'] },
      rooms: { R1: [2 * FT, 2 * FT] },
    });
    const r = one(d, room('R1'), 'roomLeastWidth');
    // About 24' / √2 = 16.97', less the walls: wider than a leg, narrower than the 20' sides.
    expect(r.value as number).toBeGreaterThan(16 * FT);
    expect(r.value as number).toBeLessThan(17 * FT);
    expect(r.value).toBe(floatLeastWidth(d, 'R1'));
  });

  it('is exact, rounded once, for a room turned 45°', () => {
    const R = 8 * FT;
    const d = doc({
      junctions: { J1: [R, 0], J2: [2 * R, R], J3: [R, 2 * R], J4: [0, R] },
      walls: { W1: ['J1', 'J4'], W2: ['J4', 'J3'], W3: ['J3', 'J2'], W4: ['J2', 'J1'] },
      rooms: { R1: [R, R] },
    });
    const r = one(d, room('R1'), 'roomLeastWidth');
    // A square of side R√2, less a wall thickness, within a unit of rounding of its vertices.
    expect(Math.abs((r.value as number) - (R * Math.SQRT2 - T))).toBeLessThanOrEqual(2);
    expect(r.value).toBe(floatLeastWidth(d, 'R1'));
  });
});

/** The least width by floating point over every supporting line of the ring — an independent check, far from a tie. */
function floatLeastWidth(d: Record<string, unknown>, rid: string): number {
  const ring = check(d).derived!.rooms[rid]!.outer;
  let best = Infinity;
  for (const a of ring)
    for (const b of ring) {
      if (a === b) continue;
      const side = (v: [number, number]): number => (b[0] - a[0]) * (v[1] - a[1]) - (b[1] - a[1]) * (v[0] - a[0]);
      if (ring.some((v) => side(v) < 0)) continue; // not a supporting line with the ring on its left
      const far = Math.max(...ring.map((v) => side(v))) / Math.hypot(b[0] - a[0], b[1] - a[1]);
      best = Math.min(best, far);
    }
  const rounded = Math.round(best);
  expect(Math.abs(Math.abs(best - rounded) - 0.5)).toBeGreaterThan(1e-3); // not near a tie
  return rounded;
}

describe('circulation (5.4)', () => {
  // Two bedrooms in a row: a door from outside into R1, and one from R1 into R2.
  const d = doc(
    row(W, H, {
      rooms: { R1: { anchor: [W / 2, H / 2], function: 'sleeping' }, R2: { anchor: [W + W / 2, H / 2], function: 'sleeping' } },
      openings: { O1: { wall: 'W1', offset: 2 * FT, fill: 'DOOR' }, O2: { wall: 'W7', offset: 2 * FT, fill: 'DOOR' } },
    }),
  );

  it('reads Core’s entries, reachability and sleeping rooms reached only through another', () => {
    const [e1, e2, r1, r2, s1, s2] = measures(d, [
      { target: room('R1'), measure: 'roomIsEntry' },
      { target: room('R2'), measure: 'roomIsEntry' },
      { target: room('R1'), measure: 'roomIsReachable' },
      { target: room('R2'), measure: 'roomIsReachable' },
      { target: room('R1'), measure: 'roomThroughSleeping' },
      { target: room('R2'), measure: 'roomThroughSleeping' },
    ]);
    expect([e1, e2, r1, r2, s1, s2].map((r) => r!.value)).toEqual([true, false, true, true, false, true]);
    expect(e1!.display).toBe('yes');
    expect(e2!.display).toBe('no');
  });

  it('roomThroughSleeping is false for a room that is not a sleeping room', () => {
    const d2 = doc(
      row(W, H, {
        rooms: { R1: { anchor: [W / 2, H / 2], function: 'sleeping' }, R2: { anchor: [W + W / 2, H / 2], function: 'office' } },
        openings: { O1: { wall: 'W1', offset: 2 * FT, fill: 'DOOR' }, O2: { wall: 'W7', offset: 2 * FT, fill: 'DOOR' } },
      }),
    );
    expect(one(d2, room('R2'), 'roomThroughSleeping').value).toBe(false);
    expect(one(d2, room('R2'), 'roomIsReachable').value).toBe(true);
  });
});

describe('neighbours (5.5)', () => {
  const garage = (openings?: Record<string, Record<string, unknown>>): Record<string, unknown> =>
    doc(row(W, H, { rooms: { R1: { anchor: [W / 2, H / 2], function: 'garage' }, R2: { anchor: [W + W / 2, H / 2], function: 'sleeping' } }, ...(openings && { openings }) }));

  it('a garage beside a bedroom is adjacent to it, and connected only through a door or an empty opening', () => {
    expect(one(garage(), room('R1'), 'roomAdjacentTo', { function: 'sleeping' }).value).toBe(true);
    expect(one(garage(), room('R1'), 'roomConnectedTo', { function: 'sleeping' }).value).toBe(false);
    expect(one(garage({ O1: { wall: 'W7', offset: FT, fill: 'DOOR' } }), room('R1'), 'roomConnectedTo', { function: 'sleeping' }).value).toBe(true);
    expect(one(garage({ O1: { wall: 'W7', offset: FT, width: 3 * FT, height: 7 * FT } }), room('R1'), 'roomConnectedTo', { function: 'sleeping' }).value).toBe(true);
    // A window does not connect.
    expect(one(garage({ O1: { wall: 'W7', offset: FT, fill: 'WIN' } }), room('R1'), 'roomConnectedTo', { function: 'sleeping' }).value).toBe(false);
  });

  it('a separator connects; a function nobody has is never a neighbour', () => {
    const s = row(W, H, { rooms: { R1: { anchor: [W / 2, H / 2], function: 'garage' }, R2: { anchor: [W + W / 2, H / 2], function: 'sleeping' } } });
    delete s.walls.W7;
    s.separators = { S1: ['J6', 'J3'] };
    expect(one(doc(s), room('R2'), 'roomConnectedTo', { function: 'garage' }).value).toBe(true);
    expect(one(doc(s), room('R2'), 'roomAdjacentTo', { function: 'kitchen' }).value).toBe(false);
  });
});

describe('elementCount (5.6, 8.4)', () => {
  const things = {
    // In R1: a free host inside it, and a wallFace host on the right of W1 (its east side, R1's).
    A: thing({ min: [-IN, -IN, 0], max: [IN, IN, IN] }, free(3 * FT, 3 * FT)),
    B: thing({ min: [0, -IN, -IN], max: [IN, IN, IN] }, { mode: 'wallFace', wall: 'W1', side: 'right', offset: 4 * FT, height: FT }),
    // On W1's left, outside: in no room.
    C: thing({ min: [0, -IN, -IN], max: [IN, IN, IN] }, { mode: 'wallFace', wall: 'W1', side: 'left', offset: 4 * FT, height: FT }),
    // In R2.
    D: thing({ min: [-IN, -IN, 0], max: [IN, IN, IN] }, free(W + 3 * FT, 3 * FT)),
    // On the location line of W7: in no room. Without a host: in no room.
    E: thing({ min: [-IN, -IN, 0], max: [IN, IN, IN] }, free(W, 3 * FT)),
    F: thing({ min: [-IN, -IN, 0], max: [IN, IN, IN] }),
  };
  const d = doc(
    row(W, H, {
      extensionsUsed: { EXT_test: '1.0.0' },
      extensions: { EXT_test: { collections: { things, others: { G: thing({ min: [-IN, -IN, 0], max: [IN, IN, IN] }, free(2 * FT, 2 * FT)) } } } },
    }),
  );

  it('counts the elements in a room, of an extension and a collection, from their core members alone', () => {
    const [r1, r1things, r2, r1other] = measures(d, [
      { target: room('R1'), measure: 'elementCount', args: { extension: 'EXT_test' } },
      { target: room('R1'), measure: 'elementCount', args: { extension: 'EXT_test', collection: 'things' } },
      { target: room('R2'), measure: 'elementCount', args: { extension: 'EXT_test' } },
      { target: room('R1'), measure: 'elementCount', args: { extension: 'FS_electrical' } },
    ]);
    expect(r1).toEqual({ type: 'count', value: 3, display: '3' }); // A, B, G
    expect(r1things!.value).toBe(2);
    expect(r2!.value).toBe(1);
    expect(r1other!.value).toBe(0);
  });

  it('of a level, counts every element whose fallback is on it', () => {
    expect(one(d, level('L1'), 'elementCount', { extension: 'EXT_test' }).value).toBe(7);
    expect(one(d, level('L1'), 'elementCount', { extension: 'EXT_test', collection: 'others' }).value).toBe(1);
  });

  it('with a match, counts only the elements whose members match, read with their defaults', () => {
    const e = doc(
      box(W, H, {
        extensionsUsed: { FS_electrical: '0.1.0' },
        extensions: {
          FS_electrical: {
            collections: {
              alarms: {
                X1: { ...thing({ min: [-IN, -IN, -IN], max: [IN, IN, 0] }, { mode: 'surface', room: 'R1', surface: 'ceiling', position: [3 * FT, 3 * FT] }), detects: ['smoke', 'carbonMonoxide'] },
                X2: { ...thing({ min: [-IN, -IN, -IN], max: [IN, IN, 0] }, { mode: 'surface', room: 'R1', surface: 'ceiling', position: [6 * FT, 3 * FT] }), detects: ['heat'] },
              },
              receptacles: {
                X3: thing({ min: [0, -IN, -IN], max: [IN, IN, IN] }, { mode: 'wallFace', wall: 'W1', side: 'right', offset: 4 * FT, height: FT }),
                X4: { ...thing({ min: [0, -IN, -IN], max: [IN, IN, IN] }, { mode: 'wallFace', wall: 'W1', side: 'right', offset: 6 * FT, height: FT }), amps: 20 },
              },
            },
          },
        },
      }),
    );
    const [smoke, co, amps15, amps20] = measures(e, [
      { target: room('R1'), measure: 'elementCount', args: { extension: 'FS_electrical', collection: 'alarms', match: { detects: 'smoke' } } },
      { target: room('R1'), measure: 'elementCount', args: { extension: 'FS_electrical', match: { detects: 'carbonMonoxide' } } },
      { target: room('R1'), measure: 'elementCount', args: { extension: 'FS_electrical', collection: 'receptacles', match: { amps: 15 } } },
      { target: room('R1'), measure: 'elementCount', args: { extension: 'FS_electrical', collection: 'receptacles', match: { amps: 20 } } },
    ]);
    expect([smoke, co, amps15, amps20].map((r) => r!.value)).toEqual([1, 1, 1, 1]);
    expect(one(e, element('X3'), 'elementRoomFunction').value).toBe('unspecified');
  });
});

describe('a wall that stops free in a room does not split it', () => {
  it('keeps one room with one net area', () => {
    const s = box(W, H);
    s.junctions = { ...s.junctions, K1: [W / 2, 0], K2: [W / 2, 4 * FT] };
    delete s.walls.W4;
    s.walls = { ...s.walls, W4a: ['J4', 'K1'], W4b: ['K1', 'J1'], W5: ['K1', 'K2'] };
    const r = one(doc(s), room('R1'), 'roomNetArea');
    // The stub's footprint inside the room: T wide, from the south wall's inner face (y = T/2) to
    // its free end, which stops square at its junction (y = 4').
    expect(r.value).toBe(String(BigInt(W - T) * BigInt(H - T) - BigInt(T) * BigInt(4 * FT - HALF)));
  });
});
