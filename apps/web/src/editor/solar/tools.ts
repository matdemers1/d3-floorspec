import type { EditorStore } from '../store';
import type { Point } from '../model';
import { solarDrawingOf, solarOf } from './data';

const inside = (p: Point, ring: readonly (readonly [number, number])[]): boolean => {
  let w = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) continue;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) w = !w;
  }
  return w;
};

/**
 * The solar tool (FLR-T-16.1) on the plan: a click on an array selects it — the inspector shows its
 * estimate — and a click on a roof face without one picks the face, which the Solar panel can lay an
 * array on. Nothing is written by a click.
 */
export function solarDown(store: EditorStore, at: Point): void {
  const s = store.get();
  const model = s.model;
  if (model === null) return;
  const drawing = solarDrawingOf(model);
  const array = drawing.arrays.find((a) => a.level === s.level && inside(at, a.footprint));
  if (array !== undefined) {
    solarOf(store).set({ face: null });
    store.select(array.id);
    return;
  }
  const face = drawing.faces.find((f) => f.level === s.level && f.polygons.some((poly) => inside(at, poly.map((p) => [p[0], p[1]] as [number, number]))));
  store.select(null);
  solarOf(store).set({ face: face?.key ?? null });
}
