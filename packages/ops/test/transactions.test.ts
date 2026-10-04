/** Chapter 1: the request, the six-step transaction, the result, ID minting; chapter 7: first failure wins. */
import { describe, expect, it } from 'vitest';
import { apply } from '../src/index.js';
import { B, box, committed, doc, rejectedWith, run } from './doc.js';

describe('the request (1.1.1: FS-OPS-001)', () => {
  const malformed: [string, unknown][] = [
    ['not an object', [{ op: 'removeElement', id: 'R1' }]],
    ['no batch', {}],
    ['a batch that is not an array', { batch: { op: 'removeElement', id: 'R1' } }],
    ['an empty batch', { batch: [] }],
    ['an unknown member of the request', { batch: [{ op: 'removeElement', id: 'R1' }], extra: 1 }],
    ['an operation that is not an object', { batch: ['removeElement'] }],
    ['an unknown operation', { batch: [{ op: 'deleteEverything' }] }],
    ['an operation with no op', { batch: [{ id: 'R1' }] }],
    ['a missing member', { batch: [{ op: 'moveJunction', id: 'J1' }] }],
    ['an unknown member', { batch: [{ op: 'moveJunction', id: 'J1', to: [0, 0], by: 'me' }] }],
    ['a member a shorthand does not list', { batch: [{ op: 'addSeparator', level: 'L1', start: 'J1', end: 'J3', name: 'x' }] }],
    ['a length that is not an integer', { batch: [{ op: 'moveWall', wall: 'W1', by: 1.5 }] }],
    ['a point of three numbers', { batch: [{ op: 'moveJunction', id: 'J1', to: [0, 0, 0] }] }],
    ['a boolean where a length goes', { batch: [{ op: 'resizeRoom', room: 'R1', side: 'east', by: true }] }],
    ['a side that is not one', { batch: [{ op: 'resizeRoom', room: 'R1', side: 'up', by: 1 }] }],
    ['a surface that is not one', { batch: [{ op: 'setRoomFinish', room: 'R1', surface: 'roof', material: 'M1' }] }],
    ['an unknown collection', { batch: [{ op: 'addElement', collection: 'roofs', element: {} }] }],
    ['cascade that is not a boolean', { batch: [{ op: 'removeElement', id: 'W1', cascade: 'yes' }] }],
    ['a context that is not an object', { batch: [{ op: 'removeElement', id: 'R1' }], context: [] }],
    ['an unknown context member', { batch: [{ op: 'removeElement', id: 'R1' }], context: { user: 'me' } }],
    ['retired that is not a list of IDs', { batch: [{ op: 'removeElement', id: 'R1' }], context: { retired: [1] } }],
    ['a lock of two kinds', { batch: [{ op: 'removeElement', id: 'R1' }], context: { locks: [{ element: 'W1', length: 'W1' }] } }],
    ['a distance lock of one wall', { batch: [{ op: 'removeElement', id: 'R1' }], context: { locks: [{ distance: ['W1'] }] } }],
  ];
  it.each(malformed)('rejects %s', (_name, request) => {
    rejectedWith(apply(box(), request as object), 'FS-OPS-001', []);
  });

  it('reads a request as JSON text, where 1.0 is not an integer', () => {
    rejectedWith(apply(box(), '{"batch":[{"op":"moveJunction","id":"J1","to":[1.0,0]}]}'), 'FS-OPS-001');
    committed(apply(box(), '{"batch":[{"op":"moveJunction","id":"J1","to":[1,0]}]}'));
    rejectedWith(apply(box(), '{"batch":[}'), 'FS-OPS-001');
    rejectedWith(apply(box(), '{"batch":[],"batch":[{"op":"removeElement","id":"R1"}]}'), 'FS-OPS-001');
  });

  it('points the diagnostic at the member that failed', () => {
    const r = apply(box(), { batch: [{ op: 'removeElement', id: 'R1' }, { op: 'moveJunction', id: 'J1', to: [0, 0], by: 1 }] });
    expect(r.status === 'rejected' && r.diagnostics[0]!.location.pointer).toBe('/batch/1/by');
  });
});

describe('the transaction (1.2)', () => {
  it('rejects an invalid document with FS-OPS-002 (1.2.1)', () => {
    const bad = box();
    (bad.junctions as Record<string, { position: number[] }>).J2!.position = [0, 0];
    rejectedWith(run(bad, { op: 'removeElement', id: 'R1' }), 'FS-OPS-002', []);
    rejectedWith(apply('{"floorspec":"0.1"', { batch: [{ op: 'removeElement', id: 'R1' }] }), 'FS-OPS-002');
    rejectedWith(apply({ floorspec: '9.9', project: { name: 'x' } }, { batch: [{ op: 'removeElement', id: 'R1' }] }), 'FS-OPS-002');
  });

  it('commits a batch that passes through invalid states, judging only its end (1.2)', () => {
    // Draw a closed room wall by wall: after the first wall nothing encloses the anchor.
    const empty = doc({ junctions: {}, walls: {} });
    const r = run(
      empty,
      { op: 'addRoom', level: 'L1', at: [1000000, 1000000], name: 'Den' },
      { op: 'drawWall', level: 'L1', from: [0, 0], to: [0, 2000000], layers: [{ thickness: 12800, function: 'core' }] },
      { op: 'drawWall', level: 'L1', from: 'J2', to: [2000000, 2000000], layers: [{ thickness: 12800, function: 'core' }] },
      { op: 'drawWall', level: 'L1', from: 'J3', to: [2000000, 0], layers: [{ thickness: 12800, function: 'core' }] },
      { op: 'drawWall', level: 'L1', from: 'J4', to: 'J1', layers: [{ thickness: 12800, function: 'core' }] },
    );
    expect(committed(r).created).toEqual(['J1', 'J2', 'J3', 'J4', 'R1', 'W1', 'W2', 'W3', 'W4']);
  });

  it('rejects the whole batch and leaves A exactly as it was (1.2.2)', () => {
    const a = box();
    const before = JSON.stringify(a);
    const r = run(a, { op: 'moveJunction', id: 'J1', to: [-100000, 0] }, { op: 'removeElement', id: 'W99' });
    rejectedWith(r, 'FS-OPS-003');
    expect(JSON.stringify(a)).toBe(before);
    // A committed batch does not touch its input either.
    committed(run(a, { op: 'moveJunction', id: 'J1', to: [-100000, 0] }));
    expect(JSON.stringify(a)).toBe(before);
  });

  it('carries the Core error diagnostics of an invalid result (1.2.3)', () => {
    // Moving the anchor onto a wall: FS-INV-201, and nothing else.
    const r = run(box(), { op: 'setProperty', id: 'R1', path: '/anchor', value: [0, 1000000] });
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.diagnostics.map((d) => [d.code, d.severity, d.elements])).toEqual([['FS-INV-201', 'error', ['R1']]]);
  });

  it('reports only the first failure (7)', () => {
    const r = run(box(), { op: 'removeElement', id: 'nope' }, { op: 'moveWall', wall: 'W1', by: 'two feet' });
    expect(r.status === 'rejected' && r.diagnostics.map((d) => d.code)).toEqual(['FS-OPS-003']);
  });
});

describe('the result (1.3)', () => {
  it('is the canonical form, its hash, the echo, what changed and the inverse', () => {
    const r = committed(run(box(), { op: 'setProperty', id: 'W1', path: '/justification', value: 'center' }, { op: 'setProperty', id: '$project', path: '/name', value: 'Mine' }));
    expect(r.document.endsWith('}\n')).toBe(true);
    expect(r.document).not.toContain('"justification"'); // a constant default is omitted (Core 9.2)
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.created).toEqual([]);
    expect(r.removed).toEqual([]);
    // The inverse compares canonical content, so setting a member to its default is no difference.
    expect(r.inverse).toEqual([{ op: 'setProperty', id: '$project', path: '/name', value: 'Test' }]);
  });

  it('is the same, byte for byte, every run (1.3.2)', () => {
    const batch = [
      { op: 'drawWall', level: 'L1', from: [1234567, -500000], to: [2765431, 3300001] },
      { op: 'resizeRoom', room: 'Kitchen', side: 'west', by: '-1 1/3"' },
    ];
    const first = JSON.stringify(apply(box(), { batch }));
    for (let i = 0; i < 3; i++) expect(JSON.stringify(apply(box(), { batch }))).toBe(first);
  });
});

describe('minting IDs (1.5)', () => {
  it('mints one more than the largest number among the IDs with the prefix (1.5.1)', () => {
    const d = box(undefined, undefined, { extra: { slabs: { SL7: { level: 'L1', boundary: [[0, 0], [10, 0], [10, 10]], thickness: 100 } } } });
    const r = committed(run(d, { op: 'drawSeparator', level: 'L1', from: [5000000, 0], to: [6000000, 0] }));
    // S counts S<n> only — SL7 is not ^S[0-9]+$.
    expect(r.created).toEqual(['J5', 'J6', 'S1']);
  });

  it('counts IDs minted earlier in the batch, even ones since removed', () => {
    const r = committed(
      run(
        box(),
        { op: 'drawWall', level: 'L1', from: [100000, 100000], to: [200000, 100000], layers: [{ thickness: 12800, function: 'core' }] },
        { op: 'removeElement', id: 'W5' },
        { op: 'drawWall', level: 'L1', from: 'J5', to: [100000, 300000], layers: [{ thickness: 12800, function: 'core' }] },
      ),
    );
    expect(r.created).toEqual(['J5', 'J6', 'J7', 'W6']);
  });

  it('does not count an ID of A removed earlier in the batch unless it is retired (1.5, as written)', () => {
    const r = committed(run(box(), { op: 'removeElement', id: 'R1' }, { op: 'removeElement', id: 'W4', cascade: true }, { op: 'drawWall', level: 'L1', from: 'J4', to: 'J1', layers: [{ thickness: 12800, function: 'core' }] }));
    expect(r.resolved.at(-1)).toMatchObject({ op: 'addWall', id: 'W4' });
    const retired = committed(apply(box(), { batch: [{ op: 'removeElement', id: 'R1' }, { op: 'removeElement', id: 'W4', cascade: true }, { op: 'drawWall', level: 'L1', from: 'J4', to: 'J1', layers: [{ thickness: 12800, function: 'core' }] }], context: { retired: ['W4'] } }));
    expect(retired.resolved.at(-1)).toMatchObject({ op: 'addWall', id: 'W5' });
  });

  it('counts retired IDs, and never reuses one', () => {
    const r = committed(apply(box(), { batch: [{ op: 'drawWall', level: 'L1', from: [100000, 100000], to: [200000, 100000], layers: [{ thickness: 12800, function: 'core' }] }], context: { retired: ['W41', 'J1000', 'X9'] } }));
    expect(r.created).toEqual(['J1001', 'J1002', 'W42']);
  });

  it('mints from the decimal value, whatever its digits', () => {
    const d = box();
    (d.walls as Record<string, unknown>).W007 = (d.walls as Record<string, unknown>).W1;
    delete (d.walls as Record<string, unknown>).W1;
    (d.walls as Record<string, unknown>).W10 = (d.walls as Record<string, unknown>).W2;
    delete (d.walls as Record<string, unknown>).W2;
    const r = committed(run(d, { op: 'drawWall', level: 'L1', from: [100000, 100000], to: [200000, 100000], layers: [{ thickness: 12800, function: 'core' }] }));
    expect(r.created).toContain('W11');
  });

  it('rejects a named ID already in use or retired with FS-OPS-005 (1.5.2)', () => {
    rejectedWith(run(box(), { op: 'addRoom', id: 'W1', level: 'L1', at: [100, 100] }), 'FS-OPS-005', []);
    rejectedWith(apply(box(), { batch: [{ op: 'addRoom', id: 'R0', level: 'L1', at: [100, 100] }], context: { retired: ['R0'] } }), 'FS-OPS-005');
    rejectedWith(run(box(), { op: 'addJunction', id: 'J9', level: 'L1', position: [5, 5] }, { op: 'addJunction', id: 'J9', level: 'L1', position: [6, 6] }), 'FS-OPS-005');
    // A name removed earlier in the batch may be used again.
    committed(run(box(), { op: 'removeElement', id: 'R1' }, { op: 'addRoom', id: 'R1', level: 'L1', at: [100000, 100000] }));
  });

  it('accepts an element under the ID it names', () => {
    const b = B(run(box(), { op: 'addElement', collection: 'materials', id: 'oak', element: { color: '#aa7744' } }));
    expect(b.materials).toEqual({ oak: { color: '#aa7744' } });
  });
});
