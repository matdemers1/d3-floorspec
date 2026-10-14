import type { Point } from '../model';
import type { Viewport } from '../store';

/**
 * Where an underlay lies on the plan (FLR-T-18.12): the arithmetic of trace and reference. Pure —
 * no React, no store — so the tests can hold it exactly.
 *
 * An image is `width` × `height` pixels, x to the right and y down. Its placement says where its
 * top-left corner is on the plan (`origin`, base units), how long one pixel is (`scale`, base units
 * per pixel) and how far it is turned (`rotation`, degrees counter-clockwise, the plan's y up). So
 * pixel (ix, iy) is at
 *
 *     origin + ix · scale · (cos θ, sin θ) + iy · scale · (sin θ, −cos θ)
 *
 * The placement is view data, not the house: it is never sent as an Op and never reaches a
 * normative output, so its numbers may be fractions (FLR-ADR-004 is about the model's lengths).
 */
export interface Placement {
  origin: Point;
  scale: number;
  rotation: number;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** The plan point under an image pixel. */
export function imageToPlan(p: Placement, ix: number, iy: number): Point {
  const c = Math.cos(rad(p.rotation)) * p.scale;
  const s = Math.sin(rad(p.rotation)) * p.scale;
  return [p.origin[0] + ix * c + iy * s, p.origin[1] + ix * s - iy * c];
}

/** The image pixel over a plan point (the inverse of imageToPlan). */
export function planToImage(p: Placement, at: Point): Point {
  const dx = at[0] - p.origin[0];
  const dy = at[1] - p.origin[1];
  const c = Math.cos(rad(p.rotation));
  const s = Math.sin(rad(p.rotation));
  return [(dx * c + dy * s) / p.scale, (dx * s - dy * c) / p.scale];
}

/** The SVG `matrix(a b c d e f)` that draws image pixels where they lie on the canvas (screen pixels, y down). */
export function screenMatrix(p: Placement, v: Viewport): [number, number, number, number, number, number] {
  const k = p.scale * v.s;
  const c = Math.cos(rad(p.rotation)) * k;
  const s = Math.sin(rad(p.rotation)) * k;
  const e = (p.origin[0] - v.cx) * v.s + v.w / 2;
  const f = v.h / 2 - (p.origin[1] - v.cy) * v.s;
  return [c, -s, s, c, e, f];
}

/** The image's centre on the plan. */
export const centreOf = (p: Placement, width: number, height: number): Point => imageToPlan(p, width / 2, height / 2);

/** The plan length of the image's width: what the panel says ("52'-0" wide"). */
export const planWidth = (p: Placement, width: number): number => width * p.scale;

const distance = (a: Point, b: Point): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * Set the scale from two points clicked on the image and the length between them, as typed: the
 * image grows or shrinks about the first point, which stays where it is. Null when the points are
 * the same point or the length is not a positive length.
 */
export function calibrate(p: Placement, a: Point, b: Point, length: number): Placement | null {
  const d = distance(a, b);
  if (!(d > 0) || !(length > 0) || !Number.isFinite(length)) return null;
  const k = length / d;
  return { ...p, scale: p.scale * k, origin: [a[0] + (p.origin[0] - a[0]) * k, a[1] + (p.origin[1] - a[1]) * k] };
}

/** Move the image so the point of it at `from` lands on `to`. */
export const moveBy = (p: Placement, from: Point, to: Point): Placement => ({ ...p, origin: [p.origin[0] + to[0] - from[0], p.origin[1] + to[1] - from[1]] });

/** An angle in (−180, 180], to a hundredth of a degree. */
export function normalizeDegrees(deg: number): number {
  let d = Math.round(deg * 100) / 100;
  d = ((d % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d === 0 ? 0 : d;
}

/** Turn the image to `deg` about a plan point (its centre, from the panel), which stays where it is. */
export function rotateTo(p: Placement, deg: number, about: Point): Placement {
  const rotation = normalizeDegrees(deg);
  const delta = rad(rotation - p.rotation);
  const c = Math.cos(delta);
  const s = Math.sin(delta);
  const dx = p.origin[0] - about[0];
  const dy = p.origin[1] - about[1];
  return { ...p, rotation, origin: [about[0] + dx * c - dy * s, about[1] + dx * s + dy * c] };
}

/**
 * Where a newly imported image goes: centred on `frame` (the level's extent, or what the view
 * shows of an empty level) and as wide as most of it, unturned. A guess until the scale is set —
 * which is why "Set scale" is the panel's first button.
 */
export function initialPlacement(width: number, height: number, frame: { minX: number; minY: number; maxX: number; maxY: number }): Placement {
  const fw = frame.maxX - frame.minX;
  const fh = frame.maxY - frame.minY;
  const scale = Math.max(1e-6, Math.min((fw * 0.9) / Math.max(1, width), (fh * 0.9) / Math.max(1, height)));
  const cx = (frame.minX + frame.maxX) / 2;
  const cy = (frame.minY + frame.maxY) / 2;
  return { scale, rotation: 0, origin: [cx - (width * scale) / 2, cy + (height * scale) / 2] };
}

/**
 * A replacement image (another page, a cleaner scan) in the same place: its top-left corner and
 * turn kept, and as wide on the plan as the image it replaces — so a calibrated drawing stays
 * calibrated when it is swapped for the same drawing at another resolution.
 */
export const replacePlacement = (p: Placement, oldWidth: number, newWidth: number): Placement => ({ ...p, scale: (p.scale * Math.max(1, oldWidth)) / Math.max(1, newWidth) });
