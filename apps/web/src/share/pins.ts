import type { EditorModel, LevelView, Point } from '../editor/model';
import { levelOfElement } from '../editor/model';
import { centroid } from '../editor/geometry';
import { anchorOf } from '../editor/systems/view';
import type { Thread } from './api';
import type { PinTarget } from './comments';

/**
 * Where a comment's pin is drawn (FLR-REQ-167). A thread is pinned to an element, on the version the
 * commenter saw, at the point they clicked:
 *   - on that same version, the pin is at that point;
 *   - on a later version that still has the element, it follows the element — to its centre, since
 *     the element may have moved;
 *   - once the element is gone, the pin is **detached**: drawn where it last was, and marked so.
 */

export interface PinPlace {
  level: string;
  point: Point | null;
  detached: boolean;
}

/** A point to stand a pin on for an element on a level: a wall's or an opening's middle, a room's anchor, a device. */
export function anchorIn(level: LevelView, id: string): Point | null {
  const w = level.walls.find((x) => x.id === id) ?? level.separators.find((x) => x.id === id);
  if (w !== undefined) return [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
  const o = level.openings.find((x) => x.id === id);
  if (o !== undefined) return [(o.start[0] + o.end[0]) / 2, (o.start[1] + o.end[1]) / 2];
  const r = level.rooms.find((x) => x.id === id);
  if (r !== undefined) return r.anchor;
  const j = level.junctions.find((x) => x.id === id);
  if (j !== undefined) return j.position;
  const d = level.devices.find((x) => x.id === id);
  if (d !== undefined) return anchorOf(d);
  const s = level.slabs.find((x) => x.id === id);
  if (s !== undefined) return centroid(s.outline);
  const st = level.stairs.find((x) => x.id === id);
  if (st !== undefined) {
    const { min, max } = st.derived.box;
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
  }
  const roof = level.roofs.find((x) => x.id === id);
  if (roof !== undefined) return centroid(roof.footprint);
  return null;
}

export function placeOf(model: EditorModel | null, thread: Pick<Thread, 'pin'>): PinPlace | null {
  const pin = thread.pin;
  if (pin === null) return null;
  const stored: Point | null = pin.point === null ? null : [pin.point[0], pin.point[1]];
  if (model === null || !model.index.has(pin.element)) return { level: pin.level, point: stored, detached: true };
  const level = levelOfElement(model, pin.element) ?? pin.level;
  if (pin.version === model.hash && stored !== null) return { level, point: stored, detached: false };
  const view = model.levels.find((l) => l.id === level);
  const anchor = view === undefined ? null : anchorIn(view, pin.element);
  return { level, point: anchor ?? stored, detached: false };
}

/**
 * What a new comment is pinned to: the selected element, at the point the pointer was when it was
 * clicked on the plan (rounded to base units), or at its anchor when it was picked in 3D.
 */
export function targetOf(model: EditorModel | null, selection: string | null, cursor: Point | null, fromPlan: boolean): PinTarget | null {
  if (model === null || selection === null) return null;
  const level = levelOfElement(model, selection);
  if (level === undefined) return null;
  const view = model.levels.find((l) => l.id === level);
  const anchor = view === undefined ? null : anchorIn(view, selection);
  if (anchor === null) return null;
  const at = fromPlan && cursor !== null ? cursor : anchor;
  return { element: selection, level, point: [Math.round(at[0]), Math.round(at[1])] };
}
