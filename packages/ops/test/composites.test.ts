/** Chapter 4: every composite, as the exact primitives it expands to, and the rejections it defines. */
import { describe, expect, it } from 'vitest';
import { B, box, committed, doc, FT, H, IN, pair, pos, rejectedWith, run, W } from './doc.js';

const core = [{ thickness: 12800, function: 'core' }];

describe('drawWall and drawSeparator (4.1.1)', () => {
  it('adds junctions at new points, then the wall', () => {
    const r = committed(run(box(), { op: 'drawWall', level: 'L1', from: [W + 1000000, 0], to: '1 m north of J4', layers: core, name: 'Garden wall' }));
    expect(r.resolved).toEqual([
      { op: 'addJunction', id: 'J5', level: 'L1', position: [W + 1000000, 0] },
      { op: 'addJunction', id: 'J6', level: 'L1', position: [W, 1280000] },
      { op: 'addWall', id: 'W5', level: 'L1', start: 'J5', end: 'J6', layers: core, name: 'Garden wall' },
    ]);
  });

  it('uses a junction it is given, or one already at the point', () => {
    const r = committed(run(box(), { op: 'drawWall', level: 'L1', from: [0, 0], to: '1 m west of J1', id: 'WG', layers: core }, { op: 'drawWall', level: 'L1', from: 'J5', to: 'J2', layers: core }));
    expect(r.resolved).toEqual([
      { op: 'addJunction', id: 'J5', level: 'L1', position: [-1280000, 0] },
      { op: 'addWall', id: 'WG', level: 'L1', start: 'J1', end: 'J5', layers: core },
      { op: 'addWall', id: 'W5', level: 'L1', start: 'J5', end: 'J2', layers: core },
    ].slice(0, 2).concat([{ op: 'addWall', id: 'W5', level: 'L1', start: 'J5', end: 'J2', layers: core }]));
  });

  it('is split where it crosses other walls, by normalization (5.2)', () => {
    const r = committed(run(box(), { op: 'drawWall', level: 'L1', from: [2000000, -1000000], to: [2000000, 4000000], layers: core }));
    expect(r.resolved.map((p) => p.op)).toEqual(['addJunction', 'addJunction', 'addWall']);
    expect(r.created).toEqual(['J5', 'J6', 'J7', 'J8', 'W5', 'W6', 'W7', 'W8', 'W9']);
    const b = B(r);
    expect(pos(b, 'J7')).toEqual([2000000, 0]);
    expect(pos(b, 'J8')).toEqual([2000000, H]);
    const ends = (w: string): [unknown, unknown] => [b.walls![w]!.start, b.walls![w]!.end];
    expect(ends('W2')).toEqual(['J2', 'J8']);
    expect(ends('W6')).toEqual(['J8', 'J3']);
    expect(ends('W4')).toEqual(['J4', 'J7']);
    expect(ends('W7')).toEqual(['J7', 'J1']);
    expect(ends('W5')).toEqual(['J5', 'J7']);
    expect(ends('W8')).toEqual(['J7', 'J8']);
    expect(ends('W9')).toEqual(['J8', 'J6']);
  });

  it('draws a separator, and a room in the face it makes', () => {
    const r = committed(run(box(), { op: 'drawSeparator', level: 'L1', from: [2000000, 0], to: [2000000, H] }, { op: 'addRoom', level: 'L1', at: [3000000, 1400000], name: 'Dining', function: 'dining' }));
    expect(r.resolved).toEqual([
      { op: 'addJunction', id: 'J5', level: 'L1', position: [2000000, 0] },
      { op: 'addJunction', id: 'J6', level: 'L1', position: [2000000, H] },
      { op: 'addSeparator', id: 'S1', level: 'L1', start: 'J5', end: 'J6' },
      { op: 'addElement', collection: 'rooms', id: 'R2', element: { level: 'L1', anchor: [3000000, 1400000], name: 'Dining', function: 'dining' } },
    ]);
    expect(r.created).toEqual(['J5', 'J6', 'R2', 'S1', 'W5', 'W6']);
  });
});

describe('moveWall (4.2.1)', () => {
  it('moves both ends by `by` times the unit left normal', () => {
    // W3 runs south (J3 → J4); its left is east.
    const r = committed(run(box(), { op: 'moveWall', wall: 'east wall of Kitchen', by: "2'" }));
    expect(r.resolved).toEqual([
      { op: 'moveJunction', id: 'J3', to: [W + 2 * FT, H] },
      { op: 'moveJunction', id: 'J4', to: [W + 2 * FT, 0] },
    ]);
    expect(committed(run(box(), { op: 'moveWall', wall: 'W3', by: "-2'" })).resolved[0]).toEqual({ op: 'moveJunction', id: 'J3', to: [W - 2 * FT, H] });
  });

  it('chooses the sign that moves it into the room named by toward', () => {
    // W7 runs north (B0 → T): its left is west, the Kitchen; the Dining room is on its right.
    const east = committed(run(pair(), { op: 'moveWall', wall: 'W7', by: "1'", toward: 'Dining' })).resolved;
    expect(east).toEqual([
      { op: 'moveJunction', id: 'B0', to: [W + FT, 0] },
      { op: 'moveJunction', id: 'T', to: [W + FT, H] },
    ]);
    const west = committed(run(pair(), { op: 'moveWall', wall: 'W7', by: "-1'", toward: 'Kitchen' })).resolved;
    expect(west[0]).toEqual({ op: 'moveJunction', id: 'B0', to: [W - FT, 0] });
    rejectedWith(run(pair(), { op: 'moveWall', wall: 'W1', by: "1'", toward: 'Dining' }), 'FS-OPS-008', ['W1']);
  });

  it('rounds an oblique displacement once per coordinate', () => {
    // d = (3, 1)·10⁶; the left normal is (−1, 3)/√10: 10⁶·(−0.3162…, 0.9486…) → (−316228, 948683).
    const d = doc({ junctions: { A: [0, 0], C: [3000000, 1000000] }, walls: { WX: { start: 'A', end: 'C' } } });
    expect(committed(run(d, { op: 'moveWall', wall: 'WX', by: 1000000 })).resolved).toEqual([
      { op: 'moveJunction', id: 'A', to: [-316228, 948683] },
      { op: 'moveJunction', id: 'C', to: [3000000 - 316228, 1000000 + 948683] },
    ]);
  });
});

describe('moveRoom (4.3.1)', () => {
  it('moves each junction of the outer cycle by ID, then the anchor', () => {
    const v = -18 * IN;
    const r = committed(run(pair(), { op: 'moveRoom', room: 'Dining', by: `1' 6" west` }));
    expect(r.resolved).toEqual([
      { op: 'moveJunction', id: 'B0', to: [W + v, 0] },
      { op: 'moveJunction', id: 'J3', to: [2 * W + v, H] },
      { op: 'moveJunction', id: 'J4', to: [2 * W + v, 0] },
      { op: 'moveJunction', id: 'T', to: [W + v, H] },
      { op: 'setProperty', id: 'RB', path: '/anchor', value: [Math.floor((3 * W) / 2) + v, Math.floor(H / 2)] },
    ]);
  });
});

describe('resizeRoom (4.4.1)', () => {
  it('moves a side whose ends do not continue, and the anchor by half', () => {
    expect(committed(run(box(), { op: 'resizeRoom', room: 'Kitchen', side: 'east', by: "2'" })).resolved).toEqual([
      { op: 'moveJunction', id: 'J3', to: [W + 2 * FT, H] },
      { op: 'moveJunction', id: 'J4', to: [W + 2 * FT, 0] },
      { op: 'setProperty', id: 'R1', path: '/anchor', value: [W / 2 + FT, H / 2] },
    ]);
  });

  it('moves the anchor of every room across the side too', () => {
    expect(committed(run(pair(), { op: 'resizeRoom', room: 'Kitchen', side: 'east', by: "1'" })).resolved).toEqual([
      { op: 'moveJunction', id: 'B0', to: [W + FT, 0] },
      { op: 'moveJunction', id: 'T', to: [W + FT, H] },
      { op: 'setProperty', id: 'RA', path: '/anchor', value: [W / 2 + FT / 2, H / 2] },
      { op: 'setProperty', id: 'RB', path: '/anchor', value: [(3 * W) / 2 + FT / 2, H / 2] },
    ]);
  });

  it('keeps a continuing end for the neighbour, and jogs to a new junction', () => {
    // Kitchen's north side runs T → J2 (the cycle is counter-clockwise); at T it continues as W3.
    const r = committed(run(pair(), { op: 'resizeRoom', room: 'Kitchen', side: 'north', by: "1'" }));
    expect(r.resolved).toEqual([
      { op: 'addJunction', id: 'J5', level: 'L1', position: [W, H + FT] },
      { op: 'setProperty', id: 'W2', path: '/end', value: 'J5' },
      { op: 'addWall', id: 'W8', level: 'L1', start: 'T', end: 'J5', layers: core },
      { op: 'moveJunction', id: 'J2', to: [0, H + FT] },
      { op: 'setProperty', id: 'RA', path: '/anchor', value: [W / 2, H / 2 + FT / 2] },
    ]);
    // Both ends continue: the middle room of three, resized south.
    const three = doc({
      junctions: { A: [0, 0], B: [1000000, 0], C: [2000000, 0], D: [3000000, 0], E: [3000000, 1000000], F: [2000000, 1000000], G: [1000000, 1000000], Hh: [0, 1000000] },
      walls: {
        W1: { start: 'A', end: 'Hh' },
        W2: { start: 'Hh', end: 'G' },
        W3: { start: 'G', end: 'F', type: 'EXT', justification: 'exteriorFace' },
        W4: { start: 'F', end: 'E' },
        W5: { start: 'E', end: 'D' },
        W6: { start: 'D', end: 'C' },
        W7: { start: 'C', end: 'B' },
        W8: { start: 'B', end: 'A' },
        W9: { start: 'B', end: 'G' },
        W10: { start: 'C', end: 'F' },
      },
      types: { EXT: { kind: 'wallType', layers: core } },
      rooms: { R1: [500000, 500000], R2: [1500001, 500001], R3: [2500000, 500000] },
    });
    delete (three.walls as Record<string, Record<string, unknown>>).W3!.layers;
    const s = committed(run(three, { op: 'resizeRoom', room: 'R2', side: 'north', by: 300001 }));
    // R2's north side runs F → G; F continues east (W4), G continues west (W2).
    expect(s.resolved).toEqual([
      { op: 'addJunction', id: 'J1', level: 'L1', position: [2000000, 1300001] },
      { op: 'setProperty', id: 'W3', path: '/end', value: 'J1' },
      { op: 'addWall', id: 'W11', level: 'L1', start: 'F', end: 'J1', type: 'EXT', justification: 'exteriorFace' },
      { op: 'addJunction', id: 'J2', level: 'L1', position: [1000000, 1300001] },
      { op: 'setProperty', id: 'W3', path: '/start', value: 'J2' },
      { op: 'addWall', id: 'W12', level: 'L1', start: 'G', end: 'J2', type: 'EXT', justification: 'exteriorFace' },
      // 500001 + 300001/2 = 650001.5 → 650002, the anchor rounded once, ties to even
      { op: 'setProperty', id: 'R2', path: '/anchor', value: [1500001, 650002] },
    ]);
  });

  it('rejects a side that is missing, oblique or jogged with FS-OPS-008', () => {
    const tri = doc({
      junctions: { J1: [0, 0], J2: [0, 2000000], J3: [2000000, 0] },
      walls: { W1: { start: 'J1', end: 'J2' }, W2: { start: 'J2', end: 'J3' }, W3: { start: 'J3', end: 'J1' } },
      rooms: { R: [400000, 400000] },
    });
    rejectedWith(run(tri, { op: 'resizeRoom', room: 'R', side: 'north', by: 100 }), 'FS-OPS-008', ['R']);
    rejectedWith(run(tri, { op: 'resizeRoom', room: 'R', side: 'east', by: 100 }), 'FS-OPS-008', ['R']);
    const ell = doc({
      junctions: { A: [0, 0], B: [0, 2000000], C: [1000000, 2000000], D: [1000000, 1000000], E: [2000000, 1000000], F: [2000000, 0] },
      walls: { W1: { start: 'A', end: 'B' }, W2: { start: 'B', end: 'C' }, W3: { start: 'C', end: 'D' }, W4: { start: 'D', end: 'E' }, W5: { start: 'E', end: 'F' }, W6: { start: 'F', end: 'A' } },
      rooms: { R: [500000, 500000] },
    });
    rejectedWith(run(ell, { op: 'resizeRoom', room: 'R', side: 'north', by: 100 }), 'FS-OPS-008', ['R']);
    committed(run(ell, { op: 'resizeRoom', room: 'R', side: 'south', by: 100 }));
  });
});

describe('addOpening and moveOpening (4.5.1)', () => {
  const types = { D36: { kind: 'doorType', width: 36 * IN, height: 80 * IN }, WALLT: { kind: 'wallType', layers: core } };

  it('expands to addElement with the resolved offset', () => {
    const r = committed(run(pair(undefined, undefined, { types }), { op: 'addOpening', wall: 'W7', at: "1' from end", width: '30"', height: "6' 8\"", hinge: 'end', swing: 'left', name: 'Pocket' }));
    expect(r.resolved).toEqual([
      { op: 'addElement', collection: 'openings', id: 'O1', element: { wall: 'W7', offset: H - FT - 30 * IN, width: 30 * IN, height: 80 * IN, hinge: 'end', swing: 'left', name: 'Pocket' } },
    ]);
  });

  it('rejects an opening whose width resolves from neither member nor fill with FS-OPS-003', () => {
    rejectedWith(run(pair(undefined, undefined, { types }), { op: 'addOpening', wall: 'W7', at: 'centered' }), 'FS-OPS-003');
    rejectedWith(run(pair(undefined, undefined, { types }), { op: 'addOpening', wall: 'W7', at: 0, fill: 'WALLT' }), 'FS-OPS-003');
    rejectedWith(run(pair(undefined, undefined, { types }), { op: 'addOpening', wall: 'W7', at: 0, fill: 'NOPE' }), 'FS-OPS-003');
  });

  it('moveOpening sets the offset', () => {
    const d = pair(undefined, undefined, { types, openings: { O1: { wall: 'W7', offset: 0, fill: 'D36' } } });
    expect(committed(run(d, { op: 'moveOpening', opening: 'O1', at: 'centered' })).resolved).toEqual([{ op: 'setProperty', id: 'O1', path: '/offset', value: (H - 36 * IN) / 2 }]);
  });
});

describe('addRoom and setRoomFinish (4.6.1)', () => {
  it('names a face, and sets a finish', () => {
    const d = box(undefined, undefined, { materials: { OAK: { color: '#996633' } } });
    (d.junctions as Record<string, unknown>).JX = { level: 'L1', position: [1280000, 0] };
    (d.walls as Record<string, Record<string, unknown>>).W4!.end = 'JX';
    (d.walls as Record<string, unknown>).W5 = { level: 'L1', start: 'JX', end: 'J1', layers: core };
    delete (d.rooms as Record<string, unknown>).R1;
    const r = committed(run(d, { op: 'addRoom', level: 'L1', at: '1 m north of JX', name: 'Den', id: 'DEN' }, { op: 'setRoomFinish', room: 'den', surface: 'floor', material: 'OAK' }));
    expect(r.resolved).toEqual([
      { op: 'addElement', collection: 'rooms', id: 'DEN', element: { level: 'L1', anchor: [1280000, 1280000], name: 'Den' } },
      { op: 'setProperty', id: 'DEN', path: '/floorFinish', value: 'OAK' },
    ]);
  });
});

describe('removeWall (4.7.1)', () => {
  it('removes the room not kept, then the wall and its openings', () => {
    const d = pair(undefined, undefined, { types: { D: { kind: 'doorType', width: 914400, height: 2032000 } }, openings: { O1: { wall: 'W7', offset: 0, fill: 'D' } } });
    const r = committed(run(d, { op: 'removeWall', wall: 'wall between Kitchen and Dining', keep: 'Dining' }));
    expect(r.resolved).toEqual([
      { op: 'removeElement', id: 'RA' },
      { op: 'removeElement', id: 'W7', cascade: true },
    ]);
    expect(r.removed).toEqual(['O1', 'RA', 'W7']);
  });

  it('rejects a wall between two rooms removed without keep, or keeping neither, with FS-OPS-008', () => {
    rejectedWith(run(pair(), { op: 'removeWall', wall: 'W7' }), 'FS-OPS-008', ['W7']);
    const three = pair(undefined, undefined, { rooms: { RA: [100000, 100000], RB: [W + 100000, 100000], RC: [-5, -5] } });
    delete (three.rooms as Record<string, unknown>).RC;
    rejectedWith(run(pair(), { op: 'addRoom', id: 'RC', level: 'L1', at: [-1000, -1000] }, { op: 'removeWall', wall: 'W7', keep: 'RC' }), 'FS-OPS-008', ['W7']);
  });

  it('needs no keep when one side has no room', () => {
    // The face opens to the outside, so the room is left in no face: validation refuses it.
    const r = run(box(), { op: 'removeWall', wall: 'west wall of Kitchen' });
    rejectedWith(r, 'FS-INV-201', ['R1']);
    expect(committed(run(box(), { op: 'removeElement', id: 'R1' }, { op: 'removeWall', wall: 'W1' })).removed).toEqual(['R1', 'W1']);
  });
});
