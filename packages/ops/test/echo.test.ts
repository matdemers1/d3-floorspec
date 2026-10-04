/** 1.4.1: the resolved echo replays to the same B; 1.6.1: the inverse turns B back into A. */
import { canonicalize } from '@floorspec/engine';
import { describe, expect, it } from 'vitest';
import { apply } from '../src/index.js';
import { box, committed, doc, IN, pair } from './doc.js';

const core = [{ thickness: 12800, function: 'core' }];
const door = { D36: { kind: 'doorType', width: 36 * IN, height: 80 * IN } };

/** Batches whose inverse the specification's order (1.6) can apply. */
const scenarios: [string, () => object, unknown[]][] = [
  ['a property', box, [{ op: 'setProperty', id: 'W1', path: '/name', value: 'West' }]],
  ['the project, the site and the document', box, [{ op: 'setProperty', id: '$project', path: '/description', value: 'd' }, { op: 'setProperty', id: '$site', path: '/trueNorth', value: 5 }, { op: 'setProperty', id: '$document', path: '/extras', value: { a: 1 } }]],
  ['moveWall', box, [{ op: 'moveWall', wall: 'east wall of Kitchen', by: "2' 6 1/2\"" }]],
  ['moveWall toward', pair, [{ op: 'moveWall', wall: 'W7', by: "1'", toward: 'Dining' }]],
  ['moveRoom', pair, [{ op: 'moveRoom', room: 'Dining', by: "1' 6\" west" }]],
  ['resizeRoom', pair, [{ op: 'resizeRoom', room: 'Kitchen', side: 'east', by: "-1'" }]],
  ['addOpening', () => pair(undefined, undefined, { types: door }), [{ op: 'addOpening', wall: 'wall between Kitchen and Dining', at: 'centered', fill: 'D36' }]],
  ['removeWall', () => pair(undefined, undefined, { types: door, openings: { O1: { wall: 'W7', offset: 0, fill: 'D36' } } }), [{ op: 'removeWall', wall: 'W7', keep: 'Kitchen' }]],
  ['a cascade', () => pair(undefined, undefined, { types: door, openings: { O1: { wall: 'W7', offset: 0, fill: 'D36' } } }), [{ op: 'removeElement', id: 'B1', cascade: true }]],
  ['drawWall outside', box, [{ op: 'drawWall', level: 'L1', from: 'J3', to: "2 m east of J3", layers: core }, { op: 'addRoom', level: 'L1', at: [100, 100], id: 'RZ' }, { op: 'removeElement', id: 'RZ' }]],
  [
    'a separator and a room',
    () => box(undefined, undefined, { rooms: { R1: [1000000, 2000000] } }),
    [{ op: 'drawSeparator', level: 'L1', from: 'J1', to: 'J3' }, { op: 'addRoom', level: 'L1', at: [3000000, 500000], name: 'Nook' }],
  ],
  ['a site created', box, [{ op: 'setProperty', id: '$site', path: '/trueNorth', value: 5 }]],
  ['a site removed', () => box(undefined, undefined, { extra: { site: { trueNorth: 7, location: { latitude: 1, longitude: 2 } } } }), [{ op: 'unsetProperty', id: '$document', path: '/site' }]],
  ['an empty site removed', () => box(undefined, undefined, { extra: { site: {} } }), [{ op: 'unsetProperty', id: '$document', path: '/site' }]],
  ['a site changed', () => box(undefined, undefined, { extra: { site: { trueNorth: 7 } } }), [{ op: 'unsetProperty', id: '$site', path: '/trueNorth' }, { op: 'setProperty', id: '$document', path: '/site', value: { location: { latitude: 1, longitude: 2 } } }]],
];

/**
 * Batches whose inverse, in the order 1.6 gives, cannot be applied: it removes a junction (or a
 * wall) that B created while an element in both A and B still refers to it, because the member
 * changes of step 3 come after the removals of step 1. Reported as a specification issue; these
 * cases pin the current behaviour until the order is settled.
 */
const specOrderFails: [string, () => object, unknown[]][] = [
  ['a separator splitting a wall', box, [{ op: 'drawSeparator', level: 'L1', from: 'J1', to: [3900000, 2000000] }]],
  ['resizeRoom with a jog', pair, [{ op: 'resizeRoom', room: 'Kitchen', side: 'north', by: "1'" }]],
  ['drawWall splitting walls', box, [{ op: 'drawWall', level: 'L1', from: [2000000, -1000000], to: [2000000, 4000000], layers: core }]],
];

describe('the echo (1.4.1) and the inverse (1.6.1)', () => {
  it.each([...scenarios, ...specOrderFails])('%s: resolved replays to the same B', (_name, make, batch) => {
    const a = make();
    const r = committed(apply(a, { batch: batch as never }));
    const replay = committed(apply(a, { batch: r.resolved }));
    expect(replay.document).toBe(r.document);
    expect(replay.hash).toBe(r.hash);
    expect(replay.resolved).toEqual(r.resolved);
  });

  it.each(scenarios)('%s: the inverse commits A', (_name, make, batch) => {
    const a = make();
    const r = committed(apply(a, { batch: batch as never }));
    const back = committed(apply(r.document, { batch: r.inverse }));
    expect(back.document).toBe(canonicalize(a));
  });

  it.each(specOrderFails)('%s: the inverse, in the order of 1.6, is blocked (FS-OPS-006)', (_name, make, batch) => {
    const r = committed(apply(make(), { batch: batch as never }));
    const back = apply(r.document, { batch: r.inverse });
    expect(back.status).toBe('rejected');
    expect(back.status === 'rejected' && back.diagnostics[0]!.code).toBe('FS-OPS-006');
  });

  it('lists the inverse in the order of 1.6', () => {
    const d = pair(undefined, undefined, { types: door, openings: { O1: { wall: 'W7', offset: 0, fill: 'D36' } } });
    const r = committed(
      apply(d, {
        batch: [
          { op: 'drawWall', level: 'L1', from: 'J3', to: '1 m east of J3', layers: core },
          { op: 'removeWall', wall: 'W7', keep: 'Kitchen' },
          { op: 'setProperty', id: '$project', path: '/description', value: 'x' },
          { op: 'setProperty', id: 'W1', path: '/name', value: 'w' },
          { op: 'setProperty', id: 'RA', path: '/name', value: 'Great room' },
        ],
      }),
    );
    expect(r.inverse).toEqual([
      { op: 'removeElement', id: 'W8' },
      { op: 'removeElement', id: 'J5' },
      { op: 'addElement', collection: 'walls', id: 'W7', element: { level: 'L1', start: 'B0', end: 'T', layers: [{ thickness: 10000, function: 'core' }] } },
      { op: 'addElement', collection: 'rooms', id: 'RB', element: { level: 'L1', anchor: [5850000, 1400000], name: 'Dining' } },
      { op: 'addElement', collection: 'openings', id: 'O1', element: { wall: 'W7', offset: 0, fill: 'D36' } },
      { op: 'setProperty', id: 'RA', path: '/name', value: 'Kitchen' },
      { op: 'unsetProperty', id: 'W1', path: '/name' },
      { op: 'unsetProperty', id: '$project', path: '/description' },
    ]);
  });

  it('resolves nothing twice: the echo of an echo is itself', () => {
    const a = doc({ junctions: {}, walls: {} });
    const r = committed(apply(a, { batch: [{ op: 'drawWall', level: 'L1', from: [0, 0], to: [0, "10'"], layers: [{ thickness: '5 1/2"', function: 'core' }] }] }));
    expect(r.resolved).toEqual([
      { op: 'addJunction', id: 'J1', level: 'L1', position: [0, 0] },
      { op: 'addJunction', id: 'J2', level: 'L1', position: [0, 3901440] },
      { op: 'addWall', id: 'W1', level: 'L1', start: 'J1', end: 'J2', layers: [{ thickness: 178816, function: 'core' }] },
    ]);
  });
});
