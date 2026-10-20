/**
 * Exterior lights in 3D (FLR-T-15.5): the lamps each kind of exterior light shines with — its
 * catalogue and beams are @floorspec/render2d's (`exterior.ts`, FLR-ADR-063) — for every view that
 * lights the grounds: the editor's 3D view, the glTF export and the GPU still, the path tracer.
 */
import type { ExteriorData } from '@floorspec/render2d/exterior';

const MM = 1_280;

/** One lamp of an exterior light, in its frame: where it shines from, which way, and its share of the light. */
export interface ExteriorLamp {
  /** In the element's frame (x forward, y left, z up from the frame's origin), base units. */
  readonly local: readonly [number, number, number];
  /** Its axis, in the frame; undefined for a lamp that shines every way. */
  readonly aim?: readonly [number, number, number];
  /** The cosines of the angle from its axis inside which it is full and past which it is dark. */
  readonly cone?: { readonly inner: number; readonly outer: number };
  /** Its share of the light. */
  readonly share: number;
  /** The size of what shines. */
  readonly radius: number;
}

/** A cone from a beam's spread: full to 60 % of half of it, dark past its edge. */
function coneOf(beam: number): { inner: number; outer: number } {
  const half = Math.min(89, beam / 2) * (Math.PI / 180);
  return { inner: Number(Math.cos(half * 0.6).toFixed(4)), outer: Number(Math.cos(half).toFixed(4)) };
}

/** A canopy's middle, about 3 m over an uplight, is what it is aimed at. */
const CANOPY = 3000 * MM;

/**
 * The lamps an exterior light shines with (FLR-T-15.5): a path light's under its cap, down and out;
 * an uplight's at its lens, aimed up at what is `reach` ahead of it; a wall-washer's down its wall
 * and onto the ground before it; a step light's down onto the tread; a string's from three of its
 * bulbs, every way. Its box gives the frame's extents.
 */
export function exteriorLamps(ext: ExteriorData, min: readonly number[], max: readonly number[]): ExteriorLamp[] {
  const cx = ((min[0] ?? 0) + (max[0] ?? 0)) / 2;
  const cy = ((min[1] ?? 0) + (max[1] ?? 0)) / 2;
  const top = max[2] ?? 0;
  const bottom = min[2] ?? 0;
  switch (ext.kind) {
    case 'path':
      // Under the cap: down and out to a little under the horizontal.
      return [{ local: [Math.round(cx), Math.round(cy), Math.round(top - 30 * MM)], aim: [0, 0, -1], cone: { inner: 0.5, outer: 0.0349 }, share: 1, radius: 20 * MM }];
    case 'uplight': {
      const r = Math.max(1, ext.reach);
      const l = Math.hypot(r, CANOPY);
      return [{ local: [Math.round(cx), Math.round(cy), Math.round(top + 15 * MM)], aim: [Number((r / l).toFixed(4)), 0, Number((CANOPY / l).toFixed(4))], cone: coneOf(ext.beam), share: 1, radius: 15 * MM }];
    }
    case 'wallWash': {
      // Down the wall, tipped out a quarter: the wall lit under it and the ground before it.
      const l = Math.hypot(0.45, 1);
      return [{ local: [Math.round((max[0] ?? 0) + 15 * MM), Math.round(cy), Math.round((top + bottom) / 2)], aim: [Number((0.45 / l).toFixed(4)), 0, Number((-1 / l).toFixed(4))], cone: coneOf(ext.beam), share: 1, radius: 15 * MM }];
    }
    case 'step': {
      const l = Math.hypot(1, 1.2);
      return [{ local: [Math.round((max[0] ?? 0) + 10 * MM), Math.round(cy), Math.round((top + bottom) / 2)], aim: [Number((1 / l).toFixed(4)), 0, Number((-1.2 / l).toFixed(4))], cone: coneOf(ext.beam), share: 1, radius: 10 * MM }];
    }
    case 'string': {
      // Three of its bulbs, on the sag: the cable's lowest point is the box's bottom, mid-run.
      const x0 = min[0] ?? 0;
      const run = (max[0] ?? 0) - x0;
      const sag = top - bottom;
      return [1 / 6, 1 / 2, 5 / 6].map((t) => {
        const s = 2 * t - 1;
        return { local: [Math.round(x0 + run * t), Math.round(cy), Math.round(top - sag * (1 - s * s) - 60 * MM)], share: 1 / 3, radius: 30 * MM };
      });
    }
  }
}
