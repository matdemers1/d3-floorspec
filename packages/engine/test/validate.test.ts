/** The validator's tiers and catalogue (chapter 10), on small hand-built documents. */
import { describe, expect, it } from 'vitest';
import { check, validate } from '../src/index.js';
import { box, codes, doc } from './doc.js';

const T = 12800;
const text = (o: unknown): string => JSON.stringify(o);

describe('tiers (10.1, 10.3)', () => {
  it('parse errors stop everything', () => {
    expect(codes(validate('{"floorspec":"0.1","floorspec":"0.1"}'))).toEqual(['FS-JSON-002']);
  });

  it('FS-DOC-001: an unimplemented version, before the schema', () => {
    expect(codes(validate(text({ floorspec: '0.5', project: { name: 'x' }, bogus: 1 })))).toEqual(['FS-DOC-001']);
    // a Core 0.1 reader does not implement 0.2, a Core 0.2 reader 0.3, and a Core 0.3 reader 0.4
    expect(codes(validate(text({ floorspec: '0.2', project: { name: 'x' } }), { core: '0.1' }))).toEqual(['FS-DOC-001']);
    expect(codes(validate(text({ floorspec: '0.3', project: { name: 'x' } }), { core: '0.2' }))).toEqual(['FS-DOC-001']);
    expect(codes(validate(text({ floorspec: '0.4', project: { name: 'x' } }), { core: '0.3' }))).toEqual(['FS-DOC-001']);
    expect(validate(text({ floorspec: '0.2', project: { name: 'x' } })).valid).toBe(true);
    expect(validate(text({ floorspec: '0.3', project: { name: 'x' } })).valid).toBe(true);
    expect(validate(text({ floorspec: '0.4', project: { name: 'x' } })).valid).toBe(true);
  });

  it('applies the schema of the draft a document declares (1.2.6)', () => {
    const program = { items: { K: { function: 'kitchen' } } };
    expect(validate({ floorspec: '0.2', project: { name: 'x' }, program }).valid).toBe(true);
    expect(validate({ floorspec: '0.3', project: { name: 'x' }, program }).valid).toBe(true);
    expect(codes(validate({ floorspec: '0.1', project: { name: 'x' }, program }))).toEqual(['FS-SCH-001']);
    const types = { D: { kind: 'doorType', width: 1152000, height: 2688000, operation: 'swing', clearOpening: { width: 1040384, height: 2600960 } } };
    expect(validate({ floorspec: '0.3', project: { name: 'x' }, types }).valid).toBe(true);
    expect(new Set(codes(validate({ floorspec: '0.2', project: { name: 'x' }, types })))).toEqual(new Set(['FS-SCH-001']));
  });

  it('FS-DOC-002: a well-formed required extension this reader does not implement', () => {
    const d = { ...doc(box(1e6, 1e6)), extensionsUsed: { EXT_acoustics: '1.0' }, extensionsRequired: ['EXT_acoustics'] };
    expect(codes(validate(d))).toEqual(['FS-DOC-002']);
    expect(validate(d, { extensions: ['EXT_acoustics'] }).valid).toBe(true);
  });

  it('a number written with a fraction is not a length (10.1)', () => {
    const t = text(doc(box(1e6, 1e6))).replace('"elevation":0', '"elevation":0.0');
    expect(codes(validate(t))).toEqual(['FS-SCH-001']);
    // …but is any JSON number inside extras
    const u = text({ ...doc(box(1e6, 1e6)), extras: { x: 1 } }).replace('"x":1', '"x":1.0');
    expect(validate(u).valid).toBe(true);
  });

  it('reference invariants stop the graph tier', () => {
    const d = doc({ junctions: { J1: [0, 0], J2: [0, 0] }, walls: { W1: { start: 'J1', end: 'J9' } } });
    expect(codes(validate(d))).toEqual(['FS-INV-002 W1']);
  });
});

describe('reference invariants', () => {
  it('FS-INV-001: an ID in two collections', () => {
    const d = doc(box(1e6, 1e6));
    (d.buildings as Record<string, unknown>).W1 = {};
    expect(codes(validate(d))).toEqual(['FS-INV-001 W1']);
  });

  it('FS-INV-003: a wall type of the wrong kind', () => {
    const d = doc({ junctions: { J1: [0, 0], J2: [1e6, 0] }, walls: { W1: { start: 'J1', end: 'J2' } } });
    const w = (d.walls as Record<string, Record<string, unknown>>).W1!;
    delete w.layers;
    w.type = 'D';
    d.types = { D: { kind: 'doorType' } };
    expect(codes(validate(d))).toEqual(['FS-INV-003 W1']);
  });

  it('FS-INV-007: an edge junction on another level', () => {
    const d = doc({ junctions: { J1: [0, 0], J2: { position: [1e6, 0], level: 'L2' } }, walls: { W1: { start: 'J1', end: 'J2' } } });
    (d.levels as Record<string, unknown>).L2 = { building: 'B1', elevation: 3200000, height: 3200000 };
    expect(codes(validate(d))).toEqual(['FS-INV-007 J2,W1']);
  });

  it('FS-INV-009: a self-intersecting slab', () => {
    const d = { ...doc(box(1e6, 1e6)), slabs: { S1: { level: 'L1', thickness: 1000, boundary: [[0, 0], [10, 10], [10, 0], [0, 10]] } } };
    expect(codes(validate(d))).toEqual(['FS-INV-009 S1']);
  });
});

describe('graph invariants', () => {
  it('FS-INV-101/102/103', () => {
    const d = doc({
      junctions: { J1: [0, 0], J2: [0, 0], J3: [1e6, 0] },
      walls: { W1: { start: 'J1', end: 'J1' }, W2: { start: 'J2', end: 'J3' }, W3: { start: 'J3', end: 'J2' } },
    });
    expect(codes(validate(d))).toEqual(['FS-INV-101 J1,J2', 'FS-INV-102 W1', 'FS-INV-103 W2,W3']);
  });

  it('FS-INV-104: a crossing; FS-INV-105/106: a T without a junction and an overlap', () => {
    const cross = doc({ junctions: { A: [0, 0], B: [2e6, 0], C: [1e6, -1e6], D: [1e6, 1e6] }, walls: { W1: { start: 'A', end: 'B' }, W2: { start: 'C', end: 'D' } } });
    expect(codes(validate(cross))).toEqual(['FS-INV-104 W1,W2']);
    const tee = doc({ junctions: { A: [0, 0], B: [2e6, 0], C: [1e6, 0], D: [1e6, 1e6] }, walls: { W1: { start: 'A', end: 'B' }, W2: { start: 'C', end: 'D' } } });
    expect(codes(validate(tee))).toEqual(['FS-INV-105 C,W1']);
    const overlap = doc({ junctions: { A: [0, 0], B: [2e6, 0], C: [1e6, 0] }, walls: { W1: { start: 'A', end: 'B' }, W2: { start: 'A', end: 'C' } } });
    expect(codes(validate(overlap))).toEqual(['FS-INV-105 C,W1', 'FS-INV-106 W1,W2']);
  });

  it('FS-INV-107/108 with the fix for 108', () => {
    const d = doc({
      junctions: { A: [0, 0], B: [1e6, 0], C: [2e6, 0] },
      walls: {
        W1: { start: 'A', end: 'B', layers: [] as never },
        W2: { start: 'B', end: 'C', justification: 'coreFace', layers: [{ thickness: 1, function: 'finish' }] },
      },
    });
    delete (d.walls as Record<string, Record<string, unknown>>).W1!.layers;
    const r = validate(d);
    expect(codes(r)).toEqual(['FS-INV-107 W1', 'FS-INV-108 W2']);
    expect(r.diagnostics[1]!.fix).toEqual([{ op: 'set', id: 'W2', member: '/justification', value: 'center' }]);
  });

  it('FS-INV-111: a one-wall butt at a junction with three edges', () => {
    const d = doc({
      junctions: { A: [0, 0], B: { position: [1e6, 0], join: { kind: 'butt', through: ['W1'] } }, C: [2e6, 0], D: [1e6, 1e6] },
      walls: { W1: { start: 'A', end: 'B' }, W2: { start: 'B', end: 'C' }, W3: { start: 'B', end: 'D' } },
    });
    expect(codes(validate(d))).toEqual(['FS-INV-111 B']);
  });

  it('FS-INV-112: a top not above the base', () => {
    const d = doc({ junctions: { A: [0, 0], B: [1e6, 0] }, walls: { W1: { start: 'A', end: 'B', top: { height: 0 } } } });
    expect(codes(validate(d))).toEqual(['FS-INV-112 W1']);
  });
});

describe('join and room invariants', () => {
  it('FS-INV-109: a stub too short for the joins at its ends', () => {
    const d = doc({
      junctions: { A: [0, -1e6], B: [0, 0], C: [0, 1e6], D: [1000, -1e6], E: [1000, 0], F: [1000, 1e6] },
      walls: {
        W1: { start: 'A', end: 'B', t: 100000 },
        W2: { start: 'B', end: 'C', t: 100000 },
        W3: { start: 'D', end: 'E', t: 100000 },
        W4: { start: 'E', end: 'F', t: 100000 },
        S: { start: 'B', end: 'E', t: 100000 },
      },
    });
    expect(codes(validate(d))).toContain('FS-INV-109 S');
  });

  it('FS-INV-201/202/204', () => {
    const outside = doc(box(1e6, 1e6, T, { rooms: { R1: [2e6, 2e6] } }));
    expect(codes(validate(outside))).toEqual(['FS-INV-201 R1']);
    const onLine = doc(box(1e6, 1e6, T, { rooms: { R1: [0, 5e5] } }));
    expect(codes(validate(onLine))).toEqual(['FS-INV-201 R1']);
    const two = doc(box(1e6, 1e6, T, { rooms: { R1: [5e5, 5e5], R2: [4e5, 4e5] } }));
    const r = validate(two);
    expect(codes(r)).toEqual(['FS-INV-202 R1,R2']);
    expect(r.diagnostics[0]!.fix).toEqual([{ op: 'remove', id: 'R2' }]);
    const inWall = doc(box(1e6, 1e6, T, { rooms: { R1: [1000, 5e5] } }));
    expect(codes(validate(inWall))).toEqual(['FS-INV-204 R1']);
  });

  it('FS-INV-203 and FS-LINT-003/004: a face between walls closer than their thickness', () => {
    const narrow = (rooms: Record<string, [number, number]>) =>
      doc({
        junctions: { A: [0, 0], B: [0, 10000], C: [1e6, 10000], D: [1e6, 0] },
        walls: { W2: { start: 'B', end: 'C' }, W4: { start: 'D', end: 'A' } },
        separators: { S1: { start: 'A', end: 'B' }, S3: { start: 'C', end: 'D' } },
        rooms,
      });
    expect(codes(validate(narrow({ R1: [5e5, 5000] })))).toEqual(['FS-INV-203 R1']);
    const r = check(narrow({}));
    expect(codes(r)).toEqual(['FS-LINT-003', 'FS-LINT-004']);
    expect(r.derived!.unanchored).toEqual([]);
  });
});

describe('opening invariants', () => {
  const withOpenings = (openings: Record<string, Record<string, unknown>>) =>
    doc({ junctions: { A: [0, 0], B: [1e6, 0] }, walls: { W1: { start: 'A', end: 'B' } }, openings });

  it('FS-INV-301: no width', () => {
    expect(codes(validate(withOpenings({ O1: { wall: 'W1', offset: 0, height: 1 } })))).toEqual(['FS-INV-301 O1']);
  });
  it('FS-INV-302 with its fix', () => {
    const r = validate(withOpenings({ O1: { wall: 'W1', offset: 500000, width: 600000, height: 1 } }));
    expect(codes(r)).toEqual(['FS-INV-302 O1']);
    expect(r.diagnostics[0]!.fix).toEqual([{ op: 'set', id: 'O1', member: '/offset', value: 400000 }]);
  });
  it('FS-INV-303 and FS-INV-304; a transom over a door is fine', () => {
    expect(codes(validate(withOpenings({ O1: { wall: 'W1', offset: 0, width: 1, height: 3200001 } })))).toEqual(['FS-INV-303 O1']);
    expect(
      codes(validate(withOpenings({ O1: { wall: 'W1', offset: 100000, width: 1000, height: 1000 }, O2: { wall: 'W1', offset: 100500, width: 1000, height: 1000 } }))),
    ).toEqual(['FS-INV-304 O1,O2']);
    const transom = withOpenings({ D: { wall: 'W1', offset: 100000, width: 1000, height: 1000 }, T: { wall: 'W1', offset: 100000, width: 1000, height: 1000, sill: 1000 } });
    expect(validate(transom).valid).toBe(true);
  });
});

describe('lints (only for a valid document)', () => {
  it('FS-LINT-001 acute join, 002 unused junction, 006 unused type, 007 external asset', () => {
    const d = doc({
      junctions: { A: [0, 0], B: [1e6, 0], C: [1e6, 1e5], Z: [5e6, 5e6] },
      walls: { W1: { start: 'B', end: 'A' }, W2: { start: 'B', end: 'C' }, W3: { start: 'A', end: 'C' } },
    });
    // At A: W1 leaves east-ish? W1 runs B→A, so from A it leaves east (1e6, 0); W3 leaves to (1e6, 1e5): ~5.7°.
    Object.assign(d, {
      types: { T: { kind: 'doorType' } },
      assets: { X: { uri: 'https://example.com/a.png', sha256: '0'.repeat(64), mediaType: 'image/png' } },
    });
    const r = validate(d);
    expect(r.valid).toBe(true);
    expect(codes(r)).toEqual(expect.arrayContaining(['FS-LINT-001 A,W1,W3', 'FS-LINT-002 Z', 'FS-LINT-006 T', 'FS-LINT-006 X', 'FS-LINT-007 X']));
  });

  it('FS-LINT-005: an opening reaching into a corner', () => {
    const d = doc({
      junctions: { A: [0, 0], B: [1e6, 0], C: [1e6, 1e6] },
      walls: { W1: { start: 'A', end: 'B', t: T }, W2: { start: 'B', end: 'C', t: T } },
      openings: { O1: { wall: 'W1', offset: 990000, width: 4000, height: 1 }, O2: { wall: 'W1', offset: 990000, width: 3600, height: 1, sill: 10 } },
    });
    // W1's faces end at x = 993600 (inside) and 1006400 (outside); the farther from B is 993600.
    expect(codes(validate(d))).toEqual(['FS-LINT-005 O1']);
  });

  it('diagnostics are sorted by code, then elements', () => {
    const d = doc({ junctions: { Z: [9, 9], A: [8, 8], J1: [0, 0], J2: [1e6, 0] }, walls: { W1: { start: 'J1', end: 'J2' } } });
    expect(codes(validate(d))).toEqual(['FS-LINT-002 A', 'FS-LINT-002 Z']);
  });
});
