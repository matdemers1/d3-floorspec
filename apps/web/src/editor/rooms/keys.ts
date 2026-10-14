import type { EditorStore } from '../store';
import { labelOf } from '../model';
import { formatLen } from '../units';
import { extentAcross, minRoom, resizeRoom, roomSides, type Side } from './edit';

/**
 * A room's edges from the keyboard (FLR-T-18.10): with one room selected, ⌥ and an arrow push the
 * side the arrow points to out by the nudge step, ⌥⇧ and an arrow pull it in — one resizeRoom each,
 * so each press is one undo step. The plain arrows move the room (moveRoom, nudge.ts); ⇧ and the
 * arrows move it twelve steps; ⌥ and the arrows panned the plan before, and still do with anything
 * else selected.
 */

const SIDE_OF: Record<string, Side> = { ArrowUp: 'north', ArrowDown: 'south', ArrowLeft: 'west', ArrowRight: 'east' };

/** Whether the selection is one room the keys can resize. */
export function roomSelected(store: EditorStore): string | null {
  const { selection, selected, model, readOnly, compare, tool } = store.get();
  if (selection === null || selected.length > 1 || model === null || readOnly !== null || compare !== null || tool !== 'select') return null;
  return model.index.get(selection) === 'rooms' ? selection : null;
}

/** ⌥ + an arrow on a selected room. Returns true when the key was taken. */
export function roomKey(store: EditorStore, e: { key: string; altKey: boolean; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): boolean {
  const side = SIDE_OF[e.key];
  if (side === undefined || !e.altKey || e.metaKey || e.ctrlKey) return false;
  const room = roomSelected(store);
  const level = store.levelView;
  const model = store.get().model;
  if (room === null || level === undefined || model === null) return false;
  const name = labelOf(model, room);
  const found = roomSides(level, room).find((s) => s.side === side);
  if (found === undefined || !found.ok) {
    store.set({ notice: { tone: 'info', text: `The ${side} side of ${name} ${found?.why ?? 'is missing: no edge faces exactly ' + side}. Resize it wall by wall.` } });
    return true;
  }
  const step = store.nudgeStep;
  if (e.shiftKey && extentAcross(level, room, side) - step < minRoom(store.units)) {
    store.set({ notice: { tone: 'info', text: `${name} is as small as a handle makes a room across that way.` } });
    return true;
  }
  const by = e.shiftKey ? -step : step;
  void store.apply(`Resize ${name} ${side} ${formatLen(step, store.units)} ${by > 0 ? 'out' : 'in'}`, resizeRoom(room, side, by), { select: () => room });
  return true;
}
