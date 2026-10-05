/**
 * Ops 0.3 beside Ops 0.2 (0.4): no new operation and no new member — Ops 0.3 is Ops 0.2 applied to
 * Core 0.3 documents. A door or window type's `operation` and `clearOpening`, and an opening's own
 * `clearOpening`, are members a batch sets and unsets like any other (2.3), and the result is judged
 * by Core 0.3's invariants. The conformance suites are the oracle; these are readable examples.
 */
import { describe, expect, it } from 'vitest';
import { apply, OPS_VERSIONS } from '../src/index.js';
import { B, committed, MM, pair, rejectedWith } from './doc.js';

const door = { kind: 'doorType', width: 914 * MM, height: 2032 * MM, operation: 'swing', clearOpening: { width: 813 * MM, height: 2000 * MM } };
const window = { kind: 'windowType', width: 900 * MM, height: 1200 * MM, sill: 600 * MM, operation: 'casement', clearOpening: { width: 560 * MM, height: 1050 * MM, area: 588_000 * MM * MM } };

/** The two-room plan as a Core 0.3 document, with a door in W7 and a window in W1. */
const pair03 = (): Record<string, unknown> => ({
  ...pair(undefined, undefined, {
    types: { D: door, G: window },
    openings: { O1: { wall: 'W7', offset: 500 * MM, fill: 'D' }, O2: { wall: 'W1', offset: 500 * MM, fill: 'G' } },
  }),
  floorspec: '0.3',
});

describe('Ops 0.3', () => {
  it('is a draft this applier implements, beside 0.2 and 0.1', () => {
    expect(OPS_VERSIONS).toEqual(['0.1', '0.2', '0.3', '0.4']);
  });

  it('applies to a Core 0.3 document; Ops 0.2 rejects one with FS-OPS-002', () => {
    committed(apply(pair03(), { batch: [{ op: 'moveWall', wall: 'W7', by: 1000 }] }));
    rejectedWith(apply(pair03(), { batch: [{ op: 'moveWall', wall: 'W7', by: 1000 }] }, { ops: '0.2' }), 'FS-OPS-002', []);
  });

  it('makes a 0.2 document declare "0.3" with setProperty of $document /floorspec, which Ops 0.2 cannot', () => {
    const d02 = { ...pair(), floorspec: '0.2' };
    const upgrade = { batch: [{ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.3' }] };
    const r = committed(apply(d02, upgrade));
    expect((JSON.parse(r.document) as { floorspec: string }).floorspec).toBe('0.3');
    expect(r.inverse).toEqual([{ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.2' }]);
    expect(apply(d02, upgrade, { ops: '0.2' }).status).toBe('rejected');
  });

  it('applies a 0.2 request to a 0.2 document exactly as Ops 0.2 does', () => {
    const d02 = { ...pair(), floorspec: '0.2' };
    const request = { batch: [{ op: 'addProgramItem', function: 'kitchen', name: 'Kitchen' }, { op: 'moveWall', wall: 'W7', by: "1'" }] };
    expect(JSON.stringify(apply(d02, request, { ops: '0.3' }))).toBe(JSON.stringify(apply(d02, request, { ops: '0.2' })));
  });

  it('sets and unsets operation and clear openings like any other member', () => {
    const r = committed(
      apply(pair03(), {
        batch: [
          { op: 'setProperty', id: 'D', path: '/operation', value: 'pocket' },
          { op: 'setProperty', id: 'O2', path: '/clearOpening', value: { width: 500 * MM, height: 1000 * MM } },
          { op: 'unsetProperty', id: 'G', path: '/clearOpening/area' },
        ],
      }),
    );
    const b = B(r);
    expect(b.types!.D!.operation).toBe('pocket');
    expect(b.openings!.O2!.clearOpening).toEqual({ width: 500 * MM, height: 1000 * MM });
    expect(b.types!.G!.clearOpening).toEqual({ width: 560 * MM, height: 1050 * MM });
    // The inverse puts every one of them back.
    const back = committed(apply(r.document, { batch: r.inverse }));
    expect(back.hash).toBe(committed(apply(pair03(), { batch: [{ op: 'moveJunction', id: 'J1', to: [0, 0] }] })).hash);
  });

  it("judges the result by Core 0.3's invariants: a clear opening never larger than its opening or its type", () => {
    // Narrower than the type's clear width: the opening keeps the type's clear opening (FS-INV-305).
    rejectedWith(apply(pair03(), { batch: [{ op: 'setProperty', id: 'O1', path: '/width', value: 800 * MM }] }), 'FS-INV-305', ['O1']);
    // A type's clear opening taller than the type (FS-INV-307).
    rejectedWith(apply(pair03(), { batch: [{ op: 'setProperty', id: 'D', path: '/clearOpening/height', value: 2100 * MM }] }), 'FS-INV-307', ['D']);
    // A clear area larger than its width times its height (FS-INV-306), and an area on a door's own clear opening (FS-INV-308).
    rejectedWith(apply(pair03(), { batch: [{ op: 'setProperty', id: 'G', path: '/clearOpening/area', value: 560 * 1051 * MM * MM }] }), 'FS-INV-306', ['G']);
    rejectedWith(apply(pair03(), { batch: [{ op: 'setProperty', id: 'O1', path: '/clearOpening', value: { width: 800 * MM, height: 2000 * MM, area: 1 } }] }), 'FS-INV-308', ['O1']);
    // A door's operation must be a door operation (the schema, FS-SCH-001).
    rejectedWith(apply(pair03(), { batch: [{ op: 'setProperty', id: 'D', path: '/operation', value: 'casement' }] }), 'FS-SCH-001');
  });

  it("moves a vaulted ceiling's ridge with its room, and leaves it where it is when one wall moves (FS-OPS-4.3.2)", () => {
    const vault = { kind: 'vaulted', ridge: [[0, 1_400_000], [3_900_000, 1_400_000]], pitch: { rise: 4, run: 12 } };
    const d = { ...pair(undefined, undefined, { rooms: { RA: { anchor: [1_950_000, 1_400_000], name: 'Kitchen', ceiling: vault }, RB: [5_850_000, 1_400_000] } }), floorspec: '0.3' };
    const moved = B(apply(d, { batch: [{ op: 'moveRoom', room: 'Kitchen', by: [1000, 0] }] }));
    expect(moved.rooms!.RA!.ceiling).toEqual({ ...vault, ridge: [[1000, 1_400_000], [3_901_000, 1_400_000]] });
    const wall = B(apply(d, { batch: [{ op: 'moveWall', wall: 'W1', by: -1000 }] }));
    expect(wall.rooms!.RA!.ceiling).toEqual(vault);
  });

  it('adds a roof and a stair under minted IDs (RF, ST), and Ops 0.2 refuses both collections with FS-OPS-001', () => {
    const d = { ...pair(), floorspec: '0.3', levels: { L1: { building: 'B1', elevation: 0, height: 2_700_000 }, L2: { building: 'B1', elevation: 3_000_000, height: 2_700_000 } } };
    const roof = { level: 'L1', footprint: [[0, 0], [7_800_000, 0], [7_800_000, 2_800_000], [0, 2_800_000]], pitch: { rise: 6, run: 12 } };
    const stair = { level: 'L1', to: 'L2', position: [500_000, 1_400_000], width: 900_000, tread: 280_000, maxRiser: 190_000 };
    const r = committed(apply(d, { batch: [{ op: 'addElement', collection: 'roofs', element: roof }, { op: 'addElement', collection: 'stairs', element: stair }] }));
    expect(Object.keys(B(r).roofs!)).toEqual(['RF1']);
    expect(Object.keys(B(r).stairs!)).toEqual(['ST1']);
    // The inverse removes the roof before the stair (1.6), and removing L2 takes the stair with it (2.2).
    expect(r.inverse).toEqual([{ op: 'removeElement', id: 'RF1' }, { op: 'removeElement', id: 'ST1' }]);
    rejectedWith(apply(r.document, { batch: [{ op: 'removeElement', id: 'L2' }] }), 'FS-OPS-006', ['L2', 'ST1']);
    expect(B(committed(apply(r.document, { batch: [{ op: 'removeElement', id: 'L2', cascade: true }] }))).stairs).toBeUndefined();
    const d02 = { ...pair(), floorspec: '0.2' };
    rejectedWith(apply(d02, { batch: [{ op: 'addElement', collection: 'roofs', element: roof }] }, { ops: '0.2' }), 'FS-OPS-001', []);
  });
});

describe('Ops 0.4', () => {
  it('applies to a Core 0.4 document; Ops 0.3 rejects one with FS-OPS-002', () => {
    const d04 = { ...pair03(), floorspec: '0.4' };
    committed(apply(d04, { batch: [{ op: 'moveWall', wall: 'W7', by: 1000 }] }));
    rejectedWith(apply(d04, { batch: [{ op: 'moveWall', wall: 'W7', by: 1000 }] }, { ops: '0.3' }), 'FS-OPS-002', []);
  });

  it('upgrades a 0.3 document to 0.4 with setProperty of $document /floorspec, which Ops 0.3 cannot', () => {
    const upgrade = { batch: [{ op: 'setProperty', id: '$document', path: '/floorspec', value: '0.4' }] };
    const r = committed(apply(pair03(), upgrade));
    expect((JSON.parse(r.document) as { floorspec: string }).floorspec).toBe('0.4');
    expect(apply(pair03(), upgrade, { ops: '0.3' }).status).toBe('rejected');
  });
});
