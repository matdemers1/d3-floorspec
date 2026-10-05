import type { Point } from './model';
import type { Viewport } from './store';
import { BASE_PER_FOOT, BASE_PER_MM, type UnitSystem } from './units';

/**
 * The canvas's camera. The plan is drawn in screen pixels, not in base units under an SVG
 * transform: base units run to tens of millions, which is past what a browser's float32 rendering
 * keeps exact, and pixels let strokes and labels keep their size at every zoom.
 */

/** One foot on screen at 100%: the design's sample house is drawn at 12 px per foot. */
export const PX_PER_FOOT_AT_100 = 16;
export const MIN_SCALE = (PX_PER_FOOT_AT_100 * 0.05) / BASE_PER_FOOT;
export const MAX_SCALE = (PX_PER_FOOT_AT_100 * 40) / BASE_PER_FOOT;

export const toScreen = (v: Viewport, p: Point): Point => [(p[0] - v.cx) * v.s + v.w / 2, v.h / 2 - (p[1] - v.cy) * v.s];
export const toWorld = (v: Viewport, q: Point): Point => [(q[0] - v.w / 2) / v.s + v.cx, (v.h / 2 - q[1]) / v.s + v.cy];

/** Zoom as a percentage of the 100% scale, for the zoom control. */
export const zoomPercent = (v: Viewport): number => Math.round((v.s * BASE_PER_FOOT * 100) / PX_PER_FOOT_AT_100);

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Zoom by `factor` keeping the world point under `at` (screen) where it is. */
export function zoomAt(v: Viewport, factor: number, at: Point): Viewport {
  const s = clampScale(v.s * factor);
  const before = toWorld(v, at);
  const next = { ...v, s };
  const after = toWorld(next, at);
  return { ...next, cx: next.cx + before[0] - after[0], cy: next.cy + before[1] - after[1] };
}

/** Pan by a screen delta. */
export const panBy = (v: Viewport, dx: number, dy: number): Viewport => ({ ...v, cx: v.cx - dx / v.s, cy: v.cy + dy / v.s });

/** Frame a world rectangle with `pad` pixels around it; an empty level frames 40 ft. */
export function fit(bounds: { minX: number; minY: number; maxX: number; maxY: number } | null, w: number, h: number, pad = 72): Viewport {
  const b = bounds ?? { minX: -20 * BASE_PER_FOOT, minY: -14 * BASE_PER_FOOT, maxX: 20 * BASE_PER_FOOT, maxY: 14 * BASE_PER_FOOT };
  const bw = Math.max(b.maxX - b.minX, 4 * BASE_PER_FOOT);
  const bh = Math.max(b.maxY - b.minY, 4 * BASE_PER_FOOT);
  const s = clampScale(Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh));
  return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, s, w, h };
}

/**
 * Grid lines at a spacing that stays 12–60 px apart: inches, feet, 5 and 10 ft in ft-in; 10 mm to
 * 10 m in metric. Returns the minor spacing and how many minors make a major.
 */
export function gridSpacing(v: Viewport, system: UnitSystem): { minor: number; every: number } {
  const steps =
    system === 'metric'
      ? [10, 50, 100, 500, 1000, 5000, 10000].map((mm) => mm * BASE_PER_MM)
      : [BASE_PER_FOOT / 12, BASE_PER_FOOT / 2, BASE_PER_FOOT, 5 * BASE_PER_FOOT, 10 * BASE_PER_FOOT, 50 * BASE_PER_FOOT];
  const minor = steps.find((step) => step * v.s >= 12) ?? steps.reduce((a, b) => Math.max(a, b), 0);
  const i = steps.indexOf(minor);
  const major = steps.slice(i + 1).find((step) => step * v.s >= 60) ?? minor * 10;
  return { minor, every: Math.max(1, Math.round(major / minor)) };
}

/** A scale bar of a round length about 100 px long: "10 ft", "2 m". */
export function scaleBar(v: Viewport, system: UnitSystem): { px: number; label: string } {
  const candidates =
    system === 'metric'
      ? [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50].map((m) => ({ base: m * 1000 * BASE_PER_MM, label: m < 1 ? `${String(m * 1000)} mm` : `${String(m)} m` }))
      : [1, 2, 5, 10, 20, 50, 100].map((ft) => ({ base: ft * BASE_PER_FOOT, label: `${String(ft)} ft` }));
  const best = candidates.find((c) => c.base * v.s >= 80) ?? candidates.reduce((a, b) => (b.base > a.base ? b : a));
  return { px: best.base * v.s, label: best.label };
}
