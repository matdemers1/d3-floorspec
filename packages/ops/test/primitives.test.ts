/** Chapter 2: addElement and its shorthands, removeElement and its cascades, setProperty, unsetProperty, moveJunction. */
import { describe, expect, it } from 'vitest';
import { B, box, committed, H, IN, pair, pos, rejectedWith, run, W } from './doc.js';

const door = { D30: { kind: 'doorType', width: 30 * IN, height: 80 * IN } };
const withDoor = (): Record<string, unknown> => pair(undefined, undefined, { types: door, openings: { O1: { wall: 'W7', offset: 100000, fill: 'D30' } } });

describe('addElement (2.1)', () => {
  it('adds the element exactly as given, without checking its content (2.1.1)', () => {
    // A level-less room is added; validation, not addElement, refuses it.
    const r = run(box(), { op: 'addElement', collection: 'rooms', element: { anchor: [1, 1] } });
    rejectedWith(r, 'FS-SCH-001');
  });

  it('treats each shorthand exactly as the addElement it is (2.1.2)', () => {
    const shorthand = committed(run(box(), { op: 'addJunction', level: 'L1', position: [5000000, 0] }, { op: 'addJunction', level: 'L1', position: [6000000, 0] }, { op: 'addSeparator', level: 'L1', start: 'J5', end: 'J6' }));
    const long = committed(
      run(
        box(),
        { op: 'addElement', collection: 'junctions', element: { level: 'L1', position: [5000000, 0] } },
        { op: 'addElement', collection: 'junctions', element: { level: 'L1', position: [6000000, 0] } },
        { op: 'addElement', collection: 'separators', element: { level: 'L1', start: 'J5', end: 'J6' } },
      ),
    );
    expect(shorthand.document).toBe(long.document);
    expect(shorthand.created).toEqual(['J5', 'J6', 'S1']);
  });

  it('resolves selectors and points in shorthand members, and keeps IDs to come', () => {
    const r = committed(
      run(
        box(),
        { op: 'addJunction', id: 'JX', level: 'L1', position: "1 m south of start of south wall of Kitchen" },
        { op: 'addWall', level: 'L1', start: 'start of south wall of Kitchen', end: 'JX', layers: [{ thickness: '1/2"', function: 'core' }] },
      ),
    );
    expect(r.resolved).toEqual([
      { op: 'addJunction', id: 'JX', level: 'L1', position: [W, -1280000] },
      { op: 'addWall', id: 'W5', level: 'L1', start: 'J4', end: 'JX', layers: [{ thickness: IN / 2, function: 'core' }] },
    ]);
  });
});

describe('removeElement (2.2)', () => {
  it('fails with FS-OPS-003 when there is no such element (2.2.1)', () => {
    rejectedWith(run(box(), { op: 'removeElement', id: 'W99' }), 'FS-OPS-003', []);
  });

  it('fails with FS-OPS-006 when the table says the removal is blocked, naming the dependents (2.2.1)', () => {
    rejectedWith(run(box(), { op: 'removeElement', id: 'J1' }), 'FS-OPS-006', ['J1', 'W1', 'W4']);
    rejectedWith(run(withDoor(), { op: 'removeElement', id: 'W7' }), 'FS-OPS-006', ['O1', 'W7']);
    rejectedWith(run(box(), { op: 'removeElement', id: 'B1' }), 'FS-OPS-006', ['B1', 'L1']);
    rejectedWith(run(box(), { op: 'removeElement', id: 'L1' }), 'FS-OPS-006', ['J1', 'J2', 'J3', 'J4', 'L1', 'R1', 'W1', 'W2', 'W3', 'W4']);
    // A type, material or asset blocks while anything refers to it — cascade does not apply.
    rejectedWith(run(withDoor(), { op: 'removeElement', id: 'D30', cascade: true }), 'FS-OPS-006', ['D30', 'O1']);
  });

  it('removes a separator, room, opening or slab alone', () => {
    expect(committed(run(withDoor(), { op: 'removeElement', id: 'O1' })).removed).toEqual(['O1']);
  });

  it('with cascade, removes exactly what the table lists, transitively (2.2.2)', () => {
    expect(committed(run(withDoor(), { op: 'removeElement', id: 'RB' }, { op: 'removeElement', id: 'W7', cascade: true })).removed).toEqual(['O1', 'RB', 'W7']);
    // A junction takes the walls ending at it, and their openings.
    const r = committed(run(withDoor(), { op: 'removeElement', id: 'RB' }, { op: 'removeElement', id: 'RA' }, { op: 'removeElement', id: 'B0', cascade: true }));
    expect(r.removed).toEqual(['B0', 'O1', 'RA', 'RB', 'W5', 'W6', 'W7']);
    // A building takes its levels, and they take everything on them.
    const all = committed(run(withDoor(), { op: 'removeElement', id: 'B1', cascade: true }));
    expect(all.removed).toEqual(['B0', 'B1', 'J1', 'J2', 'J3', 'J4', 'L1', 'O1', 'RA', 'RB', 'T', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7']);
    expect(JSON.parse(all.document)).toEqual({ floorspec: '0.1', project: { name: 'Test' }, types: door });
  });

  it('removes a wall from every join.through, unsetting that join', () => {
    const d = box();
    (d.junctions as Record<string, Record<string, unknown>>).J2!.join = { kind: 'butt', through: ['W1'] };
    committed(run(d, { op: 'setProperty', id: 'J2', path: '/name', value: 'corner' }));
    const b = B(run(d, { op: 'removeElement', id: 'R1' }, { op: 'removeElement', id: 'W1' }));
    expect(b.junctions!.J2).toEqual({ level: 'L1', position: [0, H] });
  });
});

describe('setProperty and unsetProperty (2.3)', () => {
  it('sets a member, creating the objects on the way to it', () => {
    const b = B(run(box(), { op: 'setProperty', id: 'W1', path: '/extras/viewer/colour', value: 'red' }, { op: 'setProperty', id: 'W2', path: '/top/height', value: '9\'' }));
    expect(b.walls!.W1!.extras).toEqual({ viewer: { colour: 'red' } });
    expect(b.walls!.W2!.top).toEqual({ height: 9 * 12 * IN });
  });

  it('addresses $project, $site (creating it) and $document', () => {
    const b = B(
      run(
        box(),
        { op: 'setProperty', id: '$project', path: '/description', value: 'A test' },
        { op: 'setProperty', id: '$site', path: '/trueNorth', value: 1500000 },
        { op: 'setProperty', id: '$document', path: '/extras', value: { tool: 'test' } },
      ),
    );
    expect(b.project).toEqual({ name: 'Test', description: 'A test' });
    expect(b.site).toEqual({ trueNorth: 1500000 });
    expect(b.extras).toEqual({ tool: 'test' });
  });

  it('fails with FS-OPS-003 for an unknown target, an empty path or a missing member (2.3.1)', () => {
    rejectedWith(run(box(), { op: 'setProperty', id: 'W99', path: '/name', value: 'x' }), 'FS-OPS-003');
    rejectedWith(run(box(), { op: 'setProperty', id: 'W1', path: '', value: 'x' }), 'FS-OPS-003');
    rejectedWith(run(box(), { op: 'unsetProperty', id: 'W1', path: '' }), 'FS-OPS-003');
    rejectedWith(run(box(), { op: 'unsetProperty', id: 'W1', path: '/name' }), 'FS-OPS-003');
    rejectedWith(run(box(), { op: 'unsetProperty', id: 'W1', path: '/base/offset' }), 'FS-OPS-003');
    rejectedWith(run(box(), { op: 'unsetProperty', id: '$site', path: '/trueNorth' }), 'FS-OPS-003');
    rejectedWith(run(box(), { op: 'setProperty', id: '$document', path: '/walls', value: {} }), 'FS-OPS-003');
    rejectedWith(run(box(), { op: 'setProperty', id: 'W1', path: 'name', value: 'x' }), 'FS-OPS-003');
  });

  it('removes a member so its default applies again', () => {
    const d = box();
    (d.walls as Record<string, Record<string, unknown>>).W1!.justification = 'exteriorFace';
    expect(B(run(d, { op: 'unsetProperty', id: 'W1', path: '/justification' })).walls!.W1).not.toHaveProperty('justification');
  });

  it('handles member names that are not identifiers', () => {
    const b = B(run(box(), { op: 'setProperty', id: 'W1', path: '/extras/__proto__', value: { polluted: true } }, { op: 'setProperty', id: 'W1', path: '/extras/a~1b', value: 1 }));
    expect(Object.keys(b.walls!.W1!.extras as object)).toEqual(['__proto__', 'a/b']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('moveJunction (2.4.1)', () => {
  it('is exactly setProperty of /position', () => {
    const a = committed(run(box(), { op: 'moveJunction', id: 'J3', to: [W + 100, H] }));
    const b = committed(run(box(), { op: 'setProperty', id: 'J3', path: '/position', value: [W + 100, H] }));
    expect(a.document).toBe(b.document);
    expect(pos(B(a), 'J3')).toEqual([W + 100, H]);
    rejectedWith(run(box(), { op: 'moveJunction', id: 'J9', to: [0, 0] }), 'FS-OPS-003');
  });
});
