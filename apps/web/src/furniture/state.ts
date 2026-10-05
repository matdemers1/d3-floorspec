import { useSyncExternalStore } from 'react';
import type { EditorStore } from '../editor/store';
import type { FurnitureKind } from './library';

/**
 * The furniture library's state (FLR-T-8.3), beside the editor's store rather than in it, as the
 * 3D view's is (three/mode.ts): whether the library is open, what it shows and which item is chosen,
 * and whether the upload dialog is open. What is placed is in the model; this is only the browser.
 */

export interface FurnitureState {
  open: boolean;
  /** The kind shown, or every kind. */
  kind: FurnitureKind | 'all';
  query: string;
  /** The chosen library item's ID. */
  chosen: string | null;
  /** The room "Place in" puts it in; null: the editor's choice (furniture/Library.tsx `targetRoom`). */
  room: string | null;
  uploading: boolean;
  /** An upload and a placement in flight: its label. */
  busy: string | null;
}

const initial: FurnitureState = { open: false, kind: 'all', query: '', chosen: 'refrigerator-900', room: null, uploading: false, busy: null };

export class FurnitureStore {
  private state: FurnitureState = initial;
  private readonly listeners = new Set<() => void>();
  get(): FurnitureState {
    return this.state;
  }
  set(patch: Partial<FurnitureState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

const stores = new WeakMap<EditorStore, FurnitureStore>();

/** The furniture state of an editor: one per editor store. */
export function furnitureOf(store: EditorStore): FurnitureStore {
  let s = stores.get(store);
  if (s === undefined) {
    s = new FurnitureStore();
    stores.set(store, s);
  }
  return s;
}

export function useFurniture<T>(store: EditorStore, selector: (s: FurnitureState) => T): T {
  const f = furnitureOf(store);
  return useSyncExternalStore(f.subscribe, () => selector(f.get()));
}
