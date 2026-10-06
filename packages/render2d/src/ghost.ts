/**
 * Changeset ghosting: what a changeset adds, moves or removes, found by comparing the derived
 * geometry of the same level before and after, element by element and by ID.
 */
import type { Pt, Scene, SceneOpening, SceneRoom, SceneSeparator, SceneWall } from './scene.js';

/** `moved`: the element exists on both sides and its derived geometry (or its symbol) differs. */
export type Change = 'added' | 'moved' | 'removed';

export interface Diff<T> {
  /** ID → change, for every element that changed. */
  readonly changes: ReadonlyMap<string, Change>;
  /** The before-side element of every moved or removed element. */
  readonly before: ReadonlyMap<string, T>;
}

export interface SceneDiff {
  readonly walls: Diff<SceneWall>;
  readonly fills: Diff<readonly Pt[]>;
  readonly separators: Diff<SceneSeparator>;
  readonly openings: Diff<SceneOpening>;
  readonly rooms: Diff<SceneRoom>;
}

const samePts = (a: readonly Pt[], b: readonly Pt[]): boolean =>
  a.length === b.length && a.every((p, i) => p[0] === b[i]![0] && p[1] === b[i]![1]);

function diff<T>(before: ReadonlyMap<string, T>, after: ReadonlyMap<string, T>, same: (a: T, b: T) => boolean): Diff<T> {
  const changes = new Map<string, Change>();
  const old = new Map<string, T>();
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const id of ids) {
    const b = before.get(id);
    const a = after.get(id);
    if (b === undefined && a !== undefined) changes.set(id, 'added');
    else if (b !== undefined && a === undefined) {
      changes.set(id, 'removed');
      old.set(id, b);
    } else if (b !== undefined && a !== undefined && !same(b, a)) {
      changes.set(id, 'moved');
      old.set(id, b);
    }
  }
  return { changes, before: old };
}

/** Compare a level before and after a changeset. With no before-side level, everything is added. */
export function diffScenes(before: Scene | undefined, after: Scene): SceneDiff {
  const empty = new Map<string, never>();
  return {
    walls: diff(before?.walls ?? empty, after.walls, (x, y) => samePts(x.outline, y.outline)),
    fills: diff(before?.fills ?? empty, after.fills, samePts),
    separators: diff(before?.separators ?? empty, after.separators, (x, y) => samePts(x.line, y.line)),
    openings: diff(
      before?.openings ?? empty,
      after.openings,
      (x, y) => samePts([x.start, x.end], [y.start, y.end]) && x.kind === y.kind && x.hinge === y.hinge && x.swing === y.swing && x.wall === y.wall,
    ),
    rooms: diff(
      before?.rooms ?? empty,
      after.rooms,
      (x, y) =>
        samePts(x.outer, y.outer) &&
        x.holes.length === y.holes.length &&
        x.holes.every((h, i) => samePts(h, y.holes[i]!)) &&
        x.name === y.name &&
        x.function === y.function,
    ),
  };
}
