/**
 * Plan styles on a drawing sheet (FLR-T-18.5): the PDF draws the plan in the style the editor and
 * `renderPlan` draw it in, from the same theme (@floorspec/render2d's `planTheme`) — always its
 * light theme, since a sheet is paper.
 *
 * - **Colour** and **Presentation**: each room's floor in its finish's colour with its pattern's
 *   lines at true scale (boards, tile joints, pavers, a slab's joints), clipped to the room; slabs in
 *   theirs; furniture in colour; walls a solid poché (Presentation's charcoal). A PDF path carries no
 *   blur, so Presentation's soft shadows are the screen's and the PNG's only.
 * - **Technical**: the construction drawing it always was, with exterior walls hatched over the paper.
 * - **Blueprint**: Technical, its plan drawn in white on blueprint blue.
 */
import { floorFinishOf, furnitureTone, isPlanStyle, planTheme, shade, type FinishSource, type FloorPattern, type PlanStyle, type PlanTheme } from '@floorspec/render2d';
import type { LevelPlan, XY } from './plan.js';

export { isPlanStyle, type PlanStyle };

type Pt = readonly [number, number];

/** A sheet's style: the theme it draws from. */
export function sheetTheme(style: PlanStyle): PlanTheme {
  return planTheme(style, 'light');
}

/**
 * The joints of a floor's pattern across a box, in plan coordinates: rows of boards with their
 * staggered ends, a tile grid, a running bond, a slab's control joints. None for a pattern finer
 * than `minimum` base units, or one without straight joints (herringbone, carpet, plain).
 */
export function patternJoints(pattern: FloorPattern, rotation: number, ring: readonly Pt[], minimum: number): [Pt, Pt][] {
  const a = (rotation / 1_000_000) * (Math.PI / 180);
  const u: Pt = [Math.cos(a), Math.sin(a)];
  const v: Pt = [-u[1], u[0]];
  let s0 = Infinity;
  let s1 = -Infinity;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const p of ring) {
    const s = p[0] * u[0] + p[1] * u[1];
    const t = p[0] * v[0] + p[1] * v[1];
    s0 = Math.min(s0, s);
    s1 = Math.max(s1, s);
    t0 = Math.min(t0, t);
    t1 = Math.max(t1, t);
  }
  const at = (s: number, t: number): Pt => [s * u[0] + t * v[0], s * u[1] + t * v[1]];
  const out: [Pt, Pt][] = [];
  const rows = (h: number, joint: (row: number, s: number) => number, w: number): void => {
    for (let j = Math.floor(t0 / h); j * h <= t1; j++) {
      const t = j * h;
      out.push([at(s0, t), at(s1, t)]);
      for (let i = Math.floor((s0 - w) / w); i * w <= s1 + w; i++) {
        const s = joint(j, i * w);
        if (s >= s0 && s <= s1) out.push([at(s, t), at(s, t + h)]);
      }
    }
  };
  const STAGGER = [0, 0.42, 0.78, 0.2, 0.6, 0.9] as const;
  switch (pattern.kind) {
    case 'plank':
      if (pattern.width < minimum) return [];
      rows(pattern.width, (j, s) => s + STAGGER[((j % 6) + 6) % 6]! * pattern.length, pattern.length);
      return out;
    case 'tile':
      if (Math.min(pattern.w, pattern.h) < minimum) return [];
      rows(pattern.h, (j, s) => (pattern.bond === 'running' && j % 2 !== 0 ? s + pattern.w / 2 : s), pattern.w);
      return out;
    case 'terrazzo':
      if (pattern.tile < minimum) return [];
      rows(pattern.tile, (_, s) => s, pattern.tile);
      return out;
    case 'slab':
      if (pattern.joint < minimum) return [];
      rows(pattern.joint, (_, s) => s, pattern.joint);
      return out;
    default:
      return [];
  }
}

/** A floor as a sheet draws it: its colour and its joints' colour. */
export function floorLook(source: FinishSource | undefined, t: PlanTheme): { fill: string; joint: string; pattern: FloorPattern; rotation: number } {
  if (source === undefined) return { fill: t.floorPlain, joint: shade(t.floorPlain, -0.12), pattern: { kind: 'plain' }, rotation: 0 };
  const f = floorFinishOf(source);
  return { fill: f.color, joint: shade(f.color, -0.22), pattern: f.pattern, rotation: f.rotation };
}

/** An item's colour on a sheet, by what it is; null for one drawn in the sheet's ink. */
export function deviceLook(plan: LevelPlan, id: string, t: PlanTheme): { fill: string; ink: string } | null {
  const fb = plan.scene.fallbacks.get(id);
  // A garden's boxes on a sheet are its fallbacks, not furniture: drawn in the sheet's ink.
  if (fb === undefined || fb.extension === 'FS_landscape') return null;
  return furnitureTone(fb.category, fb.collection, fb.catalogue, t);
}

/** Blueprint's colours on a sheet: the plan's inks to white and blues, its paper to blueprint blue. */
export const BLUEPRINT = { paper: '#1d4c8a', ink: '#ffffff', grey: '#d6e2f3', faint: '#a9c1e2', fill: '#2b5c9c' } as const;

export type { XY };
