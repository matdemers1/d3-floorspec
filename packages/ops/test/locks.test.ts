/** Chapter 6: element, length and distance locks. */
import { describe, it } from 'vitest';
import { apply, type Lock } from '../src/index.js';
import { box, committed, pair, rejectedWith } from './doc.js';

const withLocks = (d: object, locks: Lock[], ...batch: unknown[]): ReturnType<typeof apply> => apply(d, { batch: batch as never, context: { locks } });
const east = { op: 'resizeRoom', room: 'Kitchen', side: 'east', by: "2'" };
const north = { op: 'resizeRoom', room: 'Kitchen', side: 'north', by: "2'" };

describe('locks (6.1)', () => {
  it('rejects a lock on elements that do not exist, or on walls not parallel, with FS-OPS-010 (6.1.1)', () => {
    rejectedWith(withLocks(box(), [{ element: 'W99' }], east), 'FS-OPS-010', ['W99']);
    rejectedWith(withLocks(box(), [{ length: 'R1' }], east), 'FS-OPS-010', ['R1']);
    rejectedWith(withLocks(box(), [{ distance: ['W1', 'W2'] }], east), 'FS-OPS-010', ['W1', 'W2']);
    rejectedWith(withLocks(box(), [{ distance: ['W1', 'W9'] }], east), 'FS-OPS-010', ['W1', 'W9']);
  });

  it('holds an element lock while the element, and its ends or corners, are unchanged (6.1.2)', () => {
    // W1, the west wall: resizing east leaves it and its ends alone.
    committed(withLocks(box(), [{ element: 'W1' }], east));
    rejectedWith(withLocks(box(), [{ element: 'W3' }], east), 'FS-OPS-011', ['W3']);
    // W2, the north wall: its content is unchanged, but its end J3 moves.
    rejectedWith(withLocks(box(), [{ element: 'W2' }], east), 'FS-OPS-011', ['W2']);
    // The room: its corners move.
    rejectedWith(withLocks(box(), [{ element: 'R1' }], east), 'FS-OPS-011', ['R1']);
    rejectedWith(withLocks(box(), [{ element: 'R1' }], { op: 'setProperty', id: 'R1', path: '/name', value: 'Galley' }), 'FS-OPS-011', ['R1']);
    // The Dining room is locked; the Kitchen may change, but not the wall between them.
    committed(withLocks(pair(), [{ element: 'RB' }], { op: 'resizeRoom', room: 'Kitchen', side: 'west', by: "1'" }));
    rejectedWith(withLocks(pair(), [{ element: 'RB' }], { op: 'resizeRoom', room: 'Kitchen', side: 'east', by: "1'" }), 'FS-OPS-011', ['RB']);
    // Removing a locked element breaks its lock.
    rejectedWith(withLocks(pair(), [{ element: 'RB' }], { op: 'removeWall', wall: 'W7', keep: 'Kitchen' }), 'FS-OPS-011', ['RB']);
  });

  it('holds a length lock while the wall keeps its length', () => {
    committed(withLocks(box(), [{ length: 'W1' }], east));
    rejectedWith(withLocks(box(), [{ length: 'W2' }], east), 'FS-OPS-011', ['W2']);
    // Moving a wall sideways keeps its length.
    committed(withLocks(box(), [{ length: 'W3' }], { op: 'moveWall', wall: 'W3', by: "1'" }));
  });

  it('holds a distance lock while two walls stay parallel at the same distance', () => {
    committed(withLocks(box(), [{ distance: ['W1', 'W3'] }], north));
    rejectedWith(withLocks(box(), [{ distance: ['W1', 'W3'] }], east), 'FS-OPS-011', ['W1', 'W3']);
    // Turning W3 breaks parallelism.
    rejectedWith(withLocks(box(), [{ distance: ['W1', 'W3'] }], { op: 'moveJunction', id: 'J3', to: [4000000, 2800000] }), 'FS-OPS-011', ['W1', 'W3']);
    // Moving both walls together keeps the distance.
    committed(withLocks(box(), [{ distance: ['W1', 'W3'] }], { op: 'moveRoom', room: 'Kitchen', by: "3' east" }));
  });

  it('reports every lock the result breaks', () => {
    const r = withLocks(box(), [{ element: 'W3' }, { length: 'W2' }, { element: 'W1' }], east);
    if (r.status !== 'rejected') throw new Error('expected a rejection');
    if (JSON.stringify(r.diagnostics.map((d) => [d.code, d.elements])) !== JSON.stringify([['FS-OPS-011', ['W2']], ['FS-OPS-011', ['W3']]])) throw new Error(JSON.stringify(r.diagnostics));
  });
});
