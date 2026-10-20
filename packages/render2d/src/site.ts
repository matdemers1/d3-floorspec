/**
 * FS_site in plan (FS_site chapter 5, FLR-T-15.1): the lot and its setbacks, the terrain as contours
 * with their heights, the survey's spot elevations, and where each graded outline cuts and fills the
 * ground — one drawing for the editor's canvas, `renderPlan` and the PDF.
 *
 * - **contours** every interval of the survey's datum (1′ by default), every fifth heavier and labelled,
 *   and the survey's own contour lines dashed beneath them;
 * - **cut** amber and hatched, **fill** blue and dashed — colour is never the only cue (5.2.1);
 * - **spots** a target and the height in the survey's datum: "816.20′";
 * - **the lot** a heavy dash-dot line with each edge's bearing and length, and the **setback line** a
 *   dashed amber line inside it, each side labelled with its setback.
 *
 * Everything comes from the engine's `siteDrawing(doc)`: the surface is the exact one FS_site derives.
 */
import { bearingOf, contoursOf, cutFillOf, type SiteDrawing } from '@floorspec/engine';
import { feetInches, num } from './format.js';
import { el, esc, polylinePath, ringsPath, type XY } from './svg.js';
import type { Palette } from './theme.js';

const FT = 390_144;

interface Draw {
  readonly s: number;
  readonly P: (p: readonly [number, number]) => XY;
}

/** A height in the survey's datum, to the hundredth of a foot: "816.20′". */
export function surveyHeight(z: number, benchmark: number): string {
  return `${((benchmark + z) / FT).toFixed(2)}′`;
}

/** What the site's layers draw, each a string of SVG (empty when there is nothing to draw). */
export interface SiteLayers {
  /** The contours, their labels, and the survey's own contour lines. */
  readonly contours: string;
  /** Cut and fill under each graded outline. */
  readonly grading: string;
  /** The spot elevations. */
  readonly spots: string;
  /** The lot, its edges' bearings and lengths, and the setback line. */
  readonly lot: string;
  /** The patterns the layers use: put once in a `<defs>`. */
  readonly defs: string;
}

export interface SiteDrawOptions {
  /** The contour interval in base units of the survey's datum (default 1′). */
  readonly interval?: number;
  /** Every how many contours is a major one (default 5). */
  readonly majorEvery?: number;
  /** Draw labels (contour heights, spot heights, bearings, setbacks); default true. */
  readonly labels?: boolean;
  /** A prefix for the pattern IDs, so two drawings on one page do not share them. */
  readonly idPrefix?: string;
}

const centroid = (pts: readonly XY[]): XY => {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
};

/** A label with a halo in the paper's colour, so it reads over lines. */
function label(at: XY, text: string, pal: Palette, attrs: Record<string, string | number> = {}): string {
  return el(
    'text',
    { x: num(at[0]), y: num(at[1]), 'font-size': 10, 'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace', fill: pal.siteInk, stroke: pal.paper, 'stroke-width': 3, 'paint-order': 'stroke', 'stroke-linejoin': 'round', 'text-anchor': 'middle', ...attrs },
    esc(text),
  );
}

/** The middle of the longest segment of a polyline, in drawing coordinates. */
function midOfLongest(pts: readonly XY[]): XY | undefined {
  let best: XY | undefined;
  let len = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > len) {
      len = l;
      best = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }
  }
  return best;
}

/** The site's layers in plan. */
export function siteLayers(site: SiteDrawing, f: Draw, pal: Palette, options: SiteDrawOptions = {}): SiteLayers {
  const interval = options.interval ?? FT;
  const majorEvery = options.majorEvery ?? 5;
  const labels = options.labels ?? true;
  const id = options.idPrefix ?? 'fs';
  const cutId = `${id}-cut-hatch`;
  const fillId = `${id}-fill-dash`;
  // cut: amber, hatched; fill: blue, in rows of dashes — two patterns, so colour is never the only cue (5.2.1)
  const defs =
    el(
      'pattern',
      { id: cutId, patternUnits: 'userSpaceOnUse', width: 7, height: 7, patternTransform: 'rotate(45)' },
      el('rect', { width: 7, height: 7, fill: pal.cut, 'fill-opacity': 0.2 }) + el('path', { d: 'M0 0V7', stroke: pal.cut, 'stroke-width': 1.5 }),
    ) +
    el(
      'pattern',
      { id: fillId, patternUnits: 'userSpaceOnUse', width: 10, height: 6 },
      el('rect', { width: 10, height: 6, fill: pal.fill, 'fill-opacity': 0.2 }) + el('path', { d: 'M1 3H6', stroke: pal.fill, 'stroke-width': 1.2, 'stroke-linecap': 'round' }),
    );

  // ── contours (5.1) ──
  let contours = '';
  for (const c of site.contours) contours += el('path', { 'data-contour-line': c.id, d: polylinePath(c.points.map(f.P)), fill: 'none', stroke: pal.contour, 'stroke-width': 0.75, 'stroke-dasharray': '2 3' });
  if (site.surface) {
    for (const c of contoursOf(site.surface, interval, site.benchmark, majorEvery)) {
      const lines = c.lines.map((l) => l.map(f.P));
      const d = lines.map((l) => polylinePath(l)).join('');
      contours += el('path', { 'data-contour': Math.round((c.height / interval) * 100) / 100, d, fill: 'none', stroke: c.major ? pal.contourMajor : pal.contour, 'stroke-width': c.major ? 1.4 : 0.8, 'stroke-linejoin': 'round' });
      if (labels && (c.major || interval >= FT)) {
        const longest = lines.reduce<XY[] | undefined>((m, l) => (m === undefined || l.length > m.length ? l : m), undefined);
        const at = longest && midOfLongest(longest);
        if (at) contours += label([at[0], at[1] + 3.5], `${Math.round((c.height / FT) * 10) / 10}`, pal, { 'data-contour-label': '', 'font-size': c.major ? 10 : 9, fill: c.major ? pal.contourMajor : pal.siteInk });
      }
    }
  }

  // ── cut and fill (5.2): amber hatched where the ground is cut, blue dashed where it is filled ──
  let grading = '';
  if (site.surface) {
    for (const g of site.graded) {
      const r = cutFillOf(site.surface, g.ring, g.elevation);
      // each piece's own winding: the pieces of one outline never overlap, so `nonzero` fills each once
      if (r.cut.length) grading += el('path', { 'data-cut': g.id, d: ringsPath(r.cut.map((p) => p.map(f.P))), fill: `url(#${cutId})`, stroke: 'none' });
      if (r.fill.length) grading += el('path', { 'data-fill': g.id, d: ringsPath(r.fill.map((p) => p.map(f.P))), fill: `url(#${fillId})`, stroke: 'none' });
    }
  }

  // ── spots ──
  let spots = '';
  for (const sp of site.spots) {
    const [x, y] = f.P(sp.at);
    const target = el('circle', { cx: num(x), cy: num(y), r: 4, fill: 'none', stroke: pal.siteInk, 'stroke-width': 1 }) + el('path', { d: `M${num(x - 6)} ${num(y)}H${num(x + 6)}M${num(x)} ${num(y - 6)}V${num(y + 6)}`, stroke: pal.siteInk, 'stroke-width': 0.75 });
    spots += el('g', { 'data-spot': sp.id }, target + (labels ? label([x + 8, y - 6], surveyHeight(sp.elevation, site.benchmark), pal, { 'text-anchor': 'start' }) : ''));
  }

  // ── the lot and its setbacks (5.3) ──
  let lot = '';
  if (site.lot) {
    const ring = site.lot.map(f.P);
    lot += el('path', { 'data-lot': '', d: ringsPath([ring]), fill: 'none', stroke: pal.lotLine, 'stroke-width': 1.6, 'stroke-dasharray': '10 3 2 3' });
    if (site.setbackLine && site.setbackLine.length >= 3)
      lot += el('path', { 'data-setbacks': '', d: ringsPath([site.setbackLine.map(f.P)]), fill: 'none', stroke: pal.setback, 'stroke-width': 1.2, 'stroke-dasharray': '6 4' });
    if (labels) {
      const c = centroid(ring);
      for (const e of site.edges) {
        const a = f.P(e.from);
        const b = f.P(e.to);
        const m: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        // outward: away from the lot's centre
        let nx = -(b[1] - a[1]);
        let ny = b[0] - a[0];
        const l = Math.hypot(nx, ny) || 1;
        nx /= l;
        ny /= l;
        if ((m[0] - c[0]) * nx + (m[1] - c[1]) * ny < 0) {
          nx = -nx;
          ny = -ny;
        }
        let angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
        if (angle > 90) angle -= 180;
        if (angle < -90) angle += 180;
        const at: XY = [m[0] + nx * 12, m[1] + ny * 12 + 3.5];
        const text = `${bearingOf(e.from, e.to)} · ${(e.length / FT).toFixed(1)}′${e.kind === 'front' ? ' · street line' : ''}`;
        lot += label(at, text, pal, { 'data-edge': e.index, transform: `rotate(${num(angle)} ${num(at[0])} ${num(at[1] - 3.5)})`, fill: pal.lotLine });
        if (e.setback !== null && e.setback > 0 && e.kind !== null) {
          const s: XY = [m[0] - nx * (e.setback * f.s + 10), m[1] - ny * (e.setback * f.s + 10) + 3.5];
          lot += label(s, `${feetInches(e.setback)} ${e.kind}`, pal, { 'data-setback-label': e.kind, fill: pal.setback, transform: `rotate(${num(angle)} ${num(s[0])} ${num(s[1] - 3.5)})` });
        }
      }
    }
  }
  return { contours, grading, spots, lot, defs };
}

/** The extent the site adds to a drawing: the lot's and the survey's points, in base units. */
export function siteExtent(site: SiteDrawing): XY[] {
  const out: XY[] = [];
  // the lot's corners, and room round them for the bearings and the spots' heights
  const room = 8 * FT;
  for (const p of site.lot ?? []) out.push(p, [p[0] - room, p[1] - room], [p[0] + room, p[1] + room]);
  for (const s of site.spots) out.push(s.at);
  for (const c of site.contours) out.push(...c.points);
  return out;
}
