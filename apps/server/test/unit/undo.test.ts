import { describe, expect, it } from 'vitest';
import { undoTarget } from '../../src/domain/history.js';

type Kind = 'create' | 'apply' | 'undo' | 'redo' | 'merge';

/** A log, oldest first, as `kind` or `kind:target-seq`; returned newest first as the store reads it. */
function log(...entries: string[]) {
  return entries
    .map((entry, i) => {
      const [kind, of] = entry.split(':');
      return { id: String(i + 1), seq: i + 1, kind: kind as Kind, undoOfId: of ?? null, inverse: kind === 'create' ? null : [{ op: 'x' }] };
    })
    .reverse();
}
const seq = (op: { seq: number } | null) => op?.seq ?? null;

describe('what undo and redo invert (FLR-T-2.4)', () => {
  it('undoes the newest edit, then the one before, passing over each undo and the edit it undid', () => {
    expect(seq(undoTarget(log('create', 'apply', 'apply'), 'undo'))).toBe(3);
    expect(seq(undoTarget(log('create', 'apply', 'apply', 'undo:3'), 'undo'))).toBe(2);
    expect(seq(undoTarget(log('create', 'apply', 'apply', 'undo:3', 'undo:2'), 'undo'))).toBe(null);
    expect(seq(undoTarget(log('create', 'merge'), 'undo'))).toBe(2);
  });

  it('redoes the newest undo, and a redo is itself undone like an edit', () => {
    const undone = log('create', 'apply', 'apply', 'undo:3', 'undo:2');
    expect(seq(undoTarget(undone, 'redo'))).toBe(5);
    const redoneOnce = log('create', 'apply', 'apply', 'undo:3', 'undo:2', 'redo:5');
    expect(seq(undoTarget(redoneOnce, 'redo'))).toBe(4);
    // Op 2 is back in effect: undo targets it again.
    expect(seq(undoTarget(redoneOnce, 'undo'))).toBe(2);
    const redoneTwice = log('create', 'apply', 'apply', 'undo:3', 'undo:2', 'redo:5', 'redo:4');
    expect(seq(undoTarget(redoneTwice, 'redo'))).toBe(null);
    expect(seq(undoTarget(redoneTwice, 'undo'))).toBe(3);
  });

  it('ends the redo trail at a new edit', () => {
    expect(seq(undoTarget(log('create', 'apply', 'undo:2', 'apply'), 'redo'))).toBe(null);
  });
});
