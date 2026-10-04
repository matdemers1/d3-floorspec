/** Chapter 5: merging junctions, snap-rounding planarization, re-hosting openings, join cleanup. */
import { describe, expect, it } from 'vitest';
import { B, box, committed, doc, H, IN, pos, rejectedWith, run, W } from './doc.js';

const core = [{ thickness: 12800, function: 'core' }];

describe('5.1 merging coincident junctions (5.1.1)', () => {
  it('keeps the junction that was in A and redirects edges to it', () => {
    const r = committed(run(box(), { op: 'addJunction', id: 'J9', level: 'L1', position: [0, 0] }, { op: 'drawWall', level: 'L1', from: 'J9', to: [-1000000, 0], layers: core }));
    expect(r.created).toEqual(['J10', 'W5']);
    expect(B(r).walls!.W5!.start).toBe('J1');
  });

  it('keeps the first ID when none, or several, were in A', () => {
    const none = committed(run(box(), { op: 'addJunction', id: 'JB', level: 'L1', position: [5000000, 0] }, { op: 'addJunction', id: 'JA', level: 'L1', position: [5000000, 0] }));
    expect(none.created).toEqual(['JA']);
    // Dragging J1 onto J10: both were in A, so J1 (which sorts before J10) survives.
    const d = box();
    (d.junctions as Record<string, unknown>).J10 = { level: 'L1', position: [-1000000, -1000000] };
    (d.walls as Record<string, unknown>).W10 = { level: 'L1', start: 'J10', end: 'JY', layers: core };
    (d.junctions as Record<string, unknown>).JY = { level: 'L1', position: [-2000000, -1000000] };
    const r = committed(run(d, { op: 'moveJunction', id: 'J10', to: [0, 0] }));
    expect(r.removed).toEqual(['J10']);
    expect(B(r).walls!.W10!.start).toBe('J1');
  });

  it('leaves two edges between the same junctions for validation to reject', () => {
    // A second wall from J1 to J2, drawn by points: both junctions are reused, and the duplicate stays.
    rejectedWith(run(box(), { op: 'drawWall', level: 'L1', from: [0, 0], to: [0, H], layers: core }), 'FS-INV-103', ['W1', 'W5']);
  });
});

describe('5.2 planarization by snap rounding (5.2.1)', () => {
  it('inserts a junction where two walls cross, rounding the crossing ties to even', () => {
    // The walls cross at (1000000, 500000.5): the hot pixel is (1000000, 500000).
    const empty = doc({ junctions: {}, walls: {} });
    const r = committed(
      run(empty, { op: 'drawWall', level: 'L1', from: [0, 0], to: [2000000, 1000001], layers: core }, { op: 'drawWall', level: 'L1', from: [0, 1000001], to: [2000000, 0], layers: core }),
    );
    expect(r.created).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'W1', 'W2', 'W3', 'W4']);
    const b = B(r);
    expect(pos(b, 'J5')).toEqual([1000000, 500000]);
    expect([b.walls!.W1!.start, b.walls!.W1!.end, b.walls!.W3!.start, b.walls!.W3!.end]).toEqual(['J1', 'J5', 'J5', 'J2']);
    expect([b.walls!.W2!.start, b.walls!.W2!.end, b.walls!.W4!.start, b.walls!.W4!.end]).toEqual(['J3', 'J5', 'J5', 'J4']);
  });

  it('routes an edge through the pixel of a junction it passes within half a unit of', () => {
    // A junction at (500000, 0) and a wall from (0, 0) to (1000000, 1): at x = 500000 the wall is at
    // y = 0.5, inside the closed pixel of (500000, 0), so the wall is split there.
    const d = doc({ junctions: { A: [0, 0], C: [1000000, 1], P: [500000, 0], Q: [500000, -1000000] }, walls: { W1: { start: 'A', end: 'C' }, W2: { start: 'Q', end: 'P' } } });
    // Valid as it is (P is not on W1), but any batch normalizes the level.
    const r = committed(run(d, { op: 'setProperty', id: '$project', path: '/name', value: 'x' }));
    expect(r.created).toEqual(['W3']);
    expect(B(r).walls!.W3).toMatchObject({ start: 'P', end: 'C' });
  });

  it('splits a wall where a new wall ends inside it, keeping its ID on the first piece', () => {
    const r = committed(run(box(), { op: 'drawWall', level: 'L1', from: [1000000, 0], to: [1000000, 1000000], layers: core, name: 'stub' }));
    const b = B(r);
    expect(r.created).toEqual(['J5', 'J6', 'W5', 'W6']);
    expect(b.walls!.W4).toMatchObject({ start: 'J4', end: 'J5' });
    // The new piece copies every member of the original except its junctions.
    expect(b.walls!.W6).toEqual({ level: 'L1', layers: core, start: 'J5', end: 'J1' });
  });

  it('re-hosts an opening on the piece that contains it, with its offset from that piece', () => {
    // O1 is on W2 (J2 → J3, west to east along the north wall), from 2500000 to 2500000 + 30".
    const d = box(undefined, undefined, { openings: { O1: { wall: 'W2', offset: 2500000, width: 30 * IN, height: 2000000 } } });
    const r = committed(run(d, { op: 'drawSeparator', level: 'L1', from: [1000000, 0], to: [1000000, H] }));
    const b = B(r);
    expect(r.created).toEqual(['J5', 'J6', 'S1', 'W5', 'W6']);
    expect(b.walls!.W5).toMatchObject({ start: 'J6', end: 'J3' });
    expect(b.openings!.O1).toEqual({ wall: 'W5', offset: 1500000, width: 30 * IN, height: 2000000 });
  });

  it('rejects the batch with FS-OPS-009 when an opening straddles an inserted junction', () => {
    const d = box(undefined, undefined, { openings: { O1: { wall: 'W2', offset: 500000, width: 30 * IN, height: 2000000 } } });
    rejectedWith(run(d, { op: 'drawSeparator', level: 'L1', from: [1000000, 0], to: [1000000, H] }), 'FS-OPS-009', ['O1']);
    // An opening that ends exactly at the new junction stays on the first piece.
    const edge = box(undefined, undefined, { openings: { O1: { wall: 'W2', offset: 1000000 - 30 * IN, width: 30 * IN, height: 2000000 } } });
    expect(B(run(edge, { op: 'drawSeparator', level: 'L1', from: [1000000, 0], to: [1000000, H] })).openings!.O1).toMatchObject({ wall: 'W2', offset: 1000000 - 30 * IN });
  });

  it('measures a re-hosted offset along the original line, exactly, rounded once', () => {
    // An oblique wall A(0,0) → C(3000000, 1000000), split by a vertical separator at x = 1500000:
    // the crossing is (1500000, 500000), at 500000·√10 = 1581138.83… along the wall.
    const d = doc({
      junctions: { A: [0, 0], C: [3000000, 1000000] },
      walls: { WX: { start: 'A', end: 'C' } },
      openings: { O1: { wall: 'WX', offset: 2000000, width: 500000, height: 2000000 } },
    });
    const r = committed(run(d, { op: 'drawSeparator', level: 'L1', from: [1500000, -1000000], to: [1500000, 2000000] }));
    // 2000000 − 1581138.83… = 418861.16… → 418861
    expect(B(r).openings!.O1).toEqual({ wall: 'W1', offset: 418861, width: 500000, height: 2000000 });
  });
});

describe('5.3 join cleanup (5.3.1)', () => {
  it("removes a join that names a wall no longer ending at its junction", () => {
    // J2's butt join names W1; a wall drawn into W1's middle splits it, and J2 still ends W1's
    // second piece — so the join, which names W1, goes.
    const d = box();
    (d.junctions as Record<string, Record<string, unknown>>).J2!.join = { kind: 'butt', through: ['W1'] };
    const r = committed(run(d, { op: 'drawWall', level: 'L1', from: [0, 1000000], to: [1000000, 1000000], layers: core }));
    expect(B(r).walls!.W1).toMatchObject({ start: 'J1', end: 'J5' });
    expect(B(r).junctions!.J2).toEqual({ level: 'L1', position: [0, H] });
    // J1's side is untouched: a join naming a wall that still ends there stays.
    const kept = box();
    (kept.junctions as Record<string, Record<string, unknown>>).J1!.join = { kind: 'butt', through: ['W1'] };
    expect(B(run(kept, { op: 'drawWall', level: 'L1', from: [0, 1000000], to: [1000000, 1000000], layers: core })).junctions!.J1).toMatchObject({ join: { kind: 'butt', through: ['W1'] } });
  });
});

describe('normalization runs once, after the last primitive (5.4.1)', () => {
  it('lets a batch pass through crossings that later operations undo', () => {
    const r = committed(
      run(box(), { op: 'drawWall', id: 'X', level: 'L1', from: [2000000, -1000000], to: [2000000, 4000000], layers: core }, { op: 'removeElement', id: 'X' }),
    );
    // Nothing was split: normalization saw no crossing. The junctions drawWall made are left unused.
    expect(r.created).toEqual(['J5', 'J6']);
    expect(B(r).walls!.W2).toMatchObject({ start: 'J2', end: 'J3' });
  });

  it('never moves an anchor, removes a wall or removes a room', () => {
    const r = committed(run(box(), { op: 'drawWall', level: 'L1', from: [W / 2 + 100000, -1000000], to: [W / 2 + 100000, 4000000], layers: core }));
    expect(B(r).rooms!.R1).toEqual({ level: 'L1', anchor: [W / 2, H / 2], name: 'Kitchen' });
  });
});
