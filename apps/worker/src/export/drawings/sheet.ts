/**
 * Drawing sheets (FLR-T-9.3), composed as a display list in paper points (y down) that the PDF
 * writer (and, for previews, the SVG writer) draws without deciding anything. Composing is pure:
 * the same document, options and font metrics give the same list, and so the same PDF bytes.
 *
 * A sheet is one level's floor plan at a true architectural scale with its dimension strings, room
 * labels and door and window marks; a title strip down the right edge with the project, a
 * NOT FOR CONSTRUCTION block, the 3D view, the legend and the sheet's facts (scale, date, version);
 * and, where it fits beside or under the plan, the level's door and window schedule.
 */
import { num } from '@floorspec/render2d';
import type { AxoFace } from './axo.js';
import type { DimString, Side } from './dimensions.js';
import type { Box, LevelPlan, XY } from './plan.js';
import { areaText, BU_PER_INCH, IMPERIAL_SCALES, lengthText, METRIC_SCALES, type DrawingScale, type UnitSystem } from './units.js';

// ── the display list ─────────────────────────────────────────────────────────

export type FontName = 'sans' | 'sans-medium' | 'sans-bold' | 'mono' | 'mono-medium';
export type Measure = (text: string, font: FontName, size: number) => number;

export interface PathPrim {
  readonly t: 'path';
  readonly d: string;
  readonly fill?: string;
  readonly stroke?: string;
  readonly width?: number;
  readonly dash?: readonly number[];
  readonly evenOdd?: boolean;
  readonly cap?: 'butt' | 'round' | 'square';
  readonly join?: 'miter' | 'round' | 'bevel';
}

export interface TextPrim {
  readonly t: 'text';
  readonly x: number;
  /** The baseline. */
  readonly y: number;
  readonly text: string;
  readonly font: FontName;
  readonly size: number;
  readonly color: string;
  readonly anchor: 'start' | 'middle' | 'end';
  /** Degrees, clockwise on the page (−90 reads bottom to top). */
  readonly rotate?: number;
}

export interface ClipPrim {
  readonly t: 'clip';
  readonly d: string;
  readonly children: readonly Prim[];
}

export type Prim = PathPrim | TextPrim | ClipPrim;

export interface Sheet {
  /** A-101, A-102, … and A-601 for a schedule sheet. */
  readonly number: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly prims: readonly Prim[];
}

// ── pages ────────────────────────────────────────────────────────────────────

export type PageName = 'tabloid' | 'arch-d' | 'arch-c' | 'letter' | 'a4' | 'a3';

export interface PageSpec {
  readonly name: PageName;
  readonly label: string;
  /** Landscape, in points. */
  readonly width: number;
  readonly height: number;
}

const MM = 72 / 25.4;

/** The page sizes a set can be printed on, landscape. Tabloid is the default: an office printer takes it. */
export const PAGES: Readonly<Record<PageName, PageSpec>> = {
  tabloid: { name: 'tabloid', label: 'Tabloid 17 × 11 in', width: 17 * 72, height: 11 * 72 },
  'arch-c': { name: 'arch-c', label: 'ARCH C 24 × 18 in', width: 24 * 72, height: 18 * 72 },
  'arch-d': { name: 'arch-d', label: 'ARCH D 36 × 24 in', width: 36 * 72, height: 24 * 72 },
  letter: { name: 'letter', label: 'Letter 11 × 8.5 in', width: 11 * 72, height: 8.5 * 72 },
  a4: { name: 'a4', label: 'A4 297 × 210 mm', width: Math.round(297 * MM * 100) / 100, height: Math.round(210 * MM * 100) / 100 },
  a3: { name: 'a3', label: 'A3 420 × 297 mm', width: Math.round(420 * MM * 100) / 100, height: Math.round(297 * MM * 100) / 100 },
};

export const DEFAULT_PAGE: PageName = 'tabloid';

// ── ink ──────────────────────────────────────────────────────────────────────

const INK = '#000000';
const GREY = '#4d4d4d';
const FAINT = '#8c8c8c';
const HAIR = '#b3b3b3';
const POCHE = '#3d3d3d';
const RED = '#c4161c';
const WHITE = '#ffffff';
const PAPER_FILL = '#ffffff';

const grey = (v: number): string => {
  const h = Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
};

// ── geometry helpers ─────────────────────────────────────────────────────────

const M = (p: XY): string => `M${num(p[0])} ${num(p[1])}`;
const L = (p: XY): string => `L${num(p[0])} ${num(p[1])}`;
const line = (a: XY, b: XY): string => `${M(a)}${L(b)}`;
const ring = (pts: readonly XY[]): string => (pts.length === 0 ? '' : `${M(pts[0]!)}${pts.slice(1).map(L).join('')}Z`);
const rect = (x: number, y: number, w: number, h: number): string => ring([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);

function circle(cx: number, cy: number, r: number): string {
  return `M${num(cx - r)} ${num(cy)}A${num(r)} ${num(r)} 0 1 0 ${num(cx + r)} ${num(cy)}A${num(r)} ${num(r)} 0 1 0 ${num(cx - r)} ${num(cy)}Z`;
}

function hexagon(cx: number, cy: number, r: number): string {
  const h = (r * Math.sqrt(3)) / 2;
  return ring([[cx - r, cy], [cx - r / 2, cy - h], [cx + r / 2, cy - h], [cx + r, cy], [cx + r / 2, cy + h], [cx - r / 2, cy + h]]);
}

function text(x: number, y: number, s: string, font: FontName, size: number, opts: { color?: string; anchor?: TextPrim['anchor']; rotate?: number } = {}): TextPrim {
  return { t: 'text', x, y, text: s, font, size, color: opts.color ?? INK, anchor: opts.anchor ?? 'start', ...(opts.rotate === undefined ? {} : { rotate: opts.rotate }) };
}

function wrap(s: string, width: number, font: FontName, size: number, measure: Measure): string[] {
  const words = s.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur === '' ? w : `${cur} ${w}`;
    if (cur !== '' && measure(next, font, size) > width) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

// ── the set's layout ─────────────────────────────────────────────────────────

/** Paper offset of the first dimension string from the drawing, and between strings (points). */
const DIM_FIRST = 22;
const DIM_STEP = 15;
const DIM_TEXT = 6;
const VIEW_TITLE = 48;

export interface ScheduleRow {
  readonly mark: string;
  readonly kind: 'door' | 'window';
  readonly type: string;
  readonly size: string;
  readonly sill: string;
  readonly name: string;
}

export interface SetLayout {
  readonly page: PageSpec;
  readonly scale: DrawingScale;
  /** Points per base unit. */
  readonly k: number;
  /** The world window every level is placed by, so stacked plans line up sheet to sheet. */
  readonly frame: Box;
  readonly margins: Readonly<Record<Side, number>>;
  /** Paper position of the frame's top-left (min x, max y). */
  readonly origin: XY;
  readonly area: { x: number; y: number; w: number; h: number };
  readonly strip: { x: number; y: number; w: number; h: number };
  readonly schedule: { x: number; y: number; w: number } | 'sheet' | null;
}

const SCHEDULE_W = 300;
const ROW = 10.5;

function dimMargin(tiers: number): number {
  return tiers === 0 ? 10 : DIM_FIRST + (tiers - 1) * DIM_STEP + 2 * DIM_TEXT + 12;
}

/**
 * Choose one scale and one placement for the whole set: the largest architectural scale at which
 * every level, its dimension strings and its view title fit the drawing area (capped at 1/4" or
 * 1:50 — a house plan at a larger scale is a detail, not a plan).
 */
export function layoutSet(page: PageSpec, frame: Box, dims: readonly DimString[], units: UnitSystem, scheduleRows: number): SetLayout {
  const m = page.width >= 1700 ? 36 : 24;
  const stripW = Math.round(Math.min(260, Math.max(176, page.width * 0.19)));
  const strip = { x: page.width - m - stripW, y: m, w: stripW, h: page.height - 2 * m };
  const pad = 14;
  const area = { x: m + pad, y: m + pad, w: strip.x - m - 2 * pad, h: page.height - 2 * m - 2 * pad };
  const tiers = (side: Side): number => dims.filter((d) => d.side === side).reduce((n, d) => Math.max(n, d.tier + 1), 0);
  const margins: Record<Side, number> = { N: dimMargin(tiers('N')), S: dimMargin(tiers('S')), E: dimMargin(tiers('E')), W: dimMargin(tiers('W')) };
  const fw = frame.maxX - frame.minX;
  const fh = frame.maxY - frame.minY;
  const scales = units === 'metric' ? METRIC_SCALES : IMPERIAL_SCALES;
  const kOf = (s: DrawingScale): number => (units === 'metric' ? 72 / (25.4 * 1280 * s.ratio) : 72 / (BU_PER_INCH * s.ratio));
  const blockOf = (k: number): { w: number; h: number } => ({ w: fw * k + margins.W + margins.E, h: fh * k + margins.N + margins.S + VIEW_TITLE });
  const scale = scales.find((s) => {
    const b = blockOf(kOf(s));
    return b.w <= area.w && b.h <= area.h;
  }) ?? scales[scales.length - 1]!;
  const k = kOf(scale);
  const block = blockOf(k);
  const tableH = (scheduleRows + 3) * ROW;
  let schedule: SetLayout['schedule'] = null;
  let avail = { ...area };
  if (scheduleRows > 0) {
    if (area.w - block.w >= SCHEDULE_W + 18 && tableH <= area.h) {
      schedule = { x: area.x + area.w - SCHEDULE_W, y: area.y, w: SCHEDULE_W };
      avail = { ...area, w: area.w - SCHEDULE_W - 18 };
    } else if (area.h - block.h >= tableH + 24) {
      schedule = { x: area.x + area.w - SCHEDULE_W, y: area.y + area.h - tableH, w: SCHEDULE_W };
      avail = { ...area, h: area.h - tableH - 24 };
    } else schedule = 'sheet';
  }
  const ox = avail.x + (avail.w - block.w) / 2 + margins.W;
  const oy = avail.y + (avail.h - block.h) / 2 + margins.N;
  return { page, scale, k, frame, margins, origin: [ox, oy], area, strip, schedule };
}

// ── one sheet ────────────────────────────────────────────────────────────────

export interface SheetMeta {
  readonly projectName: string;
  readonly levelName: string;
  readonly sheetNumber: string;
  /** e.g. `2026-10-05` — the version's own time, never the time of the export. */
  readonly date: string;
  /** e.g. `v42 · 3c9e1f0a71fe`. */
  readonly version: string;
  readonly units: UnitSystem;
  readonly sheetIndex: number;
  readonly sheetCount: number;
  /** What the 3D view shows: `Cut above Main floor`, `Whole model`. */
  readonly viewCaption: string;
}

interface Ctx {
  readonly out: Prim[];
  readonly measure: Measure;
  readonly k: number;
  readonly P: (p: XY) => XY;
}

/** `Main floor` → `Main floor plan`; `Level 2` → `Level 2 floor plan`. */
export function planTitle(levelName: string): string {
  return /\bfloor$/i.test(levelName.trim()) ? `${levelName.trim()} plan` : `${levelName.trim()} floor plan`;
}

export function composePlanSheet(
  layout: SetLayout,
  plan: LevelPlan,
  dims: readonly DimString[],
  axo: readonly AxoFace[],
  rows: readonly ScheduleRow[],
  meta: SheetMeta,
  measure: Measure,
): Sheet {
  const { page, k, frame, origin } = layout;
  const P = (p: XY): XY => [origin[0] + (p[0] - frame.minX) * k, origin[1] + (frame.maxY - p[1]) * k];
  const out: Prim[] = [];
  const c: Ctx = { out, measure, k, P };

  out.push({ t: 'path', d: rect(0, 0, page.width, page.height), fill: PAPER_FILL });
  drawPlan(c, plan);
  drawDimensions(c, plan, dims, meta.units);
  drawRoomLabels(c, plan, meta.units);
  drawTags(c, plan);
  drawViewTitle(c, layout, plan, meta);
  if (layout.schedule !== null && layout.schedule !== 'sheet') drawSchedule(c, layout.schedule, rows, `${meta.levelName} — door and window schedule`);
  drawBorder(c, layout);
  drawStrip(c, layout, axo, meta, planTitle(meta.levelName), plan.rooms.map((r) => [r.title, areaText(r.area, meta.units)]));
  return { number: meta.sheetNumber, title: planTitle(meta.levelName), width: page.width, height: page.height, prims: out };
}

/** The schedule sheet a set ends with when a level's schedule fits beside none of its plans. */
export function composeScheduleSheet(layout: SetLayout, groups: readonly { title: string; rows: readonly ScheduleRow[] }[], axo: readonly AxoFace[], meta: SheetMeta, measure: Measure): Sheet {
  const { page } = layout;
  const out: Prim[] = [{ t: 'path', d: rect(0, 0, page.width, page.height), fill: PAPER_FILL }];
  const c: Ctx = { out, measure, k: layout.k, P: (p) => p };
  let x = layout.area.x;
  let y = layout.area.y;
  for (const g of groups) {
    const h = (g.rows.length + 3) * ROW + 18;
    if (y + h > layout.area.y + layout.area.h && y > layout.area.y) {
      x += SCHEDULE_W + 24;
      y = layout.area.y;
    }
    drawSchedule(c, { x, y, w: SCHEDULE_W }, g.rows, g.title);
    y += h;
  }
  drawBorder(c, layout);
  drawStrip(c, layout, axo, meta, 'Door and window schedule', []);
  return { number: meta.sheetNumber, title: 'Door and window schedule', width: page.width, height: page.height, prims: out };
}

// ── the plan ─────────────────────────────────────────────────────────────────

function drawPlan(c: Ctx, plan: LevelPlan): void {
  const { out, P } = c;
  // Slabs: outlined, hatched.
  for (const s of plan.slabs) {
    const d = ring(s.outline.map(P));
    out.push({ t: 'path', d, fill: '#f2f2f2' });
    out.push({ t: 'clip', d, children: [{ t: 'path', d: hatch(s.outline.map(P), 5), stroke: HAIR, width: 0.35 }] });
    out.push({ t: 'path', d, stroke: FAINT, width: 0.5 });
  }
  // Unanchored faces: a light tone, so a face no room claims is visible.
  for (const u of plan.unanchored) out.push({ t: 'path', d: [u.outer, ...u.holes].map((r) => ring(r.map(P))).join(''), fill: '#f4f4f4', evenOdd: true });
  // Room separators: dashed.
  for (const [a, b] of plan.separators) out.push({ t: 'path', d: line(P(a), P(b)), stroke: GREY, width: 0.4, dash: [4, 2.5] });
  // Extension elements: their fallback boxes, light.
  for (const dv of plan.devices) out.push({ t: 'path', d: ring(dv.footprint.map(P)), fill: '#ececec', stroke: GREY, width: 0.35 });
  // Walls: the poché, then the openings cut out of it, then the outline as drawn.
  out.push({ t: 'path', d: plan.pieces.map((p) => ring(p.ring.map(P))).join(''), fill: POCHE, stroke: POCHE, width: 0.2, join: 'round' });
  if (plan.cuts.length > 0) out.push({ t: 'path', d: plan.cuts.map((q) => ring(q.map(P))).join(''), fill: WHITE, stroke: WHITE, width: 0.6 });
  const ext = plan.wallLines.filter((s) => s.layer === 'A-WALL-EXTR');
  const int = plan.wallLines.filter((s) => s.layer !== 'A-WALL-EXTR');
  if (int.length > 0) out.push({ t: 'path', d: int.map((s) => line(P(s.a), P(s.b))).join(''), stroke: INK, width: 0.6, cap: 'round' });
  if (ext.length > 0) out.push({ t: 'path', d: ext.map((s) => line(P(s.a), P(s.b))).join(''), stroke: INK, width: 0.9, cap: 'round' });
  // Windows: frame lines and glazing.
  for (const w of plan.windows) {
    const [f1, f2, g1, g2] = w.lines;
    const frameLines = [f1, f2].filter((l) => l !== undefined).map((l) => line(P(l[0]), P(l[1]))).join('');
    const glass = [g1, g2].filter((l) => l !== undefined).map((l) => line(P(l[0]), P(l[1]))).join('');
    out.push({ t: 'path', d: frameLines, stroke: INK, width: 0.45 });
    out.push({ t: 'path', d: glass, stroke: INK, width: 0.3 });
  }
  // Doors: the leaf open at 90°, and its swing.
  for (const dr of plan.doors) {
    const h = P(dr.hinge);
    const l = P(dr.leafEnd);
    const o = P(dr.closedEnd);
    const r = dr.radius * c.k;
    const sweep = (l[0] - h[0]) * (o[1] - h[1]) - (l[1] - h[1]) * (o[0] - h[0]) > 0 ? 1 : 0;
    out.push({ t: 'path', d: line(h, l), stroke: INK, width: 0.7, cap: 'butt' });
    out.push({ t: 'path', d: `${M(l)}A${num(r)} ${num(r)} 0 0 ${sweep} ${num(o[0])} ${num(o[1])}`, stroke: INK, width: 0.3 });
  }
}

/** Diagonal hatch lines covering a polygon's bounding box (clip to the polygon). */
function hatch(pts: readonly XY[], step: number): string {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  let d = '';
  const h = y1 - y0;
  for (let x = x0 - h; x <= x1; x += step) d += line([x, y1], [x + h, y0]);
  return d;
}

// ── dimensions ───────────────────────────────────────────────────────────────

function drawDimensions(c: Ctx, plan: LevelPlan, dims: readonly DimString[], units: UnitSystem): void {
  const ext = plan.extent;
  const body = plan.body;
  if (ext === undefined || body === undefined) return;
  const { out, P, measure } = c;
  const SIZE = 6;
  const lines: string[] = [];
  const ticks: string[] = [];
  const extLines: string[] = [];
  for (const d of dims) {
    const horizontal = d.side === 'N' || d.side === 'S';
    // The string sits beyond everything drawn on that side, `DIM_FIRST + tier·DIM_STEP` out.
    const off = DIM_FIRST + d.tier * DIM_STEP;
    const edge = d.side === 'N' ? P([0, ext.maxY])[1] - off : d.side === 'S' ? P([0, ext.minY])[1] + off : d.side === 'E' ? P([ext.maxX, 0])[0] + off : P([ext.minX, 0])[0] - off;
    const outward = d.side === 'N' || d.side === 'W' ? -1 : 1;
    const at = (v: number): XY => (horizontal ? [P([v, 0])[0], edge] : [edge, P([0, v])[1]]);
    const first = at(d.points[0]!);
    const last = at(d.points[d.points.length - 1]!);
    lines.push(horizontal ? line([first[0] - 4, edge], [last[0] + 4, edge]) : line([edge, first[1] + 4], [edge, last[1] - 4]));
    let prevEnd = -Infinity;
    d.points.forEach((v, i) => {
      const p = at(v);
      // Extension line: from a small gap off the feature to just past this string.
      const r = d.reach[i] ?? d.base;
      const from = horizontal ? P([0, r])[1] : P([r, 0])[0];
      const gap = from + outward * 4;
      extLines.push(horizontal ? line([p[0], gap], [p[0], edge + outward * 3]) : line([gap, p[1]], [edge + outward * 3, p[1]]));
      ticks.push(line([p[0] - 2.6, p[1] + 2.6], [p[0] + 2.6, p[1] - 2.6]));
      const next = d.points[i + 1];
      if (next === undefined) return;
      const q = at(next);
      const label = lengthText(next - v, units);
      const w = measure(label, 'mono', SIZE);
      const span = horizontal ? q[0] - p[0] : p[1] - q[1];
      const centre = horizontal ? (p[0] + q[0]) / 2 : (p[1] + q[1]) / 2;
      // Text sits on the outer side of the line; a label too long for its span moves out one row.
      const fits = w + 4 <= span;
      let along = centre;
      const row = fits ? 0 : 1;
      if (!fits) {
        const start = Math.max(centre - w / 2, prevEnd + 3);
        along = start + w / 2;
        prevEnd = start + w;
      }
      // Always on the outer side of the line, so a moved label never meets the next string in.
      const lift = 2 + row * (SIZE + 2);
      const cap = SIZE * 0.74;
      if (horizontal) out.push(text(along, d.side === 'N' ? edge - lift : edge + lift + cap, label, 'mono', SIZE, { anchor: 'middle', color: INK }));
      else out.push(text(d.side === 'W' ? edge - lift : edge + lift + cap, along, label, 'mono', SIZE, { anchor: 'middle', color: INK, rotate: -90 }));
    });
  }
  out.push({ t: 'path', d: extLines.join(''), stroke: GREY, width: 0.25 });
  out.push({ t: 'path', d: lines.join(''), stroke: INK, width: 0.3 });
  out.push({ t: 'path', d: ticks.join(''), stroke: INK, width: 0.9 });
}

// ── room labels and tags ─────────────────────────────────────────────────────

function drawRoomLabels(c: Ctx, plan: LevelPlan, units: UnitSystem): void {
  const { out, P, measure, k } = c;
  for (const r of plan.rooms) {
    const [x, y] = P(r.label);
    const span = freeSpan(r.label, [r.outer, ...r.holes]);
    const roomW = span.h * k - 8;
    const roomH = span.v * k - 6;
    const lines: { s: string; font: FontName; size: number }[] = [
      { s: r.title.toUpperCase(), font: 'sans-bold', size: 7 },
      { s: areaText(r.area, units), font: 'mono', size: 6 },
      { s: `${lengthText(r.width, units)} × ${lengthText(r.depth, units)}`, font: 'mono', size: 5.5 },
    ];
    // Drop the least important line until the label fits the room; shrink the name last.
    let ls = lines;
    const fits = (set: typeof lines): boolean => Math.max(...set.map((l) => measure(l.s, l.font, l.size))) <= roomW && set.reduce((h, l) => h + l.size * 1.25, 0) <= roomH;
    while (!fits(ls) && ls.length > 1) ls = ls.slice(0, -1);
    if (!fits(ls)) {
      const first = ls[0]!;
      const size = Math.max(4.5, (first.size * roomW) / Math.max(1, measure(first.s, first.font, first.size)));
      ls = [{ ...first, size: Math.min(first.size, size) }];
    }
    const total = ls.reduce((h, l) => h + l.size * 1.25, 0);
    let yy = y - total / 2;
    for (const l of ls) {
      yy += l.size * 1.25;
      out.push(text(x, yy - l.size * 0.25, l.s, l.font, l.size, { anchor: 'middle', color: l.font === 'sans-bold' ? INK : GREY }));
    }
  }
}

/** How far a point can reach horizontally and vertically, both ways, before it meets an edge (twice the nearer). */
function freeSpan(p: XY, rings: readonly (readonly XY[])[]): { h: number; v: number } {
  const [x, y] = p;
  let left = Infinity;
  let right = Infinity;
  let down = Infinity;
  let up = Infinity;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [ax, ay] = r[j]!;
      const [bx, by] = r[i]!;
      if (ay > y !== by > y) {
        const xi = ax + ((y - ay) * (bx - ax)) / (by - ay);
        if (xi <= x) left = Math.min(left, x - xi);
        else right = Math.min(right, xi - x);
      }
      if (ax > x !== bx > x) {
        const yi = ay + ((x - ax) * (by - ay)) / (bx - ax);
        if (yi <= y) down = Math.min(down, y - yi);
        else up = Math.min(up, yi - y);
      }
    }
  return { h: 2 * Math.min(left, right), v: 2 * Math.min(down, up) };
}

function drawTags(c: Ctx, plan: LevelPlan): void {
  const { out, P } = c;
  for (const t of plan.tags) {
    const b = P(t.base);
    // Model normal → paper (y flips).
    const r = t.kind === 'door' ? 5.2 : 5.6;
    const cx = b[0] + t.normal[0] * (r + 3);
    const cy = b[1] - t.normal[1] * (r + 3);
    out.push({ t: 'path', d: t.kind === 'door' ? circle(cx, cy, r) : hexagon(cx, cy, r), fill: WHITE, stroke: INK, width: 0.4 });
    out.push(text(cx, cy + 1.9, t.mark, 'sans-medium', t.mark.length > 2 ? 4.2 : 5, { anchor: 'middle' }));
  }
}

// ── view title, north arrow, scale bar ───────────────────────────────────────

function drawViewTitle(c: Ctx, layout: SetLayout, plan: LevelPlan, meta: SheetMeta): void {
  const { out, measure } = c;
  const x = layout.origin[0] - layout.margins.W + 4;
  const y = layout.origin[1] + (layout.frame.maxY - layout.frame.minY) * layout.k + layout.margins.S + 20;
  out.push({ t: 'path', d: circle(x + 11, y - 4, 11), stroke: INK, width: 0.8 });
  out.push({ t: 'path', d: line([x, y - 4], [x + 22, y - 4]), stroke: INK, width: 0.5 });
  out.push(text(x + 11, y - 7, String(meta.sheetIndex + 1), 'sans-bold', 7, { anchor: 'middle' }));
  out.push(text(x + 11, y + 4, meta.sheetNumber, 'sans', 4.6, { anchor: 'middle' }));
  const title = planTitle(plan.levelName).toUpperCase();
  out.push(text(x + 30, y - 5, title, 'sans-bold', 10));
  const tw = measure(title, 'sans-bold', 10);
  out.push({ t: 'path', d: line([x + 30, y - 1], [x + 30 + Math.max(tw, 120), y - 1]), stroke: INK, width: 1.1 });
  out.push(text(x + 30, y + 8, `SCALE: ${layout.scale.label}`, 'sans', 6.5, { color: GREY }));
  const barX = x + 30 + Math.max(tw, 120) + 22;
  scaleBar(c, layout, meta.units, barX, y - 2);
  northArrow(c, barX + scaleBarWidth(layout, meta.units) + 34, y - 6, plan.trueNorth);
}

function scaleBarSteps(units: UnitSystem): { total: number; label: (v: number) => string; values: number[] }[] {
  return units === 'metric'
    ? [1, 2, 5, 10, 20, 50].map((m) => ({ total: m * 1_280_000, label: (v: number) => `${String(v / 1_280_000)} m`, values: [0, 0.25, 0.5, 1].map((f) => f * m * 1_280_000) }))
    : [4, 8, 16, 32, 64].map((ft) => ({ total: ft * 390_144, label: (v: number) => `${String(v / 390_144)}'`, values: [0, 0.25, 0.5, 1].map((f) => f * ft * 390_144) }));
}

function pickBar(layout: SetLayout, units: UnitSystem): { total: number; label: (v: number) => string; values: number[] } {
  const steps = scaleBarSteps(units);
  return steps.find((s) => s.total * layout.k >= 72) ?? steps[steps.length - 1]!;
}

function scaleBarWidth(layout: SetLayout, units: UnitSystem): number {
  return pickBar(layout, units).total * layout.k;
}

function scaleBar(c: Ctx, layout: SetLayout, units: UnitSystem, x: number, y: number): void {
  const bar = pickBar(layout, units);
  const { out } = c;
  const h = 3.2;
  const xs = bar.values.map((v) => x + v * layout.k);
  for (let i = 0; i < xs.length - 1; i++) out.push({ t: 'path', d: rect(xs[i]!, y - h, xs[i + 1]! - xs[i]!, h), fill: i % 2 === 0 ? INK : WHITE, stroke: INK, width: 0.4 });
  bar.values.forEach((v, i) => {
    if (i === 1) return;
    out.push(text(xs[i]!, y + 7, bar.label(v), 'mono', 5.2, { anchor: 'middle', color: GREY }));
  });
}

function northArrow(c: Ctx, cx: number, cy: number, trueNorth: number): void {
  const deg = -trueNorth / 1_000_000;
  const rad = (deg * Math.PI) / 180;
  const rot = (p: XY): XY => [cx + p[0] * Math.cos(rad) - p[1] * Math.sin(rad), cy + p[0] * Math.sin(rad) + p[1] * Math.cos(rad)];
  const { out } = c;
  out.push({ t: 'path', d: circle(cx, cy, 11), stroke: INK, width: 0.6 });
  const right: XY[] = [[0, -10], [5, 7], [0, 3.5]];
  const left: XY[] = [[0, -10], [-5, 7], [0, 3.5]];
  out.push({ t: 'path', d: ring(right.map(rot)), fill: INK });
  out.push({ t: 'path', d: ring(left.map(rot)), fill: WHITE, stroke: INK, width: 0.5 });
  const n = rot([0, -16]);
  out.push(text(n[0], n[1] + 2.5, 'N', 'sans-bold', 7, { anchor: 'middle' }));
}

// ── schedule ─────────────────────────────────────────────────────────────────

function drawSchedule(c: Ctx, at: { x: number; y: number; w: number }, rows: readonly ScheduleRow[], title: string): void {
  const { out, measure } = c;
  const cols = [
    { h: 'MARK', w: 30 },
    { h: 'TYPE', w: 94 },
    { h: 'W × H', w: 74 },
    { h: 'SILL', w: 38 },
    { h: 'NAME / ID', w: at.w - 236 },
  ];
  let y = at.y;
  out.push(text(at.x, y + 8, title.toUpperCase(), 'sans-bold', 7.5));
  y += 13;
  const top = y;
  out.push({ t: 'path', d: rect(at.x, y, at.w, ROW), fill: '#eeeeee' });
  let x = at.x;
  for (const col of cols) {
    out.push(text(x + 3, y + 7.4, col.h, 'sans-bold', 5.5));
    x += col.w;
  }
  y += ROW;
  const clip = (s: string, w: number, font: FontName, size: number): string => {
    if (measure(s, font, size) <= w - 6) return s;
    let t = s;
    while (t.length > 1 && measure(`${t}…`, font, size) > w - 6) t = t.slice(0, -1);
    return `${t}…`;
  };
  for (const r of rows) {
    const cells = [r.mark, r.type, r.size, r.sill, r.name];
    x = at.x;
    cells.forEach((v, i) => {
      const col = cols[i]!;
      const font: FontName = i === 0 ? 'sans-medium' : i === 2 || i === 3 ? 'mono' : 'sans';
      out.push(text(x + 3, y + 7.4, clip(v, col.w, font, 5.6), font, 5.6, { color: i === 0 ? INK : GREY }));
      x += col.w;
    });
    y += ROW;
  }
  // Grid.
  let d = '';
  for (let yy = top; yy <= y + 0.01; yy += ROW) d += line([at.x, yy], [at.x + at.w, yy]);
  x = at.x;
  for (const col of cols) {
    d += line([x, top], [x, y]);
    x += col.w;
  }
  d += line([at.x + at.w, top], [at.x + at.w, y]);
  out.push({ t: 'path', d, stroke: GREY, width: 0.3 });
  if (rows.length === 0) out.push(text(at.x + 3, y + 8, 'No doors or windows on this level.', 'sans', 5.6, { color: GREY }));
}

// ── border and title strip ───────────────────────────────────────────────────

function drawBorder(c: Ctx, layout: SetLayout): void {
  const { page, strip } = layout;
  const m = strip.y;
  c.out.push({ t: 'path', d: rect(m, m, page.width - 2 * m, page.height - 2 * m), stroke: INK, width: 1.2 });
  c.out.push({ t: 'path', d: line([strip.x, strip.y], [strip.x, strip.y + strip.h]), stroke: INK, width: 0.8 });
}

/** The disclaimer under the NOT FOR CONSTRUCTION mark. Floorspec never says a design meets a code (FLR-ADR-011). */
export const NOT_FOR_CONSTRUCTION = 'NOT FOR CONSTRUCTION';
export const NOT_A_PLAN_REVIEW = 'Not a plan review. Drawn from a Floorspec model; no building code has been checked. Verify every dimension before building.';

function drawStrip(c: Ctx, layout: SetLayout, axo: readonly AxoFace[], meta: SheetMeta, sheetTitle: string, rooms: readonly (readonly [string, string])[]): void {
  const { out, measure } = c;
  const s = layout.strip;
  const x = s.x + 10;
  const w = s.w - 20;
  let y = s.y + 14;

  // Project.
  out.push(text(x, y + 6, 'PROJECT', 'sans-medium', 5.5, { color: FAINT }));
  y += 10;
  for (const l of wrap(meta.projectName, w, 'sans-bold', 13, measure).slice(0, 3)) {
    y += 15;
    out.push(text(x, y, l, 'sans-bold', 13));
  }
  y += 10;
  out.push(text(x, y, 'Drawn by D3 Floorspec from the project model', 'sans', 6, { color: GREY }));
  y += 10;
  out.push({ t: 'path', d: line([s.x, y], [s.x + s.w, y]), stroke: INK, width: 0.5 });

  // NOT FOR CONSTRUCTION.
  y += 10;
  const boxTop = y;
  const note = wrap(NOT_A_PLAN_REVIEW, w - 16, 'sans', 6, measure);
  const size = Math.min(16, (13 * (w - 16)) / measure(NOT_FOR_CONSTRUCTION, 'sans-bold', 13));
  const boxH = 12 + size * 1.1 + 6 + note.length * 8 + 6;
  out.push({ t: 'path', d: rect(x, boxTop, w, boxH), stroke: RED, width: 1.8 });
  y = boxTop + 10 + size;
  out.push(text(x + w / 2, y, NOT_FOR_CONSTRUCTION, 'sans-bold', size, { anchor: 'middle', color: RED }));
  y += 6;
  for (const l of note) {
    y += 8;
    out.push(text(x + w / 2, y, l, 'sans', 6, { anchor: 'middle', color: RED }));
  }
  y = boxTop + boxH + 12;

  // 3D view.
  const factsH = 118;
  const legendH = 128;
  const bottom = s.y + s.h;
  const viewH = Math.max(90, Math.min(w * 0.95, bottom - factsH - legendH - y - 26));
  out.push(text(x, y, '3D VIEW', 'sans-medium', 5.5, { color: FAINT }));
  out.push(text(x + w, y, meta.viewCaption, 'sans', 5.5, { color: FAINT, anchor: 'end' }));
  y += 5;
  drawAxo(c, axo, { x, y, w, h: viewH });
  y += viewH + 4;
  out.push(text(x, y + 5, 'Isometric from the south-west, drawn from the model.', 'sans', 5.2, { color: GREY }));
  y += 14;
  out.push({ t: 'path', d: line([s.x, y], [s.x + s.w, y]), stroke: INK, width: 0.5 });

  // Legend.
  y += 10;
  out.push(text(x, y + 2, 'LEGEND', 'sans-medium', 5.5, { color: FAINT }));
  y += 6;
  y = legend(c, x, y);

  // Rooms on this level, with their net areas, where the strip has room for them.
  const roomsTop = y + 16;
  const roomsH = 14 + rooms.length * 9;
  if (rooms.length > 0 && roomsTop + roomsH <= bottom - factsH - 6) {
    out.push({ t: 'path', d: line([s.x, roomsTop - 6], [s.x + s.w, roomsTop - 6]), stroke: INK, width: 0.5 });
    out.push(text(x, roomsTop + 6, 'ROOMS (NET AREA)', 'sans-medium', 5.5, { color: FAINT }));
    let ry = roomsTop + 8;
    for (const [name, area] of rooms) {
      ry += 9;
      out.push(text(x, ry, wrap(name, w - 60, 'sans', 6.2, measure)[0] ?? name, 'sans', 6.2));
      out.push(text(x + w, ry, area, 'mono', 6, { anchor: 'end', color: GREY }));
    }
  }

  // Sheet facts, from the bottom up.
  const fy = bottom - factsH;
  out.push({ t: 'path', d: line([s.x, fy], [s.x + s.w, fy]), stroke: INK, width: 0.5 });
  const facts: [string, string][] = [
    ['SHEET', sheetTitle],
    ['SCALE', meta.sheetNumber.startsWith('A-6') ? 'None' : layout.scale.label],
    ['DATE', meta.date],
    ['VERSION', meta.version],
    ['UNITS', meta.units === 'metric' ? 'Millimetres; areas in m²' : 'Feet and inches to 1/16"; areas in SF'],
    ['PAPER', layout.page.label],
  ];
  let yy = fy + 12;
  for (const [label, value] of facts) {
    out.push(text(x, yy, label, 'sans-medium', 5.2, { color: FAINT }));
    out.push(text(x + 44, yy, wrap(value, w - 44, 'sans', 6.5, measure)[0] ?? '', 'sans', 6.5));
    yy += 11;
  }
  out.push({ t: 'path', d: line([s.x, bottom - 40], [s.x + s.w, bottom - 40]), stroke: INK, width: 0.5 });
  out.push(text(x, bottom - 26, 'SHEET', 'sans-medium', 5.2, { color: FAINT }));
  out.push(text(x, bottom - 12, `${String(meta.sheetIndex + 1)} of ${String(meta.sheetCount)}`, 'sans', 6.5, { color: GREY }));
  out.push(text(x + w, bottom - 11, meta.sheetNumber, 'sans-bold', 22, { anchor: 'end' }));
}

function legend(c: Ctx, x: number, y0: number): number {
  const { out } = c;
  const items: { label: string; draw: (cx: number, cy: number) => void }[] = [
    { label: 'Wall, cut', draw: (cx, cy) => out.push({ t: 'path', d: rect(cx, cy - 3, 22, 6), fill: POCHE, stroke: INK, width: 0.6 }) },
    {
      label: 'Door, leaf and swing',
      draw: (cx, cy) => {
        out.push({ t: 'path', d: line([cx + 2, cy + 4], [cx + 2, cy - 8]), stroke: INK, width: 0.7 });
        out.push({ t: 'path', d: `M${num(cx + 2)} ${num(cy - 8)}A12 12 0 0 1 ${num(cx + 14)} ${num(cy + 4)}`, stroke: INK, width: 0.3 });
      },
    },
    {
      label: 'Window',
      draw: (cx, cy) => {
        out.push({ t: 'path', d: line([cx, cy - 3], [cx + 22, cy - 3]) + line([cx, cy + 3], [cx + 22, cy + 3]), stroke: INK, width: 0.45 });
        out.push({ t: 'path', d: line([cx, cy - 1], [cx + 22, cy - 1]) + line([cx, cy + 1], [cx + 22, cy + 1]), stroke: INK, width: 0.3 });
      },
    },
    {
      label: 'Door and window marks (see schedule)',
      draw: (cx, cy) => {
        out.push({ t: 'path', d: circle(cx + 5, cy, 5), stroke: INK, width: 0.4 });
        out.push({ t: 'path', d: hexagon(cx + 17, cy, 5.4), stroke: INK, width: 0.4 });
      },
    },
    { label: 'Room separation line', draw: (cx, cy) => out.push({ t: 'path', d: line([cx, cy], [cx + 22, cy]), stroke: GREY, width: 0.4, dash: [4, 2.5] }) },
    {
      label: 'Slab',
      draw: (cx, cy) => {
        const d = rect(cx, cy - 4, 22, 8);
        out.push({ t: 'clip', d, children: [{ t: 'path', d: hatch([[cx, cy - 4], [cx + 22, cy + 4]], 4), stroke: HAIR, width: 0.35 }] });
        out.push({ t: 'path', d, stroke: FAINT, width: 0.5 });
      },
    },
    { label: 'Fixture or device (extension)', draw: (cx, cy) => out.push({ t: 'path', d: rect(cx + 6, cy - 4, 10, 8), fill: '#ececec', stroke: GREY, width: 0.35 }) },
    {
      label: 'Dimension string',
      draw: (cx, cy) => {
        out.push({ t: 'path', d: line([cx, cy], [cx + 22, cy]), stroke: INK, width: 0.3 });
        out.push({ t: 'path', d: line([cx - 2, cy + 2], [cx + 2, cy - 2]) + line([cx + 20, cy + 2], [cx + 24, cy - 2]), stroke: INK, width: 0.9 });
      },
    },
  ];
  let y = y0;
  for (const it of items) {
    y += 14;
    it.draw(x + 2, y - 2);
    out.push(text(x + 32, y, it.label, 'sans', 6.2, { color: INK }));
  }
  return y;

}

function drawAxo(c: Ctx, faces: readonly AxoFace[], box: { x: number; y: number; w: number; h: number }): void {
  const { out } = c;
  out.push({ t: 'path', d: rect(box.x, box.y, box.w, box.h), fill: '#fafafa', stroke: HAIR, width: 0.4 });
  let b: Box | undefined;
  for (const f of faces)
    for (const r of f.rings)
      for (const [px, py] of r) {
        if (!b) b = { minX: px, minY: py, maxX: px, maxY: py };
        else {
          b.minX = Math.min(b.minX, px);
          b.minY = Math.min(b.minY, py);
          b.maxX = Math.max(b.maxX, px);
          b.maxY = Math.max(b.maxY, py);
        }
      }
  if (b === undefined) {
    out.push(text(box.x + box.w / 2, box.y + box.h / 2, 'Nothing to draw on this level yet', 'sans', 6, { anchor: 'middle', color: FAINT }));
    return;
  }
  const pad = 8;
  const s = Math.min((box.w - 2 * pad) / Math.max(1, b.maxX - b.minX), (box.h - 2 * pad) / Math.max(1, b.maxY - b.minY));
  const ox = box.x + (box.w - (b.maxX - b.minX) * s) / 2;
  const oy = box.y + (box.h - (b.maxY - b.minY) * s) / 2;
  const T = (p: XY): XY => [ox + (p[0] - b.minX) * s, oy + (b.maxY - p[1]) * s];
  const children: Prim[] = [];
  for (const f of faces) {
    const rings = f.rings.map((r) => r.map(T));
    if (rings[0]!.length === 2) {
      children.push({ t: 'path', d: line(rings[0]![0]!, rings[0]![1]!), stroke: INK, width: 0.35, cap: 'round' });
      continue;
    }
    const d = rings.map(ring).join('');
    children.push({ t: 'path', d, fill: grey(f.shade), ...(f.stroke ? { stroke: INK, width: 0.3 } : {}), evenOdd: rings.length > 1, join: 'round' });
  }
  out.push({ t: 'clip', d: rect(box.x, box.y, box.w, box.h), children });
}
