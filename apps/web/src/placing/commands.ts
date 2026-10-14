import type { Command } from '../editor/commands';
import type { EditorStore } from '../editor/store';
import { dragEnd, nudgeGhost, openLibrary, openQuickAdd, placeHere, placingOf, turnGhost } from './state';

/**
 * Adding things from the keyboard (FLR-T-18.7; the P18 read-me: I inserts from the library, /
 * adds quickly). The commands go in the editor's one registry; the keys that act on a ghost — R
 * and [ ] turning it, the arrows moving it, Enter placing it — are read before the editor's own
 * (they mean something else with nothing being placed: R names a room, [ ] turn the selection).
 */

const editable = (store: EditorStore) => {
  const s = store.get();
  return s.readOnly === null && s.model !== null && s.compare === null && s.level !== null;
};

export const PLACING_COMMANDS: readonly Command[] = [
  {
    id: 'library.quickAdd',
    label: 'Quick add — search everything and place it at the pointer',
    group: 'Tools',
    keywords: 'add insert place furniture door window plant device search quick',
    keys: ['/'],
    hint: '/',
    enabled: editable,
    run: (store) => {
      openQuickAdd(store);
    },
  },
];

/** Whether something is being placed: click-to-place, or a card being dragged onto the plan. */
export function placing(store: EditorStore): boolean {
  const p = placingOf(store).get();
  return p.dragging !== null || (p.active !== null && store.get().tool === 'place');
}

/** The keys while placing. Returns true when the key was taken. */
export function placingKey(store: EditorStore, e: KeyboardEvent, mac: boolean): boolean {
  if (!placing(store)) return false;
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (mod || e.altKey) return false;
  const p = placingOf(store).get();
  if (e.key === 'Escape' && p.dragging !== null) {
    void dragEnd(store, true);
    return true;
  }
  if (e.code === 'KeyR' || e.key === 'r' || e.key === 'R') return turnGhost(store, e.shiftKey ? 90 : -90);
  if (e.code === 'BracketLeft') return turnGhost(store, e.shiftKey ? 15 : 90);
  if (e.code === 'BracketRight') return turnGhost(store, e.shiftKey ? -15 : -90);
  const step = store.nudgeStep * (e.shiftKey ? 10 : 1);
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  const by = arrows[e.key];
  if (by !== undefined) return nudgeGhost(store, by[0], by[1]);
  if (e.key === 'Enter' && p.dragging === null) {
    void placeHere(store);
    return true;
  }
  return false;
}

export { openLibrary };
