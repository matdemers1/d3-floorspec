import type { Layers } from '../store';
import type { LevelView, Point } from '../model';
import { add, dist, distanceToRing, inRing, scale } from '../geometry';
import { anchorOf, facingVector, footprintSize, type DeviceView } from './view';

/**
 * How a device is drawn and found on the plan. A device whose footprint is small on screen — a
 * receptacle is 80 mm wide — is drawn as a glyph of a fixed size, a little in front of its face so
 * the wall's poché does not hide it; a large one (a tub, a panel at a close zoom) by its outline.
 * The canvas and the pointer use the same rule, so what is drawn is what is clicked.
 */

/** A glyph's radius, in screen pixels. */
export const GLYPH_R = 7;

/** Whether a device draws as a glyph at `s` pixels per base unit. */
export function asGlyph(d: DeviceView, s: number): boolean {
  return footprintSize(d) * s < 24;
}

/** Where a device's glyph is centred, in plan: in front of its face for a wall device, at its anchor otherwise. */
export function glyphCentre(d: DeviceView, s: number): Point {
  const at = anchorOf(d);
  if (d.host?.['mode'] !== 'wallFace' || d.placement === null) return at;
  return add(at, scale(facingVector(d.placement.facing), (GLYPH_R + 3) / s));
}

/** Whether a device's system is shown. Elements of another extension show with every layer. */
export function visible(d: DeviceView, layers: Layers): boolean {
  return d.system === null ? true : layers[d.system];
}

/** The device under the pointer, nearest first; null when none. `tol` is in base units, `s` pixels per base unit. */
export function deviceAt(level: LevelView, p: Point, tol: number, s: number, layers: Layers): DeviceView | null {
  let best: { d: DeviceView; distance: number } | null = null;
  for (const d of level.devices) {
    if (!visible(d, layers)) continue;
    let distance: number;
    if (!layers.coreOnly && asGlyph(d, s)) distance = Math.max(0, dist(p, glyphCentre(d, s)) - GLYPH_R / s);
    else distance = inRing(p, d.footprint) ? 0 : distanceToRing(p, d.footprint);
    if (distance <= tol && (best === null || distance < best.distance)) best = { d, distance };
  }
  return best?.d ?? null;
}
