import type { EditorStore } from '../store';
import type { Point } from '../model';
import { addNeighbour, addStreet, addTree, contextAt, FT, moveContext } from './ops';
import { contextOf } from './state';

/**
 * Context by hand on the plan (FLR-T-15.3), beside the generator: the Context tool (⇧X) picks a street,
 * a neighbour or a tree and drags it — context has no ops beyond move, resize and delete — and the
 * tree, neighbour and street tools draw new ones: a tree at a click, a neighbour's footprint corner by
 * corner, a street's centreline point by point.
 */

const say = (store: EditorStore, text: string) => { store.set({ notice: { tone: 'info', text } }); };

/** A press with the Context tool: pick what is under it, ready to drag; nothing under it lets the pick go. */
export function contextDown(store: EditorStore, at: Point, tol: number): void {
  const model = store.get().model;
  if (model === null) return;
  const hit = contextAt(model, at, tol);
  const ctx = contextOf(store);
  ctx.set({ selected: hit, drag: hit === null ? null : { ...hit, from: at, to: at } });
}

/** The drag, as the pointer moves. */
export function contextMove(store: EditorStore, at: Point): void {
  const ctx = contextOf(store);
  const drag = ctx.get().drag;
  if (drag !== null) ctx.set({ drag: { ...drag, to: at } });
}

/** The drag let go: the record moved, as one op, when it moved at all. */
export function contextUp(store: EditorStore, tol: number): void {
  const ctx = contextOf(store);
  const drag = ctx.get().drag;
  ctx.set({ drag: null });
  const model = store.get().model;
  if (drag === null || model === null) return;
  const dx = drag.to[0] - drag.from[0];
  const dy = drag.to[1] - drag.from[1];
  if (Math.hypot(dx, dy) <= tol) return;
  void store.apply(`Move ${drag.id}`, moveContext(model, drag.member, drag.id, dx, dy));
}

/** A tree beyond the lot at a click. */
export function treeDown(store: EditorStore, at: Point): void {
  const model = store.get().model;
  if (model === null) return;
  void store.apply('Add a tree beyond the lot', addTree(model, at, contextOf(store).get().treeForm));
}

/** The neighbour's footprint or the street's centreline, finished. */
export function finishContextChain(store: EditorStore, tool: 'neighbour' | 'street', points: readonly Point[]): void {
  const model = store.get().model;
  if (model === null) return;
  if (tool === 'neighbour') {
    if (points.length < 3) {
      if (points.length > 0) say(store, 'A neighbour needs at least three corners: click them, then click the first again or press Enter.');
      return;
    }
    void store.apply('Add a neighbour', addNeighbour(model, points));
    return;
  }
  if (points.length < 2) {
    if (points.length > 0) say(store, 'A street needs at least two points along its centreline: click them, then double-click or press Enter.');
    return;
  }
  const s = contextOf(store).get();
  if (s.width * FT < 1) {
    say(store, 'Give the street a carriageway in the Context panel first.');
    return;
  }
  void store.apply('Add a street', addStreet(model, points, s));
}
