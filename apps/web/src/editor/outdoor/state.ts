import { useSyncExternalStore } from 'react';
import type { EditorStore } from '../store';
import { FENCE_STYLES } from './ops';

/**
 * The fence tool's choice (FLR-T-15.2): which style of the starter library the next fence is drawn
 * in. The viewer's, never the model: a fence keeps its own members once drawn.
 */
export interface OutdoorState {
  fenceStyle: string;
}

class OutdoorStore {
  private state: OutdoorState = { fenceStyle: FENCE_STYLES[0]?.id ?? 'fence-privacy-6' };
  private readonly listeners = new Set<() => void>();
  get = (): OutdoorState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  set(patch: Partial<OutdoorState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
}

const stores = new WeakMap<EditorStore, OutdoorStore>();

export function outdoorOf(store: EditorStore): OutdoorStore {
  let s = stores.get(store);
  if (s === undefined) {
    s = new OutdoorStore();
    stores.set(store, s);
  }
  return s;
}

export function useOutdoor<T>(store: EditorStore, selector: (s: OutdoorState) => T): T {
  const s = outdoorOf(store);
  return useSyncExternalStore(s.subscribe, () => selector(s.get()), () => selector(s.get()));
}
