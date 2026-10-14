import { describe, expect, it } from 'vitest';
import { apply, mergeThreeWay, patchBetween, restoreOnto, type Operation } from '../src/index.js';
import { doc, FT } from './doc.js';

/**
 * FLR-T-18.18: a return to an earlier version, rebased onto a main that has moved since — the batch a
 * branch from the history scrubber replays with when it is accepted.
 */

const square = doc({
  junctions: { J1: [0, 0], J2: [12 * FT, 0], J3: [12 * FT, 10 * FT], J4: [0, 10 * FT] },
  walls: { W1: { start: 'J1', end: 'J2' }, W2: { start: 'J2', end: 'J3' }, W3: { start: 'J3', end: 'J4' }, W4: { start: 'J4', end: 'J1' } },
  rooms: { R1: { anchor: [6 * FT, 5 * FT], name: 'Kitchen' } },
});

type Doc = Record<string, unknown>;
function step(d: Doc, batch: readonly Record<string, unknown>[], retired: string[] = []): Doc {
  const r = apply(d, { batch: batch as Operation[], context: { retired } });
  if (r.status !== 'committed') throw new Error(r.diagnostics.map((x) => `${x.code} ${x.message}`).join('; '));
  return JSON.parse(r.document) as Doc;
}

describe('a return to a version, rebased', () => {
  it('merges three ways: what the target changed, over what main changed since', () => {
    expect(mergeThreeWay({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3 })).toEqual({ a: 2, b: 3 });
    expect(mergeThreeWay({ a: 1 }, {}, { a: 1, c: 4 })).toEqual({ c: 4 });
    expect(mergeThreeWay({}, { a: 1 }, {})).toEqual({ a: 1 });
    // Both changed it: the version gone back to.
    expect(mergeThreeWay({ a: 1 }, { a: 2 }, { a: 3 })).toEqual({ a: 2 });
  });

  it('turns one document into another, by Ops 1.6’s inverse', () => {
    const renamed = step(square, [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Den' }]);
    const patch = patchBetween(square, renamed);
    expect(patch).toEqual([{ op: 'setProperty', id: 'R1', path: '/name', value: 'Den' }]);
  });

  it('brings back a room main has already brought back, without adding it twice', () => {
    // v1 the square; v2 the kitchen removed; branched from v1 at v2; main then undoes the removal (v3).
    const v1 = square;
    const v2 = step(v1, [{ op: 'removeElement', id: 'R1' }]);
    const v3 = step(v2, [{ op: 'addElement', collection: 'rooms', id: 'R1', element: (square['rooms'] as Doc)['R1'] }]);
    // As recorded, the branch's batch adds R1 again: refused on v3.
    const stale = apply(v3, { batch: [{ op: 'addElement', collection: 'rooms', id: 'R1', element: (square['rooms'] as Doc)['R1'] as Doc }] as Operation[] });
    expect(stale.status).toBe('rejected');
    // Rebased, there is nothing left to do.
    expect(restoreOnto(v2, v1, v3)).toEqual([]);
  });

  it('keeps main’s later edits to everything the return did not touch', () => {
    const v1 = square;
    const v2 = step(v1, [{ op: 'setProperty', id: 'R1', path: '/name', value: 'Den' }, { op: 'addElement', collection: 'buildings', element: {} }]);
    // Main since: the level renamed, the added building removed.
    const v3 = step(v2, [{ op: 'setProperty', id: 'L1', path: '/name', value: 'Ground' }, { op: 'removeElement', id: 'B2' }], ['B2']);
    const batch = restoreOnto(v2, v1, v3);
    const out = step(v3, batch as unknown as Record<string, unknown>[], ['B2']);
    expect(((out['rooms'] as Doc)['R1'] as Doc)['name']).toBe('Kitchen');
    expect(((out['levels'] as Doc)['L1'] as Doc)['name']).toBe('Ground');
    expect(Object.keys(out['buildings'] as Doc)).toEqual(['B1']);
  });
});
