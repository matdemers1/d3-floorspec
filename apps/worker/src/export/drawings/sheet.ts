/**
 * Drawing sheets (FLR-T-9.3), composed as a display list in paper points (y down) that the PDF
 * writer (and, for previews, the SVG writer) draws without deciding anything. Composing is pure:
 * the same document, options and font metrics give the same list, and so the same PDF bytes.
 *
 * A sheet is one level's floor plan at a true architectural scale with its dimension strings, room
 * labels and door and window marks; a title strip down the right edge with the project, a
 * NOT FOR CONSTRUCTION block, the 3D view, the legend and the sheet's facts (scale, date, version,
 * and the design drawn when the model has design options); and, where it fits beside or under the
 * plan, the level's door and window schedule. Stairs are drawn on their plans, roofs dashed on
 * theirs, and a roof plan sheet draws every roof from above (FLR-T-9.7).
 *
 * The 3D view is a picture of the mesh (render3d over @floorspec/mesh), asked for at the panel's
 * size once the strip is laid out, and embedded as a PNG at 300 dpi.
 */
import { DEMOLISH_INK, type Demolished } from './renovation.js';
import type { RenovationFilter } from '@floorspec/render2d';
import { layoutAnnotations, num, PDF_METRICS, SIDES, type AnnoPrim, type DimString, type Note, type Side, type SymbolPart, type SymbolStroke, type Tag } from '@floorspec/render2d';
import { customStrings, NO_NOTES, roomDimensionStrings, type PlanNotes } from './dimensions.js';
import type { Box, LevelPlan, Segment, XY } from './plan.js';
import { pitchText, type PlanRoof, type PlanStair } from './symbols.js';
import { areaText, BU_PER_INCH, IMPERIAL_SCALES, lengthText, METRIC_SCALES, type DrawingScale, type UnitSystem } from './units.js';
import { BLUEPRINT, deviceLook, floorLook, patternJoints, sheetTheme, type PlanStyle } from './styles.js';

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

/** A raster image (the 3D view): PNG bytes drawn into a box on the page. */
export interface ImagePrim {
  readonly t: 'image';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly png: Uint8Array;
}

export type Prim = PathPrim | TextPrim | ClipPrim | ImagePrim;

/**
 * The 3D view, asked for at the panel's size in points once the strip is laid out: a PNG of that
 * shape, or null when there is nothing to draw.
 */
export type View3d = (widthPt: number, heightPt: number) => { readonly png: Uint8Array } | null;

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
/**
 * A winder's tint: render2d's (the editor's) winder colour, the light theme's accent #5432be at
 * 0.18 opacity, flattened onto the white sheet — a PDF path here has no opacity.
 */
const WINDER_TINT = '#e0daf3';
/** Where the floor above a stair must be open from: render2d's light-theme opening colour (warning). */
const OPENING = '#714e00';
/** The opening mark's dash-dot: render2d's 8 2 2 2 at the sheet's scale. */
const OPENING_DASH = [4, 1, 1, 1] as const;
const PAPER_FILL = '#ffffff';

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

/**
 * How far each side's exterior strings reach beyond the drawing at a scale (`k`, points per base
 * unit) — the annotation layout run at that scale, so a string whose lengths take a second row is
 * given the room for it.
 */
export type DepthAt = (k: number) => Readonly<Record<Side, number>>;

/** The depths of every level's exterior strings, each side the deepest of them. */
export function depthsOf(strings: readonly (readonly DimString[])[], measure: Measure, units: UnitSystem): DepthAt {
  const format = (v: number): string => lengthText(v, units);
  return (k) => {
    const out: Record<Side, number> = { N: 0, S: 0, E: 0, W: 0 };
    for (const list of strings) {
      if (list.length === 0) continue;
      const { depth } = layoutAnnotations({ strings: list }, { P: (p) => [p[0] * k, -p[1] * k], k }, PDF_METRICS, annoMeasure(measure), format);
      for (const side of SIDES) out[side] = Math.max(out[side], depth[side]);
    }
    return out;
  };
}

/** The sheet's measure, as the annotation layout asks for it. */
export const annoMeasure = (measure: Measure) => (text: string, font: 'mono' | 'sans' | 'sans-medium', size: number): number => measure(text, font, size);

/**
 * Choose one scale and one placement for the whole set: the largest architectural scale at which
 * every level, its dimension strings and its view title fit the drawing area (capped at 1/4" or
 * 1:50 — a house plan at a larger scale is a detail, not a plan).
 */
export function layoutSet(page: PageSpec, frame: Box, depthAt: DepthAt, units: UnitSystem, scheduleRows: number): SetLayout {
  const m = page.width >= 1700 ? 36 : 24;
  const stripW = Math.round(Math.min(260, Math.max(176, page.width * 0.19)));
  const strip = { x: page.width - m - stripW, y: m, w: stripW, h: page.height - 2 * m };
  const pad = 14;
  const area = { x: m + pad, y: m + pad, w: strip.x - m - 2 * pad, h: page.height - 2 * m - 2 * pad };
  const marginsAt = (k: number): Record<Side, number> => {
    const d = depthAt(k);
    return { N: Math.max(10, d.N + 6), S: Math.max(10, d.S + 6), E: Math.max(10, d.E + 6), W: Math.max(10, d.W + 6) };
  };
  const fw = frame.maxX - frame.minX;
  const fh = frame.maxY - frame.minY;
  const scales = units === 'metric' ? METRIC_SCALES : IMPERIAL_SCALES;
  const kOf = (s: DrawingScale): number => (units === 'metric' ? 72 / (25.4 * 1280 * s.ratio) : 72 / (BU_PER_INCH * s.ratio));
  const blockOf = (k: number): { w: number; h: number } => {
    const mg = marginsAt(k);
    return { w: fw * k + mg.W + mg.E, h: fh * k + mg.N + mg.S + VIEW_TITLE };
  };
  const scale = scales.find((s) => {
    const b = blockOf(kOf(s));
    return b.w <= area.w && b.h <= area.h;
  }) ?? scales[scales.length - 1]!;
  const k = kOf(scale);
  const margins = marginsAt(k);
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
  /** The design drawn, in words, when the model has design options (Core 19). */
  readonly design?: string;
  /** A trade's view (FLR-T-18.3): what the drawing is called — `Electrical plan`. */
  readonly planName?: string;
  /** The plan's style (FLR-T-18.5): Colour, Presentation, Technical or Blueprint. Default: the construction drawing. */
  readonly style?: PlanStyle;
  /** The area summary (FLR-T-18.11): the level's gross, net and finished, then the whole house's. */
  readonly areas?: readonly (readonly [string, string])[];
  /** A remodel's renovation plan (FLR-T-18.13): its legend says what is existing, demolished and new. */
  readonly renovation?: RenovationFilter;
}

interface Ctx {
  readonly out: Prim[];
  readonly measure: Measure;
  readonly k: number;
  readonly P: (p: XY) => XY;
}

/**
 * `Main floor` → `Main floor plan`; `Level 2` → `Level 2 floor plan`. In a trade's view (FLR-T-18.3)
 * the drawing's own name: `Main floor electrical plan`.
 */
export function planTitle(levelName: string, planName?: string): string {
  if (planName !== undefined) return `${levelName.trim()} ${planName.toLowerCase()}`;
  return /\bfloor$/i.test(levelName.trim()) ? `${levelName.trim()} plan` : `${levelName.trim()} floor plan`;
}

export function composePlanSheet(
  layout: SetLayout,
  plan: LevelPlan,
  dims: readonly DimString[],
  view: View3d,
  rows: readonly ScheduleRow[],
  meta: SheetMeta,
  measure: Measure,
  ghost: LevelPlan | null = null,
  demolished: Demolished | null = null,
  notes: PlanNotes = NO_NOTES,
  roomDimensions = true,
): Sheet {
  const { page, k, frame, origin } = layout;
  const P = (p: XY): XY => [origin[0] + (p[0] - frame.minX) * k, origin[1] + (frame.maxY - p[1]) * k];
  const out: Prim[] = [];
  const c: Ctx = { out, measure, k, P };
  const title = planTitle(meta.levelName, meta.planName);

  out.push({ t: 'path', d: rect(0, 0, page.width, page.height), fill: PAPER_FILL });
  // Blueprint (FLR-T-18.5): the plan's area in blueprint blue.
  if (meta.style === 'blueprint') out.push({ t: 'path', d: rect(layout.area.x, layout.area.y, layout.area.w, layout.area.h), fill: BLUEPRINT.paper });
  // A trade's view (FLR-T-18.3): the other trades' layers under it, screened — grey, as context.
  if (ghost !== null) {
    const under: Prim[] = [];
    const g: Ctx = { ...c, out: under };
    drawPlan(g, ghost);
    drawStairs(g, ghost.stairs);
    drawOverheadRoofs(g, ghost.roofs);
    drawRoomLabels(g, roomLabels(g, ghost, meta.units, true));
    drawAnnotation(g, { strings: [], tags: ghost.tags }, meta.units);
    out.push(...under.map(screened));
  }
  const drawn = out.length;
  drawPlan(c, plan, meta.style);
  if (demolished !== null) drawDemolished(c, demolished);
  drawStairs(c, plan.stairs);
  drawOverheadRoofs(c, plan.roofs);
  // Room strings only where the plan is dimensioned: beside the labels, which then leave out their size.
  const roomDims = roomDimensions && dims.length > 0;
  const labels = roomLabels(c, plan, meta.units, !roomDims);
  const inside = roomDims ? roomDimensionStrings(plan, k, (r) => labels.get(r.id) ?? { halfW: 0, halfH: 0 }, PDF_METRICS.text + 4) : [];
  drawAnnotation(c, { strings: [...dims, ...inside, ...customStrings(notes)], tags: plan.tags, notes: notes.notes }, meta.units);
  drawRoomLabels(c, labels);
  drawViewTitle(c, layout, title, plan.trueNorth, meta);
  if (meta.style === 'blueprint') out.splice(drawn, out.length - drawn, ...out.slice(drawn).map(blueprinted));
  if (layout.schedule !== null && layout.schedule !== 'sheet') drawSchedule(c, layout.schedule, rows, `${meta.levelName} — door and window schedule`);
  drawBorder(c, layout);
  const extra: LegendItem[] = [];
  if (plan.stairs.length > 0) extra.push(...stairLegend(c, plan.stairs));
  if (meta.renovation !== undefined && meta.renovation !== 'existing') extra.push(...renovationLegend(c, meta.renovation));
  if (plan.roofs.length > 0) extra.push({ label: 'Roof eave above (see roof plan)', draw: (cx, cy) => out.push({ t: 'path', d: line([cx, cy], [cx + 22, cy]), stroke: GREY, width: 0.5, dash: [5, 2.5] }) });
  const rooms = plan.rooms.length > 0 || ghost === null ? plan.rooms : ghost.rooms;
  drawStrip(c, layout, view, meta, title, rooms.map((r) => [r.title, areaText(r.area, meta.units)]), [...planLegend(c), ...extra]);
  return { number: meta.sheetNumber, title, width: page.width, height: page.height, prims: out };
}

export const ROOF_PLAN_TITLE = 'Roof plan';

/**
 * The roof plan (FLR-T-9.7): every roof of the drawn levels from above, at the set's scale and
 * placed by the set's frame, so it lies over the floor plans sheet to sheet — eave and gable ends,
 * ridges, hips, breaks and valleys, a slope arrow with its pitch on every pitched face, and the exterior
 * walls of the levels the roofs bear on, dashed below.
 */
export function composeRoofSheet(layout: SetLayout, roofs: readonly PlanRoof[], wallsBelow: readonly Segment[], trueNorth: number, view: View3d, meta: SheetMeta, measure: Measure): Sheet {
  const { page, k, frame, origin } = layout;
  const P = (p: XY): XY => [origin[0] + (p[0] - frame.minX) * k, origin[1] + (frame.maxY - p[1]) * k];
  const out: Prim[] = [{ t: 'path', d: rect(0, 0, page.width, page.height), fill: PAPER_FILL }];
  const c: Ctx = { out, measure, k, P };
  for (const rf of roofs) drawRoof(c, rf, meta.units);
  // The walls the roofs bear on, under them: dashed over the roof surface.
  if (wallsBelow.length > 0) out.push({ t: 'path', d: wallsBelow.map((s) => line(P(s.a), P(s.b))).join(''), stroke: FAINT, width: 0.45, dash: [3, 2] });
  drawViewTitle(c, layout, ROOF_PLAN_TITLE, trueNorth, meta);
  drawBorder(c, layout);
  drawStrip(c, layout, view, meta, ROOF_PLAN_TITLE, [], roofLegend(c));
  return { number: meta.sheetNumber, title: ROOF_PLAN_TITLE, width: page.width, height: page.height, prims: out };
}

/** The schedule sheet a set ends with when a level's schedule fits beside none of its plans. */
export function composeScheduleSheet(layout: SetLayout, groups: readonly { title: string; rows: readonly ScheduleRow[] }[], view: View3d, meta: SheetMeta, measure: Measure): Sheet {
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
  drawStrip(c, layout, view, meta, 'Door and window schedule', [], planLegend(c));
  return { number: meta.sheetNumber, title: 'Door and window schedule', width: page.width, height: page.height, prims: out };
}

// ── the plan ─────────────────────────────────────────────────────────────────

/** A screened line's grey, and a screened fill's (FLR-T-18.3): what a ghosted layer is drawn in. */
const SCREEN_INK = '#a3a3a3';
const SCREEN_FILL = '#efefef';

/** A primitive screened: every ink grey, every fill but the paper's pale. */
function screened(p: Prim): Prim {
  switch (p.t) {
    case 'path':
      return {
        ...p,
        ...(p.stroke === undefined || p.stroke === WHITE ? {} : { stroke: SCREEN_INK }),
        ...(p.fill === undefined || p.fill === WHITE || p.fill === PAPER_FILL ? {} : { fill: SCREEN_FILL }),
      };
    case 'text':
      return { ...p, color: SCREEN_INK };
    case 'clip':
      return { ...p, children: p.children.map(screened) };
    case 'image':
      return p;
  }
}

/** A prim of the plan in Blueprint (FLR-T-18.5): its inks to white and pale blues, its paper and light fills to the blue. */
function blueprinted(p: Prim): Prim {
  const ink = (c: string): string => (c === INK || c === POCHE ? BLUEPRINT.ink : c === GREY ? BLUEPRINT.grey : c === FAINT || c === HAIR ? BLUEPRINT.faint : c === WHITE || c === PAPER_FILL ? BLUEPRINT.paper : c);
  const fill = (c: string): string => (c === WHITE || c === PAPER_FILL ? BLUEPRINT.paper : c === POCHE || c === INK ? BLUEPRINT.ink : c.startsWith('#e') || c.startsWith('#f') ? BLUEPRINT.fill : c);
  switch (p.t) {
    case 'path':
      return { ...p, ...(p.stroke === undefined ? {} : { stroke: ink(p.stroke) }), ...(p.fill === undefined ? {} : { fill: fill(p.fill) }) };
    case 'text':
      return { ...p, color: ink(p.color) };
    case 'clip':
      return { ...p, children: p.children.map(blueprinted) };
    case 'image':
      return p;
  }
}

/** Joints closer than this on the sheet, in points, are not drawn: the floor is its colour. */
const FINEST_JOINT = 1.5;

function drawPlan(c: Ctx, plan: LevelPlan, style?: PlanStyle): void {
  const { out, P } = c;
  const t = style === undefined ? null : sheetTheme(style);
  const colour = t !== null && t.colour;
  // A colour plan's floors (FLR-T-18.5): each room its finish's colour, its pattern's joints clipped to it.
  const floor = (outer: readonly XY[], holes: readonly (readonly XY[])[], source: Parameters<typeof floorLook>[0]): void => {
    if (t === null) return;
    const look = floorLook(source, t);
    const d = [outer, ...holes].map((r) => ring(r.map(P))).join('');
    out.push({ t: 'path', d, fill: look.fill, evenOdd: true });
    const joints = patternJoints(look.pattern, look.rotation, outer, FINEST_JOINT / c.k);
    if (joints.length > 0) out.push({ t: 'clip', d, children: [{ t: 'path', d: joints.map(([a, b]) => line(P(a), P(b))).join(''), stroke: look.joint, width: 0.2 }] });
  };
  if (colour) for (const r of plan.rooms) floor(r.outer, r.holes, plan.scene.rooms.get(r.id)?.floor);
  // Slabs: outlined, hatched — in a colour plan, in their material.
  for (const s of plan.slabs) {
    if (colour) {
      floor(s.outline, [], plan.scene.slabs.get(s.id)?.material);
      out.push({ t: 'path', d: ring(s.outline.map(P)), stroke: FAINT, width: 0.4 });
      continue;
    }
    const d = ring(s.outline.map(P));
    out.push({ t: 'path', d, fill: '#f2f2f2' });
    out.push({ t: 'clip', d, children: [{ t: 'path', d: hatch(s.outline.map(P), 5), stroke: HAIR, width: 0.35 }] });
    out.push({ t: 'path', d, stroke: FAINT, width: 0.5 });
  }
  // Unanchored faces: a light tone, so a face no room claims is visible.
  for (const u of plan.unanchored) out.push({ t: 'path', d: [u.outer, ...u.holes].map((r) => ring(r.map(P))).join(''), fill: '#f4f4f4', evenOdd: true });
  // Room separators: dashed.
  for (const [a, b] of plan.separators) out.push({ t: 'path', d: line(P(a), P(b)), stroke: GREY, width: 0.4, dash: [4, 2.5] });
  // Extension elements: furniture and fixtures as their outlines (FLR-T-12.24), anything else as its fallback box, light.
  for (const dv of plan.devices) {
    // A colour plan's furniture in its colours (FLR-T-18.5).
    const tone = colour ? deviceLook(plan, dv.id, t) : null;
    if (dv.symbol === null) out.push({ t: 'path', d: ring(dv.footprint.map(P)), fill: tone?.fill ?? '#ececec', stroke: tone?.ink ?? GREY, width: 0.35 });
    else {
      out.push({ t: 'path', d: ring(dv.footprint.map(P)), fill: tone?.fill ?? WHITE });
      drawParts(c, dv.symbol, tone?.ink);
    }
  }
  // Walls: the poché, then the openings cut out of it, then the outline as drawn. A colour plan's
  // poché is its style's; Technical and Blueprint hatch the exterior walls over the paper.
  const hatched = t !== null && t.linework ? plan.pieces.filter((p) => p.exterior) : [];
  const solid = hatched.length > 0 ? plan.pieces.filter((p) => !p.exterior) : plan.pieces;
  const poche = colour ? t.wallInterior : POCHE;
  if (solid.length > 0) out.push({ t: 'path', d: solid.map((p) => ring(p.ring.map(P))).join(''), fill: poche, stroke: poche, width: 0.2, join: 'round' });
  if (hatched.length > 0) {
    const d = hatched.map((p) => ring(p.ring.map(P))).join('');
    out.push({ t: 'path', d, fill: WHITE, stroke: WHITE, width: 0.2, join: 'round' });
    for (const p of hatched) {
      const pts = p.ring.map(P);
      out.push({ t: 'clip', d: ring(pts), children: [{ t: 'path', d: hatch(pts, 1.6), stroke: INK, width: 0.25 }] });
    }
  }
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
  // Doors, by how they operate (FLR-T-12.24): a swing's leaf open at 90° and its arc, a pair's two
  // leaves, a pocket's leaf in the wall, sliding and folding leaves, an overhead door dashed.
  for (const dr of plan.doors) drawParts(c, dr.parts);
}

/** FLR-T-18.13: what is to be demolished, over the plan — dashed in red, with no poché. */
function drawDemolished(c: Ctx, d: Demolished): void {
  const { out, P } = c;
  const dashed = { stroke: DEMOLISH_INK, dash: [3, 1.8] as readonly number[] };
  for (const s of d.slabs) out.push({ t: 'path', d: ring(s.outline.map(P)), ...dashed, width: 0.4 });
  if (d.rings.length > 0) {
    const body = d.rings.map((r) => ring(r.map(P))).join('');
    out.push({ t: 'path', d: body, fill: WHITE });
    out.push({ t: 'path', d: body, ...dashed, width: 0.6, join: 'round' });
  }
  for (const w of d.windows) out.push({ t: 'path', d: w.lines.map((l) => line(P(l[0]), P(l[1]))).join(''), ...dashed, width: 0.35 });
  for (const dr of d.doors) drawParts(c, dr.parts, DEMOLISH_INK, dashed.dash);
  for (const dv of d.devices) {
    if (dv.symbol === null) out.push({ t: 'path', d: ring(dv.footprint.map(P)), ...dashed, width: 0.35 });
    else drawParts(c, dv.symbol, DEMOLISH_INK, dashed.dash);
  }
}

/** FLR-T-18.13: the renovation plan's legend rows. */
function renovationLegend(c: Ctx, filter: RenovationFilter): LegendItem[] {
  const { out } = c;
  const items: LegendItem[] = [{ label: 'Existing to remain', draw: (cx, cy) => out.push({ t: 'path', d: rect(cx, cy - 3, 22, 6), fill: '#efefef', stroke: '#a3a3a3', width: 0.6 }) }];
  if (filter !== 'proposed') items.push({ label: 'To be demolished', draw: (cx, cy) => out.push({ t: 'path', d: rect(cx, cy - 3, 22, 6), stroke: DEMOLISH_INK, width: 0.6, dash: [3, 1.8] }) });
  if (filter !== 'demolition') items.push({ label: 'New construction', draw: (cx, cy) => out.push({ t: 'path', d: rect(cx, cy - 3, 22, 6), fill: POCHE, stroke: INK, width: 0.6 }) });
  return items;
}

/** How each kind of symbol line is drawn on a sheet. */
const SHEET_STROKES: Readonly<Record<SymbolStroke, { readonly color: string; readonly width: number; readonly dash?: readonly number[] }>> = {
  leaf: { color: INK, width: 0.7 },
  swing: { color: INK, width: 0.3 },
  hidden: { color: INK, width: 0.45, dash: [3, 1.5] },
  inWall: { color: WHITE, width: 0.35, dash: [1.5, 1] },
  outline: { color: INK, width: 0.4 },
  detail: { color: GREY, width: 0.25 },
};

/** Symbol parts (render2d's door and fixture symbols) on the sheet. */
function drawParts(c: Ctx, parts: readonly SymbolPart[], tone?: string, dash?: readonly number[]): void {
  const { out, P } = c;
  for (const part of parts) {
    const look = SHEET_STROKES[part.stroke];
    const d = dash ?? look.dash;
    const style = { stroke: tone !== undefined && look.color !== WHITE ? tone : look.color, width: look.width, ...(d === undefined ? {} : { dash: d }) };
    if (part.kind === 'arc') {
      const h = P(part.centre);
      const l = P(part.from);
      const o = P(part.to);
      const r = part.radius * c.k;
      const sweep = (l[0] - h[0]) * (o[1] - h[1]) - (l[1] - h[1]) * (o[0] - h[0]) > 0 ? 1 : 0;
      out.push({ t: 'path', d: `${M(l)}A${num(r)} ${num(r)} 0 0 ${sweep} ${num(o[0])} ${num(o[1])}`, ...style });
      continue;
    }
    const pts = part.pts.map(P);
    if (pts.length < 2) continue;
    out.push({ t: 'path', d: part.closed ? ring(pts) : `${M(pts[0]!)}${pts.slice(1).map(L).join('')}`, ...style, ...(part.stroke === 'leaf' ? { cap: 'butt' as const } : {}) });
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

// ── stairs and roofs (FLR-T-9.7) ─────────────────────────────────────────────

/** A filled arrowhead at `tip`, pointing from `from` (paper points). */
function arrowHead(from: XY, tip: XY, size: number): string {
  const dx = tip[0] - from[0];
  const dy = tip[1] - from[1];
  const l = Math.hypot(dx, dy) || 1;
  const u: XY = [dx / l, dy / l];
  const n: XY = [-u[1], u[0]];
  const base: XY = [tip[0] - u[0] * size, tip[1] - u[1] * size];
  return ring([tip, [base[0] + n[0] * size * 0.38, base[1] + n[1] * size * 0.38], [base[0] - n[0] * size * 0.38, base[1] - n[1] * size * 0.38]]);
}

function drawStairs(c: Ctx, stairs: readonly PlanStair[]): void {
  const { out, P } = c;
  for (const st of stairs) {
    const solid = st.steps.filter((s) => !s.hidden);
    const hidden = st.steps.filter((s) => s.hidden);
    // Landings get a light tone, so the turn reads; winders a tint, as the editor draws them.
    for (const s of solid) if (s.landing) out.push({ t: 'path', d: ring(s.outline.map(P)), fill: '#f4f4f4' });
    const winders = st.steps.filter((s) => s.winder);
    if (winders.length > 0) out.push({ t: 'path', d: winders.map((s) => ring(s.outline.map(P))).join(''), fill: WINDER_TINT });
    if (solid.length > 0) out.push({ t: 'path', d: solid.map((s) => ring(s.outline.map(P))).join(''), stroke: INK, width: 0.35, join: 'round' });
    if (hidden.length > 0) out.push({ t: 'path', d: hidden.map((s) => ring(s.outline.map(P))).join(''), stroke: GREY, width: 0.3, dash: [2, 1.6] });
    if (st.bounds) out.push({ t: 'path', d: ring(st.bounds.map(P)), stroke: INK, width: 0.35, dash: [5, 2.5] });
    if (st.circle) {
      const cc = P(st.circle.centre);
      out.push({ t: 'path', d: circle(cc[0], cc[1], st.circle.radius * c.k), stroke: INK, width: 0.35 });
    }
    // A spiral's column and a winder's newel: solid.
    if (st.column) {
      const cc = P(st.column.centre);
      out.push({ t: 'path', d: circle(cc[0], cc[1], st.column.radius * c.k), fill: INK, stroke: INK, width: 0.35 });
    }
    if (st.newel) out.push({ t: 'path', d: ring(st.newel.map(P)), fill: INK, stroke: INK, width: 0.35, join: 'miter' });
    // Where the floor above must be open from (Core 0.4, 17.6): dash-dot, across the stair.
    if (st.opening) out.push({ t: 'path', d: line(P(st.opening[0]), P(st.opening[1])), stroke: OPENING, width: 0.9, dash: OPENING_DASH, cap: 'butt' });
    if (st.cut) out.push({ t: 'path', d: st.cut.map((p, i) => (i === 0 ? M(P(p)) : L(P(p)))).join(''), stroke: INK, width: 0.7, join: 'miter' });
    // The arrow: a dot at its tail, the shaft along the walkline, a head at the end.
    const pts = st.arrow.map(P);
    if (pts.length >= 2) {
      out.push({ t: 'path', d: pts.map((p, i) => (i === 0 ? M(p) : L(p))).join(''), stroke: INK, width: 0.45, join: 'round' });
      out.push({ t: 'path', d: arrowHead(pts[pts.length - 2]!, pts[pts.length - 1]!, 4.5), fill: INK });
      out.push({ t: 'path', d: circle(pts[0]![0], pts[0]![1], 1.2), fill: INK });
      // The label beside the tail, on the side away from the first leg.
      const [a, b] = [pts[0]!, pts[1]!];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const u: XY = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
      const at: XY = [a[0] - u[0] * 8, a[1] - u[1] * 8];
      out.push(text(at[0], at[1] + 2, st.label, 'sans-bold', 5.5, { anchor: 'middle' }));
    }
  }
}

/** A roof on its own level's plan: the eave outline, dashed — it is above the cut. */
function drawOverheadRoofs(c: Ctx, roofs: readonly PlanRoof[]): void {
  if (roofs.length === 0) return;
  c.out.push({ t: 'path', d: roofs.map((r) => ring(r.eave.map(c.P))).join(''), stroke: GREY, width: 0.5, dash: [5, 2.5] });
}

/** A roof from above, on the roof plan. */
function drawRoof(c: Ctx, rf: PlanRoof, units: UnitSystem): void {
  const { out, P } = c;
  out.push({ t: 'path', d: ring(rf.eave.map(P)), fill: '#f7f7f7', stroke: INK, width: 0.9, join: 'miter' });
  const ridges = rf.lines.filter((l) => l.kind === 'ridge');
  // A break (Core 0.4), where the roof over one side changes pitch, is drawn as a hip is.
  const hips = rf.lines.filter((l) => l.kind === 'hip' || l.kind === 'break');
  const valleys = rf.lines.filter((l) => l.kind === 'valley');
  if (ridges.length > 0) out.push({ t: 'path', d: ridges.map((l) => line(P(l.from), P(l.to))).join(''), stroke: INK, width: 0.8, cap: 'round' });
  if (hips.length > 0) out.push({ t: 'path', d: hips.map((l) => line(P(l.from), P(l.to))).join(''), stroke: INK, width: 0.5, cap: 'round' });
  if (valleys.length > 0) out.push({ t: 'path', d: valleys.map((l) => line(P(l.from), P(l.to))).join(''), stroke: INK, width: 0.5, dash: [4, 1.5, 1, 1.5] });
  if (rf.gables.length > 0) out.push({ t: 'path', d: rf.gables.map(([a, b]) => line(P(a), P(b))).join(''), stroke: INK, width: 1.8, cap: 'butt' });
  // Slope arrows: downhill, with the face's pitch above the shaft.
  const L2 = 15;
  for (const s of rf.slopes) {
    const m = P(s.at);
    const d: XY = [s.dir[0], -s.dir[1]]; // model → paper: y flips
    const tail: XY = [m[0] - d[0] * L2, m[1] - d[1] * L2];
    const tip: XY = [m[0] + d[0] * L2, m[1] + d[1] * L2];
    out.push({ t: 'path', d: line(tail, tip), stroke: INK, width: 0.45 });
    out.push({ t: 'path', d: arrowHead(tail, tip, 4.5), fill: INK });
    const label = pitchText(s.rise, s.run, units);
    // Beside the shaft's tail, on the side that reads upright.
    const n: XY = d[1] > 0.7 || d[1] < -0.7 ? [1, 0] : [0, -1];
    out.push(text(tail[0] + n[0] * 5, tail[1] + n[1] * 4 + (n[0] !== 0 ? 2 : 0), label, 'mono-medium', 6, { anchor: n[0] !== 0 ? 'start' : 'middle' }));
  }
  if (!rf.derived) {
    const b = rf.eave.map(P);
    const cx = b.reduce((v, p) => v + p[0], 0) / b.length;
    const cy = b.reduce((v, p) => v + p[1], 0) / b.length;
    out.push(text(cx, cy, 'ROOF SURFACE NOT DERIVED — EAVE ONLY', 'sans', 5.5, { anchor: 'middle', color: GREY }));
  }
}

// ── dimensions, tags and notes (FLR-T-18.11: render2d's one layout) ─────────

const INK_OF: Readonly<Record<string, { stroke: string; width: number }>> = {
  dim: { stroke: INK, width: 0.3 },
  ext: { stroke: GREY, width: 0.25 },
  tick: { stroke: INK, width: 0.9 },
  leader: { stroke: INK, width: 0.3 },
};

function drawAnnotation(c: Ctx, input: { strings: readonly DimString[]; tags: readonly Tag[]; notes?: readonly Note[] }, units: UnitSystem): void {
  const { out, P, k, measure } = c;
  const { prims } = layoutAnnotations(input, { P, k }, PDF_METRICS, annoMeasure(measure), (v) => lengthText(v, units));
  const lines = new Map<string, string[]>();
  const later: Prim[] = [];
  const draw = (p: AnnoPrim): void => {
    switch (p.t) {
      case 'line': {
        const key = p.role;
        lines.set(key, [...(lines.get(key) ?? []), line(p.a, p.b)]);
        return;
      }
      case 'arrow':
        later.push({ t: 'path', d: ring(p.pts), fill: INK });
        return;
      case 'tag':
        later.push({ t: 'path', d: p.kind === 'door' ? circle(p.cx, p.cy, p.r) : hexagon(p.cx, p.cy, p.r), fill: WHITE, stroke: INK, width: 0.4 });
        return;
      case 'text':
        later.push(text(p.x, p.y, p.text, p.font === 'mono' ? 'mono' : p.font, p.size, { anchor: p.anchor, color: INK, ...(p.rotate === 0 ? {} : { rotate: p.rotate }) }));
        return;
    }
  };
  for (const p of prims) draw(p);
  for (const role of ['ext', 'dim', 'tick', 'leader']) {
    const d = lines.get(role);
    if (d !== undefined) out.push({ t: 'path', d: d.join(''), stroke: INK_OF[role]!.stroke, width: INK_OF[role]!.width });
  }
  out.push(...later);
}

// ── room labels ──────────────────────────────────────────────────────────────

interface RoomLabel {
  readonly x: number;
  readonly y: number;
  readonly lines: readonly { s: string; font: FontName; size: number }[];
  readonly halfW: number;
  readonly halfH: number;
}

/**
 * Each room's label as it fits the room: its name, net area and — when the room is not
 * dimensioned by strings — its size; the least important line dropped until it fits, the name
 * shrunk last.
 */
function roomLabels(c: Ctx, plan: LevelPlan, units: UnitSystem, withSize: boolean): Map<string, RoomLabel> {
  const { P, measure, k } = c;
  const labels = new Map<string, RoomLabel>();
  for (const r of plan.rooms) {
    const [x, y] = P(r.label);
    const span = freeSpan(r.label, [r.outer, ...r.holes]);
    const roomW = span.h * k - 8;
    const roomH = span.v * k - 6;
    const lines: { s: string; font: FontName; size: number }[] = [
      { s: r.title.toUpperCase(), font: 'sans-bold', size: 7 },
      { s: areaText(r.area, units), font: 'mono', size: 6 },
      ...(withSize ? [{ s: `${lengthText(r.width, units)} × ${lengthText(r.depth, units)}`, font: 'mono' as const, size: 5.5 }] : []),
    ];
    let ls = lines;
    const fits = (set: typeof lines): boolean => Math.max(...set.map((l) => measure(l.s, l.font, l.size))) <= roomW && set.reduce((h, l) => h + l.size * 1.25, 0) <= roomH;
    while (!fits(ls) && ls.length > 1) ls = ls.slice(0, -1);
    if (!fits(ls)) {
      const first = ls[0]!;
      const size = Math.max(4.5, (first.size * roomW) / Math.max(1, measure(first.s, first.font, first.size)));
      ls = [{ ...first, size: Math.min(first.size, size) }];
    }
    const total = ls.reduce((h, l) => h + l.size * 1.25, 0);
    labels.set(r.id, { x, y, lines: ls, halfW: Math.max(...ls.map((l) => measure(l.s, l.font, l.size))) / 2, halfH: total / 2 });
  }
  return labels;
}

function drawRoomLabels(c: Ctx, labels: ReadonlyMap<string, RoomLabel>): void {
  for (const l of labels.values()) {
    let yy = l.y - l.halfH;
    for (const line1 of l.lines) {
      yy += line1.size * 1.25;
      c.out.push(text(l.x, yy - line1.size * 0.25, line1.s, line1.font, line1.size, { anchor: 'middle', color: line1.font === 'sans-bold' ? INK : GREY }));
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

// ── view title, north arrow, scale bar ───────────────────────────────────────

function drawViewTitle(c: Ctx, layout: SetLayout, viewTitle: string, trueNorth: number, meta: SheetMeta): void {
  const { out, measure } = c;
  const x = layout.origin[0] - layout.margins.W + 4;
  const y = layout.origin[1] + (layout.frame.maxY - layout.frame.minY) * layout.k + layout.margins.S + 20;
  out.push({ t: 'path', d: circle(x + 11, y - 4, 11), stroke: INK, width: 0.8 });
  out.push({ t: 'path', d: line([x, y - 4], [x + 22, y - 4]), stroke: INK, width: 0.5 });
  out.push(text(x + 11, y - 7, String(meta.sheetIndex + 1), 'sans-bold', 7, { anchor: 'middle' }));
  out.push(text(x + 11, y + 4, meta.sheetNumber, 'sans', 4.6, { anchor: 'middle' }));
  const title = viewTitle.toUpperCase();
  out.push(text(x + 30, y - 5, title, 'sans-bold', 10));
  const tw = measure(title, 'sans-bold', 10);
  out.push({ t: 'path', d: line([x + 30, y - 1], [x + 30 + Math.max(tw, 120), y - 1]), stroke: INK, width: 1.1 });
  out.push(text(x + 30, y + 8, `SCALE: ${layout.scale.label}`, 'sans', 6.5, { color: GREY }));
  const barX = x + 30 + Math.max(tw, 120) + 22;
  scaleBar(c, layout, meta.units, barX, y - 2);
  northArrow(c, barX + scaleBarWidth(layout, meta.units) + 34, y - 6, trueNorth);
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

function drawStrip(c: Ctx, layout: SetLayout, view: View3d, meta: SheetMeta, sheetTitle: string, rooms: readonly (readonly [string, string])[], items: readonly LegendItem[]): void {
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

  // Sheet facts, from the bottom up: the design, when the model has options, takes up to two lines.
  const design = meta.design === undefined ? [] : wrap(meta.design, w - 44, 'sans', 6.5, measure).slice(0, 2);
  const facts: [string, string[]][] = [
    ['SHEET', [sheetTitle]],
    ['SCALE', [meta.sheetNumber.startsWith('A-6') ? 'None' : layout.scale.label]],
    ...(design.length === 0 ? [] : [['DESIGN', design] as [string, string[]]]),
    ['DATE', [meta.date]],
    ['VERSION', [meta.version]],
    ['UNITS', [meta.units === 'metric' ? 'Millimetres; areas in m²' : 'Feet and inches to 1/16"; areas in SF']],
    ['PAPER', [layout.page.label]],
  ];
  const factLines = facts.reduce((n, [, v]) => n + v.length, 0);
  const factsH = 52 + factLines * 11;

  // 3D view.
  const legendH = 16 + items.length * 14;
  const bottom = s.y + s.h;
  const viewH = Math.max(90, Math.min(w * 0.95, bottom - factsH - legendH - y - 26));
  out.push(text(x, y, '3D VIEW', 'sans-medium', 5.5, { color: FAINT }));
  out.push(text(x + w, y, meta.viewCaption, 'sans', 5.5, { color: FAINT, anchor: 'end' }));
  y += 5;
  drawView(c, view, { x, y, w, h: viewH });
  y += viewH + 4;
  out.push(text(x, y + 5, 'Isometric from the south-west, rendered from the 3D model.', 'sans', 5.2, { color: GREY }));
  y += 14;
  out.push({ t: 'path', d: line([s.x, y], [s.x + s.w, y]), stroke: INK, width: 0.5 });

  // Legend.
  y += 10;
  out.push(text(x, y + 2, 'LEGEND', 'sans-medium', 5.5, { color: FAINT }));
  y += 6;
  for (const it of items) {
    y += 14;
    it.draw(x + 2, y - 2);
    out.push(text(x + 32, y, it.label, 'sans', 6.2, { color: INK }));
  }

  // The area (FLR-T-18.11): the level's gross, net and finished, and the whole house's, where there is room.
  const room = (n: number): boolean => y + 16 + 14 + n * 9 <= bottom - factsH - 6;
  // The whole house's rows go first when there is not room for all of them.
  const all = meta.areas ?? [];
  const areas = room(all.length) ? all : all.filter(([name]) => !name.startsWith('Whole house'));
  if (areas.length > 0 && room(areas.length)) {
    const top = y + 16;
    out.push({ t: 'path', d: line([s.x, top - 6], [s.x + s.w, top - 6]), stroke: INK, width: 0.5 });
    out.push(text(x, top + 6, 'AREA', 'sans-medium', 5.5, { color: FAINT }));
    let ay = top + 8;
    for (const [name, value] of areas) {
      ay += 9;
      out.push(text(x, ay, name, 'sans', 6.2));
      out.push(text(x + w, ay, value, 'mono', 6, { anchor: 'end', color: GREY }));
    }
    y = ay;
  }

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

  const fy = bottom - factsH;
  out.push({ t: 'path', d: line([s.x, fy], [s.x + s.w, fy]), stroke: INK, width: 0.5 });
  let yy = fy + 12;
  for (const [label, value] of facts) {
    out.push(text(x, yy, label, 'sans-medium', 5.2, { color: FAINT }));
    for (const v of value) {
      out.push(text(x + 44, yy, wrap(v, w - 44, 'sans', 6.5, measure)[0] ?? '', 'sans', 6.5));
      yy += 11;
    }
  }
  out.push({ t: 'path', d: line([s.x, bottom - 40], [s.x + s.w, bottom - 40]), stroke: INK, width: 0.5 });
  out.push(text(x, bottom - 26, 'SHEET', 'sans-medium', 5.2, { color: FAINT }));
  out.push(text(x, bottom - 12, `${String(meta.sheetIndex + 1)} of ${String(meta.sheetCount)}`, 'sans', 6.5, { color: GREY }));
  out.push(text(x + w, bottom - 11, meta.sheetNumber, 'sans-bold', 22, { anchor: 'end' }));
}

interface LegendItem {
  readonly label: string;
  readonly draw: (cx: number, cy: number) => void;
}

function planLegend(c: Ctx): LegendItem[] {
  const { out } = c;
  return [
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
}

function stairLegend(c: Ctx, stairs: readonly PlanStair[]): LegendItem[] {
  const { out } = c;
  const marks: LegendItem[] = [];
  if (stairs.some((st) => st.steps.some((s) => s.winder)))
    marks.push({
      label: 'Winder (tapered tread), tinted',
      draw: (cx, cy) => out.push({ t: 'path', d: ring([[cx, cy + 4], [cx + 22, cy + 4], [cx + 22, cy - 4], [cx + 8, cy - 4]]), fill: WINDER_TINT, stroke: INK, width: 0.35 }),
    });
  if (stairs.some((st) => st.newel !== null || st.column !== null))
    marks.push({ label: 'Newel post or spiral column', draw: (cx, cy) => out.push({ t: 'path', d: rect(cx + 8, cy - 3, 6, 6), fill: INK }) });
  if (stairs.some((st) => st.opening !== null))
    marks.push({
      label: 'Floor above open from here (headroom)',
      draw: (cx, cy) => out.push({ t: 'path', d: line([cx, cy], [cx + 22, cy]), stroke: OPENING, width: 0.9, dash: OPENING_DASH, cap: 'butt' }),
    });
  return [
    {
      label: 'Stair: UP from the foot, DN from the head',
      draw: (cx, cy) => {
        out.push({ t: 'path', d: line([cx, cy - 4], [cx, cy + 4]) + line([cx + 6, cy - 4], [cx + 6, cy + 4]) + line([cx + 12, cy - 4], [cx + 12, cy + 4]), stroke: INK, width: 0.35 });
        out.push({ t: 'path', d: line([cx - 2, cy], [cx + 18, cy]), stroke: INK, width: 0.45 });
        out.push({ t: 'path', d: arrowHead([cx, cy], [cx + 22, cy], 4.5), fill: INK });
      },
    },
    {
      label: 'Cut line at 4\'-0" with break; above it dashed',
      draw: (cx, cy) => {
        out.push({ t: 'path', d: `${M([cx, cy + 4])}${L([cx + 9, cy + 0.5])}${L([cx + 10.5, cy - 2.5])}${L([cx + 11.5, cy + 2.5])}${L([cx + 13, cy - 0.5])}${L([cx + 22, cy - 4])}`, stroke: INK, width: 0.7 });
      },
    },
    ...marks,
  ];
}

function roofLegend(c: Ctx): LegendItem[] {
  const { out } = c;
  return [
    { label: 'Eave (roof outline)', draw: (cx, cy) => out.push({ t: 'path', d: line([cx, cy], [cx + 22, cy]), stroke: INK, width: 0.9 }) },
    { label: 'Ridge', draw: (cx, cy) => out.push({ t: 'path', d: line([cx, cy], [cx + 22, cy]), stroke: INK, width: 0.8 }) },
    { label: 'Hip', draw: (cx, cy) => out.push({ t: 'path', d: line([cx, cy + 4], [cx + 22, cy - 4]), stroke: INK, width: 0.5 }) },
    { label: 'Valley', draw: (cx, cy) => out.push({ t: 'path', d: line([cx, cy - 4], [cx + 22, cy + 4]), stroke: INK, width: 0.5, dash: [4, 1.5, 1, 1.5] }) },
    { label: 'Gable end', draw: (cx, cy) => out.push({ t: 'path', d: line([cx, cy], [cx + 22, cy]), stroke: INK, width: 1.8 }) },
    {
      label: 'Slope down, with its pitch',
      draw: (cx, cy) => {
        out.push({ t: 'path', d: line([cx, cy], [cx + 22, cy]), stroke: INK, width: 0.45 });
        out.push({ t: 'path', d: arrowHead([cx, cy], [cx + 22, cy], 4.5), fill: INK });
      },
    },
    { label: 'Exterior wall below', draw: (cx, cy) => out.push({ t: 'path', d: line([cx, cy], [cx + 22, cy]), stroke: FAINT, width: 0.45, dash: [3, 2] }) },
  ];
}

/** The 3D view's panel: the render, fitted, or a note when there is nothing to draw. */
function drawView(c: Ctx, view: View3d, box: { x: number; y: number; w: number; h: number }): void {
  const { out } = c;
  const image = view(box.w, box.h);
  if (image === null) {
    out.push({ t: 'path', d: rect(box.x, box.y, box.w, box.h), fill: '#fafafa', stroke: HAIR, width: 0.4 });
    out.push(text(box.x + box.w / 2, box.y + box.h / 2, 'Nothing to draw on this level yet', 'sans', 6, { anchor: 'middle', color: FAINT }));
    return;
  }
  out.push({ t: 'image', x: box.x, y: box.y, w: box.w, h: box.h, png: image.png });
  out.push({ t: 'path', d: rect(box.x, box.y, box.w, box.h), stroke: HAIR, width: 0.4 });
}
