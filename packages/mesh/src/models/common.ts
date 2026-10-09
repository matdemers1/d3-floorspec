/**
 * What models share: the units they are drawn in, the context an element's model is drawn with,
 * and the cabinet-maker's parts — a front of doors and drawers with their reveals and pulls, legs.
 * Every size is in base units (1/1280 mm), and each one that a real fixture has is capped by a
 * share of the box, so a model scales to any box an author gives it.
 */
import type { Sketch } from './sketch.js';

export const MM = 1_280;

export type Json = Record<string, unknown>;
export type V2 = readonly [number, number];

/** An opening cut through a counter top: its outline in the counter's own frame, and how deep the basin under it goes. */
export interface Cutout {
  outline: V2[];
  /** The basin's bottom, local z of the counter. */
  bottom: number;
}

export interface ModelContext {
  /** What the element is: `waterCloset`, `recessed`, `baseCabinet`. */
  kind: string;
  /** The height of the frame's origin above the box's bottom — a basin's rim, by Core 13.1 a wall mount's height — when it is inside the box. */
  originZ: number | undefined;
  /** For a counter top: the sinks set into it. */
  cutouts: readonly Cutout[];
  /** For a sink set into a counter: the counter top's height in the sink's box. */
  counter?: number;
}

export type Model = (s: Sketch, el: Json, ctx: ModelContext) => void;

export const min = Math.min;
export const max = Math.max;

/** A rectangle's corners, counter-clockwise. */
export const rect = (x0: number, y0: number, x1: number, y1: number): V2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** The gap between two fronts: a 3 mm reveal. */
export const REVEAL = 3 * MM;

export interface Front {
  /** The plane the fronts stand on (the carcass's face) and their outer face. */
  x0: number;
  x1: number;
  /** How far a pull stands proud of the fronts, at most; nothing is drawn past x1 + pull. */
  pull: number;
}

/** A pull: a bar on a front, horizontal or upright, centred on (y, z). */
export function pull(s: Sketch, f: Front, y: number, z: number, length: number, upright: boolean): void {
  if (f.pull < 4 * MM) return;
  const d = min(f.pull, 22 * MM);
  const t = min(12 * MM, length / 6);
  const h = length / 2;
  if (upright) s.box('pull', 'darkMetal', f.x1, y - t / 2, z - h, f.x1 + d, y + t / 2, z + h);
  else s.box('pull', 'darkMetal', f.x1, y - h, z - t / 2, f.x1 + d, y + h, z + t / 2);
}

/** A drawer front filling (y0 … y1, z0 … z1) less the reveal, with a pull across its middle. */
export function drawer(s: Sketch, f: Front, y0: number, y1: number, z0: number, z1: number): void {
  const r = REVEAL / 2;
  s.box('drawer', 'wood', f.x0, y0 + r, z0 + r, f.x1, y1 - r, z1 - r);
  pull(s, f, (y0 + y1) / 2, (z0 + z1) / 2, min(160 * MM, (y1 - y0) * 0.4), false);
}

/**
 * A door filling (y0 … y1, z0 … z1) less the reveal, its pull upright by the edge it opens from
 * (`hinge` is the side it hangs on), near its top or bottom.
 */
export function door(s: Sketch, f: Front, y0: number, y1: number, z0: number, z1: number, hinge: 'left' | 'right', pullAt: 'top' | 'bottom' | 'middle'): void {
  const r = REVEAL / 2;
  s.box('door', 'wood', f.x0, y0 + r, z0 + r, f.x1, y1 - r, z1 - r);
  const len = min(140 * MM, (z1 - z0) * 0.3);
  const inset = min(40 * MM, (y1 - y0) * 0.12);
  const y = hinge === 'right' ? y1 - inset : y0 + inset;
  const margin = min(60 * MM, (z1 - z0) * 0.08);
  const z = pullAt === 'top' ? z1 - margin - len / 2 : pullAt === 'bottom' ? z0 + margin + len / 2 : (z0 + z1) / 2;
  pull(s, f, y, z, len, true);
}

/** A row of doors across (y0 … y1): one, or a pair meeting in the middle. */
export function doors(s: Sketch, f: Front, y0: number, y1: number, z0: number, z1: number, pullAt: 'top' | 'bottom' | 'middle', pair = y1 - y0 >= 700 * MM): void {
  if (!pair) {
    door(s, f, y0, y1, z0, z1, 'left', pullAt);
    return;
  }
  const m = (y0 + y1) / 2;
  door(s, f, y0, m, z0, z1, 'left', pullAt);
  door(s, f, m, y1, z0, z1, 'right', pullAt);
}

/** A stack of drawers, `rows` high and `cols` wide. */
export function drawers(s: Sketch, f: Front, y0: number, y1: number, z0: number, z1: number, rows: number, cols: number): void {
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++) {
      const ya = y0 + ((y1 - y0) * c) / cols;
      const yb = y0 + ((y1 - y0) * (c + 1)) / cols;
      const za = z0 + ((z1 - z0) * r) / rows;
      const zb = z0 + ((z1 - z0) * (r + 1)) / rows;
      drawer(s, f, ya, yb, za, zb);
    }
}

/** Four square legs of side t under (x0 … x1, y0 … y1), from z0 to z1, inset by `inset`. */
export function legs(s: Sketch, role: 'wood' | 'darkMetal', x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, t: number, inset = 0): void {
  const xs = [x0 + inset, x1 - inset - t];
  const ys = [y0 + inset, y1 - inset - t];
  for (const x of xs) for (const y of ys) s.box('leg', role, x, y, z0, x + t, y + t, z1);
}
