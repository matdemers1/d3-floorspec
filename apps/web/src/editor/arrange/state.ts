import { useSyncExternalStore } from 'react';
import type { EditorStore } from '../store';
import type { Point } from '../model';
import type { ArraySpec } from './array';

/**
 * The multi-selection's own passing state (FLR-T-18.8), beside the editor's store rather than in it
 * so the selection model stays the one thing the store owns: the marquee being dragged, the group
 * being dragged, and the array popover while it is open. Nothing here is ever sent anywhere.
 */

export interface Marquee {
  /** Where it was started and where the pointer is, in plan. */
  from: Point;
  to: Point;
  /** Dragged to the left: a crossing (anything touched), else a window (wholly inside). */
  crossing: boolean;
  /** ⇧ adds to the selection, ⌘ toggles, otherwise the marquee replaces it. */
  how: 'replace' | 'add' | 'toggle';
}

export interface ArrangeState {
  marquee: Marquee | null;
  /** The selection being dragged, and by how much so far. */
  dragging: Point | null;
  /** The array popover, open with its plan. */
  array: ArraySpec | null;
}

export class ArrangeStore {
  private state: ArrangeState = { marquee: null, dragging: null, array: null };
  private readonly listeners = new Set<() => void>();

  get = (): ArrangeState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<ArrangeState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

const stores = new WeakMap<EditorStore, ArrangeStore>();

export function arrangeOf(store: EditorStore): ArrangeStore {
  let a = stores.get(store);
  if (a === undefined) {
    const made = new ArrangeStore();
    // The array popover closes when what it would repeat goes: another selection, another level.
    let was = { selected: store.get().selected, level: store.get().level };
    store.subscribe(() => {
      const s = store.get();
      if ((s.selected !== was.selected && s.selected.join() !== was.selected.join()) || s.level !== was.level) {
        if (made.get().array !== null) made.set({ array: null });
      }
      was = { selected: s.selected, level: s.level };
    });
    stores.set(store, made);
    a = made;
  }
  return a;
}

export function useArrange<T>(store: EditorStore, selector: (s: ArrangeState) => T): T {
  const a = arrangeOf(store);
  return useSyncExternalStore(a.subscribe, () => selector(a.get()), () => selector(a.get()));
}
