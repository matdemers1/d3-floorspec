import { describe, expect, it } from 'vitest';
import { FOOT, INCH, measure } from '../src/measure.js';
import { answerLine, judgeAnswer, score } from '../src/scorer.js';
import { applyBatches, emptyDocument, type Doc } from '../src/seeds.js';
import type { Assertion } from '../src/types.js';

/**
 * The scorer on hand-made models: a 20' × 12' box split by a partition at x = 10' into West and
 * East, built with the reference applier. Each assertion is shown passing on a right edit and
 * failing on a near miss — a scorer that cannot fail is not measuring anything.
 */

const WALL = { kind: 'wallType', name: 'Partition', layers: [{ thickness: 4 * INCH, function: 'core', material: 'STUD' }] };

function house(): Doc {
  return applyBatches(emptyDocument('Box'), [
    [
      { op: 'addElement', collection: 'buildings', id: 'B', element: { name: 'B' } },
      { op: 'addElement', collection: 'materials', id: 'STUD', element: { name: 'Stud' } },
      { op: 'addElement', collection: 'types', id: 'T', element: WALL },
      { op: 'addElement', collection: 'types', id: 'D30', element: { kind: 'doorType', name: '30 in door', width: 30 * INCH, height: 80 * INCH } },
      { op: 'addElement', collection: 'types', id: 'W2', element: { kind: 'windowType', name: '2 ft window', width: 2 * FOOT, height: 2 * FOOT, sill: 3 * FOOT } },
      { op: 'addElement', collection: 'levels', id: 'L1', element: { name: 'Main', building: 'B', elevation: 0, height: 9 * FOOT } },
      { op: 'drawWall', level: 'L1', from: [0, 0], to: ["0'", "12'"], type: 'T' },
      { op: 'drawWall', level: 'L1', from: ["0'", "12'"], to: ["20'", "12'"], type: 'T' },
      { op: 'drawWall', level: 'L1', from: ["20'", "12'"], to: ["20'", "0'"], type: 'T' },
      { op: 'drawWall', level: 'L1', from: ["20'", "0'"], to: [0, 0], type: 'T' },
      { op: 'drawWall', id: 'MID', level: 'L1', from: ["10'", "0'"], to: ["10'", "12'"], type: 'T' },
    ],
    [
      { op: 'addRoom', id: 'WEST', level: 'L1', at: ["5'", "6'"], name: 'West' },
      { op: 'addRoom', id: 'EAST', level: 'L1', at: ["15'", "6'"], name: 'East bedroom' },
      { op: 'addOpening', id: 'WIN', wall: 'north wall of WEST', at: 'centered', fill: 'W2' },
    ],
  ]);
}

const seed = house();
const edit = (...batches: object[][]) => applyBatches(seed, batches);
const check = (result: Doc, assertions: Assertion[], reply: string | null = null) => score({ seed, result, reply }, assertions);

describe('the model the scorer reads', () => {
  it('measures rooms, walls and openings from the engine', () => {
    const m = measure(seed);
    expect(m.valid).toBe(true);
    expect([...m.rooms.keys()].sort()).toEqual(['EAST', 'WEST']);
    expect(m.walls.get('MID')?.rooms).toEqual(new Set(['WEST', 'EAST']));
    expect(m.openings.get('WIN')?.kind).toBe('window');
  });
});

describe('room assertions', () => {
  const grown = edit([{ op: 'moveWall', wall: 'MID', by: "2'", toward: 'EAST' }]);

  it('roomEdges: the named side moved by exactly the delta, the others stayed', () => {
    const a: Assertion = { kind: 'roomEdges', room: 'WEST', delta: { maxX: "2'" } };
    expect(check(grown, [a]).pass).toBe(true);
    expect(check(grown, [{ ...a, delta: { maxX: "1' 11\"" } }]).pass).toBe(false);
    expect(check(grown, [{ ...a, delta: { minX: "-2'" } }]).pass).toBe(false);
  });

  it('roomsUnchanged fails on the room the edit touched', () => {
    expect(check(grown, [{ kind: 'roomsUnchanged', rooms: ['WEST'] }]).pass).toBe(false);
    expect(check(seed, [{ kind: 'roomsUnchanged', rooms: ['WEST', 'EAST'] }]).pass).toBe(true);
  });

  it('roomExists matches on name, new-ness and size', () => {
    const split = edit([{ op: 'drawWall', level: 'L1', from: ["10'", "5'"], to: ["20'", "5'"], type: 'T' }], [{ op: 'addRoom', level: 'L1', at: ["15'", "2'"], name: 'Study' }]);
    // 5' of location line, less half of each 4" wall: 4' 8".
    expect(check(split, [{ kind: 'roomExists', name: 'study', new: true, size: { northSouth: ["4' 6\"", "5'"] } }]).pass).toBe(true);
    expect(check(split, [{ kind: 'roomExists', name: 'study', new: true, size: { northSouth: ["5' 6\"", "6'"] } }]).pass).toBe(false);
    expect(check(split, [{ kind: 'roomCount', delta: 1 }]).pass).toBe(true);
    expect(check(split, [{ kind: 'wallLine', level: 'L1', orientation: 'ew', at: ["5'", "5'"], span: ["10'", "20'"] }]).pass).toBe(true);
    expect(check(split, [{ kind: 'wallLine', level: 'L1', orientation: 'ew', at: ["5'", "5'"], span: ["0'", "20'"] }]).pass).toBe(false);
  });
});

describe('opening assertions', () => {
  const door = (at: string) => edit([{ op: 'addOpening', wall: 'MID', at, fill: 'D30' }]);
  const a: Assertion = { kind: 'openingAdded', on: { between: ['WEST', 'EAST'] }, type: 'door', width: '30"', centred: true };

  it('openingAdded: a centred door passes; an inch off centre, the wrong width or a window fails', () => {
    expect(check(door('centered'), [a]).pass).toBe(true);
    // Centred is (12' − 30")/2 = 4' 9" from start; 4' 10" is an inch off.
    expect(check(door("4' 10\" from start"), [a]).pass).toBe(false);
    expect(check(door('centered'), [{ ...a, width: '32"' }]).pass).toBe(false);
    expect(check(door('centered'), [{ ...a, type: 'window' }]).pass).toBe(false);
    expect(check(door('centered'), [{ ...a, on: { of: 'WEST', side: 'north' } }]).pass).toBe(false);
  });

  it('openingMoved reads the absolute displacement, whichever way the wall runs', () => {
    const moved = edit([{ op: 'moveOpening', opening: 'WIN', at: "5' from start" }]);
    // The north wall runs west → east, the window was centred at 4' from start: one foot east.
    expect(check(moved, [{ kind: 'openingMoved', opening: 'WIN', by: { east: "1'" } }]).pass).toBe(true);
    expect(check(moved, [{ kind: 'openingMoved', opening: 'WIN', by: { west: "1'" } }]).pass).toBe(false);
  });

  it('openingAt accepts a replacement in the same spot and refuses one off the spot', () => {
    const swapped = edit([{ op: 'removeElement', id: 'WIN' }, { op: 'addOpening', wall: 'north wall of WEST', at: 'centered', fill: 'W2', width: "3'" }]);
    expect(check(swapped, [{ kind: 'openingAt', near: 'WIN', type: 'window', width: "3'" }]).pass).toBe(true);
    const shifted = edit([{ op: 'removeElement', id: 'WIN' }, { op: 'addOpening', wall: 'north wall of WEST', at: "1' from start", fill: 'W2', width: "3'" }]);
    expect(check(shifted, [{ kind: 'openingAt', near: 'WIN', type: 'window', width: "3'" }]).pass).toBe(false);
    expect(check(swapped, [{ kind: 'openingAt', near: 'WIN', type: 'window', width: "4'" }]).pass).toBe(false);
  });

  it('openingRemoved and openingsUnchanged', () => {
    const gone = edit([{ op: 'removeElement', id: 'WIN' }]);
    expect(check(gone, [{ kind: 'openingRemoved', opening: 'WIN' }]).pass).toBe(true);
    expect(check(gone, [{ kind: 'openingsUnchanged' }]).pass).toBe(false);
    expect(check(seed, [{ kind: 'openingRemoved', opening: 'WIN' }]).pass).toBe(false);
  });
});

describe('level assertions', () => {
  const up = (walls: number) =>
    edit([
      { op: 'addElement', collection: 'levels', id: 'L2', element: { name: 'Upper', building: 'B', elevation: 9 * FOOT, height: 8 * FOOT } },
      ...[
        [[0, 0], ["0'", "12'"]],
        [["0'", "12'"], ["20'", "12'"]],
        [["20'", "12'"], ["20'", "0'"]],
        [["20'", "0'"], [0, 0]],
      ]
        .slice(0, walls)
        .map(([from, to]) => ({ op: 'drawWall', level: 'L2', from, to, type: 'T' })),
    ]);

  it('footprintCopied needs every exterior wall line', () => {
    expect(check(up(4), [{ kind: 'footprintCopied', from: 'L1' }, { kind: 'levelExists', new: true, elevation: ["9'", "9'"] }]).pass).toBe(true);
    expect(check(up(3), [{ kind: 'footprintCopied', from: 'L1' }]).pass).toBe(false);
    expect(check(up(4), [{ kind: 'levelExists', new: true, elevation: ["10'", "11'"] }]).pass).toBe(false);
  });
});

describe('replies', () => {
  it('reads the last ANSWER line, with or without markdown', () => {
    expect(answerLine('blah\nANSWER: Hall')).toBe('Hall');
    expect(answerLine('**ANSWER:** Kitchen, Hall\n')).toBe('Kitchen, Hall');
    expect(answerLine('ANSWER: one\nmore\nANSWER: two')).toBe('two');
    expect(answerLine('no answer here')).toBeNull();
  });

  it('names rooms longest first, so "East bedroom" is not also "East"', () => {
    const m = measure(seed);
    expect(judgeAnswer('East bedroom', { rooms: ['EAST'] }, m)).toBeNull();
    expect(judgeAnswer('West, East bedroom', { rooms: ['EAST'] }, m)).toMatch(/also named WEST/);
    expect(judgeAnswer('446 sq ft', { number: 446.3, tol: 3 }, m)).toBeNull();
    expect(judgeAnswer('480', { number: 446.3, tol: 3 }, m)).not.toBeNull();
    expect(judgeAnswer('Yes, the powder room', { yesno: 'yes' }, m)).toBeNull();
  });

  it('asked: nothing changed and a question was asked', () => {
    expect(check(seed, [{ kind: 'asked' }], 'Which bedroom do you mean?').pass).toBe(true);
    expect(check(seed, [{ kind: 'asked' }], 'Done.').pass).toBe(false);
    expect(check(edit([{ op: 'removeElement', id: 'WIN' }]), [{ kind: 'asked' }], 'Which one?').pass).toBe(false);
  });

  it('anyOf passes when one whole outcome passes', () => {
    const groups: Assertion[][] = [[{ kind: 'asked' }], [{ kind: 'openingRemoved', opening: 'WIN' }]];
    expect(check(edit([{ op: 'removeElement', id: 'WIN' }]), [{ kind: 'anyOf', groups }], 'Removed it.').pass).toBe(true);
    expect(check(seed, [{ kind: 'anyOf', groups }], 'Hmm.').pass).toBe(false);
  });
});

import { asksSomething } from '../src/scorer.js';
import { describe as describeAsk, it as itAsk, expect as expectAsk } from 'vitest';

describeAsk('asksSomething', () => {
  itAsk('counts a question mark or an explicit request for the decision', () => {
    expectAsk(asksSomething('How wide should it be?')).toBe(true);
    expectAsk(asksSomething('Tell me the width you want and I will make it.')).toBe(true);
    expectAsk(asksSomething('Let me know which bedroom.')).toBe(true);
    expectAsk(asksSomething('I widened it to 8 feet.')).toBe(false);
  });
});
