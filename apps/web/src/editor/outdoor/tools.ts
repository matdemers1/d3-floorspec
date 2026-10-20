import type { EditorStore } from '../store';
import type { Point } from '../model';
import { drawFence, fenceStyle } from './ops';
import { outdoorOf } from './state';

/**
 * The fence tool (FLR-T-15.2, the board's "Fence · drawing"): a fence or a garden wall is drawn as a
 * wall is, point to point — double-click or Enter to finish — in the style the fence panel has, and
 * added in one op. Its gates are openings along its line, added from its inspector.
 */
export function finishFence(store: EditorStore, points: readonly Point[], level: string | null): void {
  const model = store.get().model;
  if (model === null || level === null) return;
  if (points.length < 2) {
    if (points.length > 0) store.set({ notice: { tone: 'info', text: 'A fence needs at least two points: click them, then double-click or press Enter.' } });
    return;
  }
  const style = fenceStyle(outdoorOf(store).get().fenceStyle);
  const what = style.members['form'] === 'wall' ? 'garden wall' : 'fence';
  void store.apply(`Draw a ${what}`, drawFence(model.document, level, points, style), { select: (created) => created.at(-1) ?? null });
}
