import type { EditorStore } from './store';
import { kindOf, labelOf, type LevelView, type Point } from './model';
import { dot, leftNormal, sub, len } from './geometry';
import { moveJunction, moveOpening, moveWall, type Batch } from './ops';
import { formatLen } from './units';

/**
 * Arrow-key nudging (FLR-T-3.7): the selected junction, wall, separator or opening moves one step
 * in the arrow's direction — 1" by default (10 mm in metric), Shift for twelve (ten) steps, the
 * step set in the project panel. Each nudge is the op a drag would send: moveJunction for a
 * junction, moveWall (sideways, keeping its joins) for a wall, moveOpening along its wall for an
 * opening, and both ends' moveJunction for a separator.
 *
 * The batch is built when the edit runs, not when the key is pressed, so a quick run of presses
 * moves step after step from wherever the last one left it.
 */

export type Arrow = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

const DIRECTION: Record<Arrow, Point> = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
const WORD: Record<Arrow, string> = { ArrowUp: 'north', ArrowDown: 'south', ArrowLeft: 'west', ArrowRight: 'east' };

export function isArrow(key: string): key is Arrow {
  return key in DIRECTION;
}

/** What a nudge of the element would send, against a level as it is now; null when it cannot move that way. */
export function nudgeBatch(level: LevelView, document: { openings?: Record<string, unknown> }, id: string, arrow: Arrow, step: number): Batch | null {
  const d = DIRECTION[arrow];
  const junction = level.junctions.find((j) => j.id === id);
  if (junction !== undefined) return moveJunction(id, [junction.position[0] + d[0] * step, junction.position[1] + d[1] * step]);
  const wall = level.walls.find((w) => w.id === id);
  if (wall !== undefined) {
    // Sideways only: the arrow's component across the wall picks the side.
    const across = dot(d, leftNormal(wall.a, wall.b));
    if (Math.abs(across) < 0.38) return null;
    return moveWall(id, across > 0 ? step : -step);
  }
  const separator = level.separators.find((s) => s.id === id);
  if (separator !== undefined) {
    return [
      ...moveJunction(separator.start, [separator.a[0] + d[0] * step, separator.a[1] + d[1] * step]),
      ...moveJunction(separator.end, [separator.b[0] + d[0] * step, separator.b[1] + d[1] * step]),
    ];
  }
  const opening = level.openings.find((o) => o.id === id);
  if (opening !== undefined) {
    const host = level.walls.find((w) => w.id === opening.wall);
    if (host === undefined) return null;
    const along = sub(host.b, host.a);
    const l = len(along) || 1;
    const k = dot(d, [along[0] / l, along[1] / l]);
    if (Math.abs(k) < 0.38) return null;
    const stored = (document.openings?.[id] as Record<string, unknown> | undefined)?.['offset'];
    const offset = typeof stored === 'number' ? stored : opening.offset;
    return moveOpening(id, Math.max(0, offset + (k > 0 ? step : -step)));
  }
  return null;
}

/** Whether the selection is something the arrows move. */
export function nudgeable(store: EditorStore): boolean {
  const { selection, model, readOnly, compare } = store.get();
  if (selection === null || model === null || readOnly !== null || compare !== null) return false;
  const kind = kindOf(model, selection);
  return kind === 'junction' || kind === 'wall' || kind === 'separator' || kind === 'opening';
}

/** Nudge the selection. Returns false when the arrow does not move it (a wall pushed along itself). */
export function nudge(store: EditorStore, arrow: Arrow, big: boolean): boolean {
  if (!nudgeable(store)) return false;
  const s = store.get();
  const id = s.selection as string;
  const model = s.model;
  const step = store.nudgeStep * (big ? (store.units === 'metric' ? 10 : 12) : 1);
  const level = store.levelView;
  if (model === null || level === undefined || nudgeBatch(level, model.document, id, arrow, step) === null) {
    const kind = model === null ? null : kindOf(model, id);
    if (kind === 'wall') store.set({ notice: { tone: 'info', text: 'A wall moves sideways: use the arrows across it. Drag a junction to lengthen it.' } });
    if (kind === 'opening') store.set({ notice: { tone: 'info', text: 'An opening moves along its wall: use the arrows along it.' } });
    return true;
  }
  void store.apply(`Nudge ${labelOf(model, id)} ${formatLen(step, store.units)} ${WORD[arrow]}`, () => {
    const now = store.get();
    const lv = store.levelView;
    if (now.model === null || lv === undefined) return [];
    return nudgeBatch(lv, now.model.document, id, arrow, step) ?? [];
  }, { select: () => id });
  return true;
}
