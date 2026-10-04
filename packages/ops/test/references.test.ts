/** Chapter 3: lengths in operations, points, vectors, selectors, sides and positions, and the echo of what they resolved to. */
import { describe, expect, it } from 'vitest';
import { resolveBatch, type ResolvedPrimitive } from '../src/index.js';
import { B, box, committed, doc, FT, H, IN, pair, pos, rejectedWith, run, W } from './doc.js';

/** The primitives one operation resolves to, against `d`. */
function resolved(d: object, op: unknown): ResolvedPrimitive[] {
  const r = resolveBatch(d, { batch: [op] });
  if (r.status !== 'resolved') throw new Error(JSON.stringify(r.diagnostics));
  return r.resolved;
}

describe('lengths in operations (3.1.1)', () => {
  it('resolves every length to an integer, and echoes it', () => {
    expect(resolved(box(), { op: 'setProperty', id: 'L1', path: '/height', value: `10' 6"` })).toEqual([{ op: 'setProperty', id: 'L1', path: '/height', value: 10 * FT + 6 * IN }]);
    expect(resolved(box(), { op: 'moveJunction', id: 'J1', to: ['-2\'', '1/3"'] })).toEqual([{ op: 'moveJunction', id: 'J1', to: [-2 * FT, 10837] }]);
  });

  it('rejects a string that is not a length with FS-OPS-012', () => {
    rejectedWith(run(box(), { op: 'moveWall', wall: 'W1', by: '2 feet' }), 'FS-OPS-012', []);
    rejectedWith(run(box(), { op: 'moveWall', wall: 'W1', by: '3/0"' }), 'FS-OPS-012');
    rejectedWith(run(box(), { op: 'moveJunction', id: 'J1', to: ['1 m', 'one'] }), 'FS-OPS-012');
    rejectedWith(run(box(), { op: 'setProperty', id: 'L1', path: '/height', value: '3' }), 'FS-OPS-012');
  });

  it('resolves lengths inside element content (2.5)', () => {
    const b = B(
      run(box(), {
        op: 'addElement',
        collection: 'types',
        id: 'INT',
        element: { kind: 'wallType', layers: [{ thickness: '1/2"', function: 'finish' }, { thickness: '3 1/2"', function: 'core' }, { thickness: '1/2"', function: 'finish' }] },
      }),
    );
    expect(b.types!.INT).toEqual({ kind: 'wallType', layers: [{ thickness: IN / 2, function: 'finish' }, { thickness: 3.5 * IN, function: 'core' }, { thickness: IN / 2, function: 'finish' }] });
  });
});

describe('points and vectors (3.2.1)', () => {
  it('resolves "<length> <direction> of <junction>"', () => {
    expect(resolved(box(), { op: 'moveJunction', id: 'J4', to: "12' east of J1" })).toEqual([{ op: 'moveJunction', id: 'J4', to: [12 * FT, 0] }]);
    expect(resolved(box(), { op: 'moveJunction', id: 'J4', to: '1 m south of J3' })).toEqual([{ op: 'moveJunction', id: 'J4', to: [W, H - 1280000] }]);
    expect(resolved(box(), { op: 'moveJunction', id: 'J4', to: `2' 6" West of start of east wall of Kitchen` })).toEqual([{ op: 'moveJunction', id: 'J4', to: [W - 30 * IN, H] }]);
  });

  it('resolves "<length> from <junction> toward <junction>", rounding each coordinate once', () => {
    // d = (3900000, 2800000) = 100000·(39, 28); |d| = 100000·√2305. x = 390144·39/√2305 = 316923.23…,
    // y = 390144·28/√2305 = 227534.62…
    expect(resolved(box(), { op: 'moveJunction', id: 'J2', to: "1' from J1 toward J3" })).toEqual([{ op: 'moveJunction', id: 'J2', to: [316923, 227535] }]);
    // Along an axis, exactly.
    expect(resolved(box(), { op: 'moveJunction', id: 'J2', to: "2' from J3 toward J2" })).toEqual([{ op: 'moveJunction', id: 'J2', to: [W - 2 * FT, H] }]);
  });

  it('resolves a junction as its position, and rejects one that is not there', () => {
    expect(resolved(box(), { op: 'addRoom', level: 'L1', at: 'J3', id: 'R9' })).toEqual([{ op: 'addElement', collection: 'rooms', id: 'R9', element: { level: 'L1', anchor: [W, H] } }]);
    rejectedWith(run(box(), { op: 'moveJunction', id: 'J1', to: 'J99' }), 'FS-OPS-003');
    rejectedWith(run(box(), { op: 'moveJunction', id: 'J1', to: "2' east of W1" }), 'FS-OPS-003');
    rejectedWith(run(box(), { op: 'moveJunction', id: 'J1', to: 'two feet east of J2' }), 'FS-OPS-012');
    rejectedWith(run(box(), { op: 'moveJunction', id: 'J1', to: '12, 15' }), 'FS-OPS-012');
  });

  it('resolves vectors', () => {
    expect(resolved(pair(), { op: 'moveRoom', room: 'Dining', by: "2' east" }).at(-1)).toMatchObject({ value: [Math.floor((3 * W) / 2) + 2 * FT, Math.floor(H / 2)] });
    expect(resolved(pair(), { op: 'moveRoom', room: 'Dining', by: ['1 mm', '-1 mm'] }).at(-1)).toMatchObject({ value: [Math.floor((3 * W) / 2) + 1280, Math.floor(H / 2) - 1280] });
    rejectedWith(run(pair(), { op: 'moveRoom', room: 'Dining', by: "2' up" }), 'FS-OPS-012');
  });
});

describe('selectors (3.3.1)', () => {
  it('resolves an ID, a room name ignoring case, and the side of a room', () => {
    expect(resolved(box(), { op: 'removeElement', id: 'kitchen' })).toEqual([{ op: 'removeElement', id: 'R1' }]);
    const sides = { north: 'W2', east: 'W3', south: 'W4', west: 'W1' };
    for (const [side, wall] of Object.entries(sides)) expect(resolved(box(), { op: 'removeElement', id: `${side} wall of Kitchen` })).toEqual([{ op: 'removeElement', id: wall }]);
    expect(resolved(box(), { op: 'removeElement', id: 'NORTH  WALL OF kitchen' })).toEqual([{ op: 'removeElement', id: 'W2' }]);
  });

  it('resolves the wall between two rooms, and the ends of a wall', () => {
    expect(resolved(pair(), { op: 'removeElement', id: 'wall between Kitchen and Dining' })).toEqual([{ op: 'removeElement', id: 'W7' }]);
    expect(resolved(pair(), { op: 'removeElement', id: 'wall between RB and RA' })).toEqual([{ op: 'removeElement', id: 'W7' }]);
    const named = (id: string): unknown => resolved(pair(), { op: 'setProperty', id, path: '/name', value: 'here' })[0];
    expect(named('start of wall between Kitchen and Dining')).toMatchObject({ id: 'B0' });
    expect(named('end of W7')).toMatchObject({ id: 'T' });
    expect(named('Start Of north wall of Dining')).toMatchObject({ id: 'T' });
    // A room name with "and" in it.
    const d = pair();
    (d.rooms as Record<string, Record<string, unknown>>).RB!.name = 'Bed and Breakfast';
    expect(resolved(d, { op: 'removeElement', id: 'wall between Kitchen and Bed and Breakfast' })).toEqual([{ op: 'removeElement', id: 'W7' }]);
  });

  it('reads separators as well as walls', () => {
    const d = pair();
    const sep = (d.walls as Record<string, { start: string; end: string }>).W7!;
    delete (d.walls as Record<string, unknown>).W7;
    d.separators = { S1: { level: 'L1', start: sep.start, end: sep.end } };
    expect(resolved(d, { op: 'removeElement', id: 'separator between Kitchen and Dining' })).toEqual([{ op: 'removeElement', id: 'S1' }]);
    expect(resolved(d, { op: 'removeElement', id: 'east separator of Kitchen' })).toEqual([{ op: 'removeElement', id: 'S1' }]);
    rejectedWith(run(d, { op: 'removeElement', id: 'wall between Kitchen and Dining' }), 'FS-OPS-003', []);
    rejectedWith(run(d, { op: 'removeElement', id: 'east wall of Kitchen' }), 'FS-OPS-003');
  });

  it('rejects a selector that matches nothing with FS-OPS-003', () => {
    rejectedWith(run(box(), { op: 'removeElement', id: 'Garage' }), 'FS-OPS-003', []);
    rejectedWith(run(box(), { op: 'removeElement', id: 'north wall of Garage' }), 'FS-OPS-003');
    rejectedWith(run(box(), { op: 'resizeRoom', room: 'W1', side: 'east', by: 1 }), 'FS-OPS-003');
    rejectedWith(run(box(), { op: 'addOpening', wall: 'J1', at: 'centered', width: 100 }), 'FS-OPS-003');
  });

  it('rejects a selector that matches several elements with FS-OPS-004, listing them', () => {
    const d = pair();
    (d.rooms as Record<string, Record<string, unknown>>).RB!.name = 'kitchen';
    rejectedWith(run(d, { op: 'removeElement', id: 'Kitchen' }), 'FS-OPS-004', ['RA', 'RB']);
    // The north side of the whole pair, seen from a room that spans it, is two walls.
    const whole = pair(undefined, undefined, { rooms: { R: [100000, 100000] } });
    delete (whole.walls as Record<string, unknown>).W7;
    rejectedWith(run(whole, { op: 'removeElement', id: 'north wall of R' }), 'FS-OPS-004', ['W2', 'W3']);
  });

  it('puts a wall at exactly 45° on the side counter-clockwise before it (3.4)', () => {
    // A right triangle, its hypotenuse facing north-east: outward normal (1, 1) is east.
    const tri = doc({
      junctions: { J1: [0, 0], J2: [0, 2000000], J3: [2000000, 0] },
      walls: { W1: { start: 'J1', end: 'J2' }, W2: { start: 'J2', end: 'J3' }, W3: { start: 'J3', end: 'J1' } },
      rooms: { R: [400000, 400000] },
    });
    expect(resolved(tri, { op: 'removeElement', id: 'east wall of R' })).toEqual([{ op: 'removeElement', id: 'W2' }]);
    rejectedWith(run(tri, { op: 'removeElement', id: 'north wall of R' }), 'FS-OPS-003');
    // Mirror it: the hypotenuse faces north-west, normal (−1, 1), which is north.
    const mirrored = doc({
      junctions: { J1: [0, 0], J2: [-2000000, 0], J3: [0, 2000000] },
      walls: { W1: { start: 'J2', end: 'J3' }, W2: { start: 'J3', end: 'J1' }, W3: { start: 'J1', end: 'J2' } },
      rooms: { R: [-400000, 400000] },
    });
    expect(resolved(mirrored, { op: 'removeElement', id: 'north wall of R' })).toEqual([{ op: 'removeElement', id: 'W1' }]);
  });

  it('rejects a face selector on a level with no faces to give with FS-OPS-007 (3.4.1)', () => {
    // Earlier in the batch, J3 is dragged so that W2 crosses W4's line: the level is not planar.
    rejectedWith(run(box(), { op: 'moveJunction', id: 'J3', to: [W, -H] }, { op: 'removeElement', id: 'north wall of Kitchen' }), 'FS-OPS-007', ['L1']);
    // An anchor on a wall, or outside every face.
    rejectedWith(run(box(), { op: 'setProperty', id: 'R1', path: '/anchor', value: [0, 5] }, { op: 'removeElement', id: 'west wall of Kitchen' }), 'FS-OPS-007', ['L1']);
    rejectedWith(run(box(), { op: 'setProperty', id: 'R1', path: '/anchor', value: [-5, 5] }, { op: 'moveRoom', room: 'R1', by: "1' north" }), 'FS-OPS-007', ['L1']);
  });
});

describe('positions along a wall (3.5.1)', () => {
  const door = { D36: { kind: 'doorType', width: 36 * IN, height: 80 * IN } };
  const at = (position: unknown, extra: Record<string, unknown> = {}): unknown =>
    (resolved(pair(undefined, undefined, { types: door }), { op: 'addOpening', wall: 'W7', at: position, fill: 'D36', id: 'O1', ...extra })[0] as unknown as { element: { offset: number } }).element.offset;
  it('resolves each form exactly, rounding once', () => {
    expect(at('centered')).toBe((H - 36 * IN) / 2);
    expect(at("1' from start")).toBe(FT);
    expect(at("1' from end")).toBe(H - FT - 36 * IN);
    expect(at(12345)).toBe(12345);
    expect(at('2 m')).toBe(2560000);
    expect(at('centered', { width: 1 })).toBe(1399999.5 + 0.5); // (2800000 − 1)/2 = 1399999.5 → 1400000 (even)
    expect(at('centered', { width: 3 })).toBe(1399998); // 1399998.5 → 1399998 (even)
  });

  it('measures an oblique wall exactly', () => {
    // |d| = 100000·√2305 = 4801041.55…; centred 1 m: (4801041.55… − 1280000)/2 = 1760520.77… → 1760521
    const d = box(undefined, undefined, { walls: { W1: { start: 'J1', end: 'J2' }, W2: { start: 'J2', end: 'J3' }, W3: { start: 'J3', end: 'J4' }, W4: { start: 'J4', end: 'J1' }, WX: { start: 'J1', end: 'J3' } } });
    delete (d.rooms as Record<string, unknown>).R1;
    const r = resolved(d, { op: 'addOpening', wall: 'WX', at: 'centered', width: '1 m', height: '2 m', id: 'O1' });
    expect((r[0] as { element: unknown }).element).toEqual({ wall: 'WX', offset: 1760521, width: 1280000, height: 2560000 });
  });

  it('echoes the resolved position in B', () => {
    const b = B(run(pair(undefined, undefined, { types: door }), { op: 'addOpening', wall: 'wall between Kitchen and Dining', at: 'centered', fill: 'D36' }));
    expect(b.openings).toEqual({ O1: { wall: 'W7', offset: (H - 36 * IN) / 2, fill: 'D36' } });
    expect(pos(b, 'T')).toEqual([W, H]);
  });

  it('commits a whole batch of references end to end', () => {
    committed(run(pair(), { op: 'moveWall', wall: 'wall between Kitchen and Dining', by: "1' 6\"", toward: 'dining' }));
  });
});
