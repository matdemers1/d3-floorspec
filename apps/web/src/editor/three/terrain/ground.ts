import { useSyncExternalStore } from 'react';
import type { EditorStore } from '../../store';

/**
 * What lies on the ground in the view's sky (FLR-T-15.4's season and weather): the lawn's tint, or a
 * plain field of snow — published by the sun rig, which works it out for the lawn, so the site's
 * terrain (FLR-T-15.1) wears the same ground as the lawn beyond it. Null in the studio, or while the
 * sky's maps are on their way.
 */
export interface GroundLook {
  readonly grass: boolean;
  readonly albedo: readonly [number, number, number];
  readonly tint: readonly [number, number, number];
}

interface Slot {
  value: GroundLook | null;
  readonly listeners: Set<() => void>;
}

const slots = new WeakMap<EditorStore, Slot>();
const slotOf = (store: EditorStore): Slot => {
  let s = slots.get(store);
  if (s === undefined) {
    s = { value: null, listeners: new Set() };
    slots.set(store, s);
  }
  return s;
};

export function setGroundLook(store: EditorStore, look: GroundLook | null): void {
  const s = slotOf(store);
  if (s.value === look) return;
  s.value = look;
  for (const fn of s.listeners) fn();
}

export function useGroundLook(store: EditorStore): GroundLook | null {
  const s = slotOf(store);
  return useSyncExternalStore(
    (fn) => {
      s.listeners.add(fn);
      return () => {
        s.listeners.delete(fn);
      };
    },
    () => s.value,
    () => s.value,
  );
}
