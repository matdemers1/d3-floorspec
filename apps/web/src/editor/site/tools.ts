import type { EditorStore } from '../store';
import type { Point } from '../model';
import { addContour, addPad, addSpot, benchmarkOf, FT, groundAt, parseHeight, setLot, setStreet } from './ops';
import { siteOf } from './state';

/**
 * The site's tools on the plan (FLR-T-15.1), in Landscape mode's rail: the lot's corners (an outline,
 * as a slab's), a grading pad's outline, a contour line (a polyline at one height), a spot elevation
 * (a click), and the setback tool (a click on a lot edge makes it the street). The heights come from
 * the Site panel's fields; a spot with no height typed takes the surveyed ground's there.
 */

const say = (store: EditorStore, text: string) => { store.set({ notice: { tone: 'info', text } }); };

/** The chain tools' outlines and lines, finished. */
export function finishSiteChain(store: EditorStore, tool: 'lot' | 'pad' | 'contour', points: readonly Point[], level: string | null): void {
  const model = store.get().model;
  if (model === null) return;
  const site = siteOf(store).get();
  const bench = benchmarkOf(model);
  if (tool === 'lot') {
    if (points.length < 3) {
      if (points.length > 0) say(store, 'A lot needs at least three corners: click them, then click the first again or press Enter.');
      return;
    }
    void store.apply('Draw the lot', setLot(model, points));
    return;
  }
  if (tool === 'pad') {
    if (points.length < 3) {
      if (points.length > 0) say(store, 'A pad needs at least three corners: click them, then click the first again or press Enter.');
      return;
    }
    const floor = level === null ? 0 : (model.document.levels?.[level]?.elevation ?? 0);
    const typed = site.pad.trim() === '' ? null : parseHeight(site.pad, bench);
    if (site.pad.trim() !== '' && typed === null) {
      say(store, `"${site.pad}" is not a height: type the pad's height in feet, as 813.85.`);
      return;
    }
    void store.apply('Add a grading pad', addPad(model, points, typed ?? floor - 8 * 32_512));
    return;
  }
  if (points.length < 2) {
    if (points.length > 0) say(store, 'A contour line needs at least two points: click them, then double-click or press Enter.');
    return;
  }
  const z = parseHeight(site.contour, bench);
  if (z === null) {
    say(store, 'Type the contour line\'s height in the Site panel first, in feet: 813.');
    return;
  }
  void store.apply('Add a contour line', addContour(model, points, z));
}

/** A spot elevation where the plan was clicked: at the height typed, or the ground's there. */
export function spotDown(store: EditorStore, at: Point): void {
  const model = store.get().model;
  if (model === null) return;
  const site = siteOf(store).get();
  const bench = benchmarkOf(model);
  const typed = site.spot.trim() === '' ? null : parseHeight(site.spot, bench);
  if (site.spot.trim() !== '' && typed === null) {
    say(store, `"${site.spot}" is not a height: type it in feet, as 811.25.`);
    return;
  }
  const z = typed ?? groundAt(model, at) ?? 0;
  void store.apply('Add a spot elevation', addSpot(model, at, z));
  // the next spot: the field is kept, so a row of spots at one height is a click each
  if (typed === null) siteOf(store).set({ spot: ((bench + z) / FT).toFixed(2) });
}

/** The setback tool: the lot edge nearest the click becomes the street, the lot's front. */
export function setbackDown(store: EditorStore, at: Point, tol: number): void {
  const model = store.get().model;
  const lot = model?.document.site?.boundary;
  if (model === null || !Array.isArray(lot) || lot.length < 3) {
    say(store, 'Draw the lot first: its setbacks are drawn from its edges.');
    return;
  }
  let best = -1;
  let dist = Infinity;
  for (const [i, a] of lot.entries()) {
    const b = lot[(i + 1) % lot.length] ?? a;
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const l = vx * vx + vy * vy;
    const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((at[0] - a[0]) * vx + (at[1] - a[1]) * vy) / l));
    const d = Math.hypot(at[0] - a[0] - t * vx, at[1] - a[1] - t * vy);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  if (best < 0 || dist > Math.max(tol * 3, 3 * FT)) {
    say(store, 'Click the lot edge that is on the street.');
    return;
  }
  void store.apply('Set the street edge', setStreet(model, best));
}
