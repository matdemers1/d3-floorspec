import { useSyncExternalStore } from 'react';

/**
 * What Presentation reports to the chips (FLR-T-13.7), outside React's tree: the view's own state
 * changing must not re-render the 3D view — a re-render re-applies the scene's props, which asks for
 * a new frame, which starts its refinement again.
 */
/** Frames averaged once the camera stops (pipeline.ts). */
export const ACCUMULATE = 12;

export interface PresentationStats {
  ready: boolean;
  /** Frames per second over the last movement; null before any. */
  fps: number | null;
  /** The resolution drawn while moving, of the full. */
  scale: number;
  /** Frames averaged since the camera stopped. */
  refined: number;
  passes: readonly string[];
  env: boolean;
}

export class StatsStore {
  private value: PresentationStats | null = null;
  private readonly listeners = new Set<() => void>();
  get = (): PresentationStats | null => this.value;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  set(value: PresentationStats | null): void {
    this.value = value;
    for (const l of this.listeners) l();
  }
}

export function useStats(store: StatsStore): PresentationStats | null {
  return useSyncExternalStore(store.subscribe, store.get);
}
