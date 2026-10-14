import { furniture } from '@floorspec/engine';
import { islandBays } from '@floorspec/mesh';
import type { Operation, ResizeAnchor } from '@floorspec/ops';
import type { Point } from '../editor/model';
import type { Batch } from '../editor/ops';
import type { DeviceView } from '../editor/systems/view';
import { assetOf } from './view';
import type { FloorspecDocument } from '@floorspec/engine';

/**
 * Resizing and turning an item (FLR-T-18.4): the sizes an item comes in, the handles on its plan
 * footprint, and the Ops a drag or a typed size becomes — one `resizeElement` (Ops 0.4, 4.11), or for
 * a turn one batch that sets its host's rotation and the position that keeps its middle where it was.
 *
 * Sizes are in the element's own terms, as FS_furniture 3.1 names them: width along its y (right to
 * left), depth along its x (back to front), height up. A handle on one side moves that side and holds
 * the opposite one; with ⌥ it grows from the middle. Each kind snaps to its own increments: cabinets to
 * the 3" module, beds and tables and sofas to the sizes they are made in, anything else to ½" (⇧: free).
 */

export const IN = 32_512;
export const FT = 12 * IN;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface IntBox {
  min: [number, number, number];
  max: [number, number, number];
}
export type Axis = 'width' | 'depth' | 'height';
export type Size = Record<Axis, number>;

/** An element's fallback box when it is two triples of integers. */
export function boxOf(element: Json): IntBox | null {
  const fb = element['fallback'];
  const b = isObject(fb) ? fb['box'] : undefined;
  if (!isObject(b)) return null;
  const ok = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((c) => Number.isSafeInteger(c));
  return ok(b['min']) && ok(b['max']) ? { min: b['min'], max: b['max'] } : null;
}

export const sizeOf = (b: IntBox): Size => ({ depth: b.max[0] - b.min[0], width: b.max[1] - b.min[1], height: b.max[2] - b.min[2] });

/** The collections whose elements are sized by their box and get handles. */
const RESIZABLE: Readonly<Record<string, readonly string[]>> = {
  FS_furniture: ['pieces', 'appliances', 'casework'],
  FS_plumbing: ['fixtures', 'waterHeaters'],
  FS_mechanical: ['equipment', 'gasAppliances'],
  FS_landscape: ['plants', 'beds'],
};

/** Whether an element is one the editor resizes: furniture, casework, appliances, fixtures, a bed of plants. */
export const isResizable = (d: { extension: string; collection: string; element: Json }): boolean =>
  (RESIZABLE[d.extension] ?? []).includes(d.collection) && boxOf(d.element) !== null;

/** Whether an element turns freely in plan: one standing on a floor or free, not on a wall face. */
export const turnsFreely = (d: { host: Json | null }): boolean => d.host !== null && (d.host['mode'] === 'surface' || d.host['mode'] === 'free');

// ─── The sizes things come in ────────────────────────────────────────────────────────────────

export interface CommonSize {
  label: string;
  width?: number;
  depth?: number;
}

export interface SizeRule {
  /** The increment a drag and a typed size snap to. */
  step: number;
  /** What the step is called, for the drag's tag: "3\" cabinet module". */
  stepLabel: string;
  /** The sizes it comes in: the binding's limits, passed to the applier (Ops 4.11 `limits`). */
  limits: Partial<Record<Axis, { min?: number; max?: number }>>;
  /** Sizes it is commonly made in, offered as chips and snapped to when a drag comes near. */
  common: readonly CommonSize[];
  /** The note under a field, by axis: "Standard: 24\" base · 36\" with seating overhang". */
  notes: Partial<Record<Axis, string>>;
}

const HALF_INCH = IN / 2;
const ANY: SizeRule = { step: HALF_INCH, stepLabel: '½" grid', limits: {}, common: [], notes: {} };
const CABINET_STEP = 3 * IN;

const RULES: Readonly<Record<string, SizeRule>> = {
  island: {
    step: CABINET_STEP,
    stepLabel: '3" cabinet module',
    limits: { width: { min: 36 * IN, max: 168 * IN }, depth: { min: 18 * IN, max: 72 * IN }, height: { min: 24 * IN, max: 48 * IN } },
    common: [72, 84, 96, 108, 120].map((w) => ({ label: `${String(w)}"`, width: w * IN })),
    notes: { width: 'Cabinet module: 3" · common island lengths', depth: 'Standard: 24" base · 36" with seating overhang · 42"', height: 'Counter 34½"–36" · bar 42"' },
  },
  baseCabinet: {
    step: CABINET_STEP,
    stepLabel: '3" cabinet module',
    limits: { width: { min: 9 * IN, max: 48 * IN }, depth: { min: 12 * IN, max: 30 * IN }, height: { min: 24 * IN, max: 42 * IN } },
    common: [12, 15, 18, 24, 30, 36].map((w) => ({ label: `${String(w)}"`, width: w * IN })),
    notes: { width: 'Cabinet module: 3"', depth: 'Standard: 24" base', height: 'Counter 34½"–36"' },
  },
  vanity: {
    step: CABINET_STEP,
    stepLabel: '3" cabinet module',
    limits: { width: { min: 18 * IN, max: 72 * IN }, depth: { min: 16 * IN, max: 24 * IN } },
    common: [24, 30, 36, 48, 60].map((w) => ({ label: `${String(w)}"`, width: w * IN })),
    notes: { width: 'Cabinet module: 3"', height: 'Vanity 32"–36"' },
  },
  wallCabinet: {
    step: CABINET_STEP,
    stepLabel: '3" cabinet module',
    limits: { width: { min: 9 * IN, max: 48 * IN }, depth: { min: 9 * IN, max: 24 * IN } },
    common: [12, 15, 18, 24, 30, 36].map((w) => ({ label: `${String(w)}"`, width: w * IN })),
    notes: { width: 'Cabinet module: 3"', height: 'Wall cabinets 12"–42" tall' },
  },
  tallCabinet: {
    step: CABINET_STEP,
    stepLabel: '3" cabinet module',
    limits: { width: { min: 12 * IN, max: 36 * IN }, depth: { min: 12 * IN, max: 27 * IN } },
    common: [18, 24, 30, 36].map((w) => ({ label: `${String(w)}"`, width: w * IN })),
    notes: { width: 'Cabinet module: 3"', height: 'Tall cabinets 84"–96"' },
  },
  bed: {
    step: HALF_INCH,
    stepLabel: 'mattress sizes',
    limits: {},
    common: [
      { label: 'Twin 38×75', width: 38 * IN, depth: 75 * IN },
      { label: 'Full 54×75', width: 54 * IN, depth: 75 * IN },
      { label: 'Queen 60×80', width: 60 * IN, depth: 80 * IN },
      { label: 'King 76×80', width: 76 * IN, depth: 80 * IN },
    ],
    notes: { width: 'Mattress widths: Twin 38" · Full 54" · Queen 60" · King 76"', depth: 'Mattress lengths: 75" · 80"' },
  },
  diningTable: {
    step: HALF_INCH,
    stepLabel: 'table sizes',
    limits: {},
    common: [
      { label: '2 seats 30"', width: 30 * IN, depth: 30 * IN },
      { label: '4 seats 48"', width: 48 * IN, depth: 36 * IN },
      { label: '6 seats 72"', width: 72 * IN, depth: 36 * IN },
      { label: '8 seats 96"', width: 96 * IN, depth: 40 * IN },
    ],
    notes: { height: 'Table height 29"–30"' },
  },
  sofa: {
    step: HALF_INCH,
    stepLabel: 'sofa sizes',
    limits: {},
    common: [
      { label: '2 seats 60"', width: 60 * IN },
      { label: '3 seats 84"', width: 84 * IN },
      { label: '4 seats 96"', width: 96 * IN },
    ],
    notes: {},
  },
};
const RUG: SizeRule = {
  step: HALF_INCH,
  stepLabel: 'rug sizes',
  limits: {},
  common: [
    { label: "5×8'", width: 5 * FT, depth: 8 * FT },
    { label: "8×10'", width: 8 * FT, depth: 10 * FT },
    { label: "9×12'", width: 9 * FT, depth: 12 * FT },
  ],
  notes: {},
};

/** The sizes an item comes in: by its category, and a rug by its catalogue (a rug is decor of category `other`). */
export function ruleFor(d: { extension: string; element: Json }): SizeRule {
  if (d.extension !== 'FS_furniture') return ANY;
  const category = typeof d.element['category'] === 'string' ? d.element['category'] : '';
  const catalogue = typeof d.element['catalogue'] === 'string' ? d.element['catalogue'] : '';
  if (category === 'other' && catalogue.startsWith('rug')) return RUG;
  return RULES[category] ?? ANY;
}

/** The smallest extent a drag makes: 1" (Core 13.2.2 asks only 1 mm). */
const SMALLEST = IN;

/** Snap an extent of one axis: to a common size within 2" of it, else to the rule's step (⇧: to 1/16"); then into its limits. */
export function snapExtent(rule: SizeRule, axis: Axis, value: number, free: boolean): number {
  let v = value;
  const near = rule.common.map((c) => (axis === 'width' ? c.width : axis === 'depth' ? c.depth : undefined)).filter((c): c is number => c !== undefined);
  const hit = free ? undefined : near.find((c) => Math.abs(c - v) <= 2 * IN);
  if (hit !== undefined) v = hit;
  else {
    const step = free ? IN / 16 : rule.step;
    v = Math.round(v / step) * step;
  }
  const lim = rule.limits[axis];
  if (lim?.min !== undefined) v = Math.max(v, lim.min);
  if (lim?.max !== undefined) v = Math.min(v, lim.max);
  return Math.max(SMALLEST, Math.round(v));
}

/** The `limits` member for a resizeElement of these axes: only those the rule has. */
function limitsFor(rule: SizeRule, axes: readonly Axis[]): Record<string, { min?: number; max?: number }> | undefined {
  const out: Record<string, { min?: number; max?: number }> = {};
  for (const a of axes) {
    const l = rule.limits[a];
    if (l !== undefined && (l.min !== undefined || l.max !== undefined)) out[a] = { ...l };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** One resizeElement (Ops 0.4, 4.11): the extents that change, from an anchor, within the item's limits. */
export function resizeBatch(id: string, anchor: ResizeAnchor, next: Partial<Size>, rule: SizeRule): Batch {
  const op: Record<string, unknown> = { op: 'resizeElement', element: id, anchor };
  const axes = (['width', 'depth', 'height'] as const).filter((a) => next[a] !== undefined);
  if (axes.length === 0) return [];
  for (const a of axes) op[a] = next[a];
  const limits = limitsFor(rule, axes);
  if (limits !== undefined) op['limits'] = limits;
  return [op as unknown as Operation];
}

// ─── The handles ─────────────────────────────────────────────────────────────────────────────

export type HandleSide = 'front' | 'back' | 'left' | 'right' | 'front-left' | 'front-right' | 'back-left' | 'back-right';

export interface Handle {
  side: HandleSide;
  /** Where it is in plan. */
  at: Point;
  /** The anchor a drag of it holds: the opposite side or corner. */
  anchor: ResizeAnchor;
  axes: readonly ('width' | 'depth')[];
}

const OPPOSITE: Readonly<Record<HandleSide, ResizeAnchor>> = {
  front: 'back',
  back: 'front',
  left: 'right',
  right: 'left',
  'front-left': 'back-right',
  'front-right': 'back-left',
  'back-left': 'front-right',
  'back-right': 'front-left',
};

/** The element's frame (Core 13.1) as plain floats: origin, forward and left. */
export function frameVectors(d: DeviceView): { o: Point; u: Point; v: Point } {
  const o = d.placement?.point ?? [0, 0];
  const rad = d.placement === null ? 0 : (d.placement.facing / 1_000_000) * (Math.PI / 180);
  const u: Point = [Math.cos(rad), Math.sin(rad)];
  return { o, u, v: [-u[1], u[0]] };
}

export const toPlan = (f: { o: Point; u: Point; v: Point }, x: number, y: number): Point => [f.o[0] + x * f.u[0] + y * f.v[0], f.o[1] + x * f.u[1] + y * f.v[1]];
export const toLocal = (f: { o: Point; u: Point; v: Point }, p: Point): Point => {
  const dx = p[0] - f.o[0];
  const dy = p[1] - f.o[1];
  return [dx * f.u[0] + dy * f.u[1], dx * f.v[0] + dy * f.v[1]];
};

/** The eight handles of an element's footprint: four edges, four corners. */
export function handlesOf(d: DeviceView): Handle[] {
  const b = boxOf(d.element);
  if (b === null) return [];
  const f = frameVectors(d);
  const [x0, y0, x1, y1] = [b.min[0], b.min[1], b.max[0], b.max[1]];
  const xm = (x0 + x1) / 2;
  const ym = (y0 + y1) / 2;
  const at: Record<HandleSide, [number, number]> = {
    front: [x1, ym],
    back: [x0, ym],
    left: [xm, y1],
    right: [xm, y0],
    'front-left': [x1, y1],
    'front-right': [x1, y0],
    'back-left': [x0, y1],
    'back-right': [x0, y0],
  };
  return (Object.keys(at) as HandleSide[]).map((side) => ({
    side,
    at: toPlan(f, at[side][0], at[side][1]),
    anchor: OPPOSITE[side],
    axes: side.includes('-') ? ['width', 'depth'] : side === 'front' || side === 'back' ? ['depth'] : ['width'],
  }));
}

/** The middle of the footprint, in plan. */
export function middleOf(d: DeviceView): Point | null {
  const b = boxOf(d.element);
  if (b === null) return null;
  return toPlan(frameVectors(d), (b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2);
}

/** Where the rotate handle stands: behind the item's back, `px` screen pixels out (`scale` px per base unit). */
export function rotateHandleOf(d: DeviceView, scale: number, px = 28): Point | null {
  const b = boxOf(d.element);
  if (b === null || !turnsFreely(d)) return null;
  const f = frameVectors(d);
  return toPlan(f, b.min[0] - px / scale, (b.min[1] + b.max[1]) / 2);
}

export interface ResizeDrag {
  anchor: ResizeAnchor;
  size: Partial<Size>;
}

/**
 * What dragging a handle to `world` makes: the new extents of the axes it moves, snapped, held at
 * the opposite side (⌥: at the middle) — and from a corner with `keepRatio`, both scaled alike.
 */
export function dragResize(d: DeviceView, handle: Handle, world: Point, opts: { free: boolean; centre: boolean; keepRatio: boolean }): ResizeDrag | null {
  const b = boxOf(d.element);
  if (b === null) return null;
  const rule = ruleFor(d);
  const f = frameVectors(d);
  const [lx, ly] = toLocal(f, world);
  const [x0, y0, x1, y1] = [b.min[0], b.min[1], b.max[0], b.max[1]];
  const old = sizeOf(b);
  const raw: Partial<Size> = {};
  const s = handle.side;
  if (handle.axes.includes('depth')) {
    const front = s.startsWith('front');
    raw.depth = opts.centre ? 2 * Math.abs(lx - (x0 + x1) / 2) : front ? lx - x0 : x1 - lx;
  }
  if (handle.axes.includes('width')) {
    const left = s.endsWith('left');
    raw.width = opts.centre ? 2 * Math.abs(ly - (y0 + y1) / 2) : left ? ly - y0 : y1 - ly;
  }
  if (opts.keepRatio && raw.width !== undefined && raw.depth !== undefined) {
    const k = Math.max(raw.width / old.width, raw.depth / old.depth);
    raw.width = old.width * k;
    raw.depth = old.depth * k;
  }
  const size: Partial<Size> = {};
  for (const a of handle.axes) size[a] = snapExtent(rule, a, raw[a] ?? old[a], opts.free);
  let anchor: ResizeAnchor = handle.anchor;
  if (opts.centre) anchor = 'center';
  return { anchor, size };
}

// ─── From the keyboard (FLR-T-18.16) ─────────────────────────────────────────────────────────

/** An extent kept within its rule's limits and no smaller than the smallest a handle makes. */
function within(rule: SizeRule, axis: Axis, value: number): number {
  const lim = rule.limits[axis];
  let v = value;
  if (lim?.min !== undefined) v = Math.max(v, lim.min);
  if (lim?.max !== undefined) v = Math.min(v, lim.max);
  return Math.max(SMALLEST, Math.round(v));
}

/**
 * A focused handle moved from the keyboard (the board's handle rules, frame 18.4: "arrows nudge the
 * focused handle by the snap step, ⇧ × 4"): out (`dir` 1) or in (−1) by the item's size step — 3″
 * for cabinets, ½″ for anything — onto that step, held at the opposite side as a drag of it is. A
 * corner moves both its axes. Null when it cannot move that way (at a limit, or no such handle).
 */
export function keyResize(d: DeviceView, side: HandleSide, dir: 1 | -1, coarse: boolean): ResizeDrag | null {
  const b = boxOf(d.element);
  const handle = handlesOf(d).find((h) => h.side === side);
  if (b === null || handle === undefined) return null;
  const rule = ruleFor(d);
  const old = sizeOf(b);
  const step = rule.step * (coarse ? 4 : 1);
  const size: Partial<Size> = {};
  for (const a of handle.axes) {
    // Onto the step's grid: from 70⅞″, one 3″ step out is 72″, not 73⅞″.
    const onGrid = dir > 0 ? Math.floor(old[a] / rule.step) * rule.step + step : Math.ceil(old[a] / rule.step) * rule.step - step;
    size[a] = within(rule, a, onGrid);
  }
  if (handle.axes.every((a) => size[a] === old[a])) return null;
  return { anchor: handle.anchor, size };
}

/**
 * The rotate handle from the keyboard: 15° a press (⇧: 1°), clockwise for `dir` 1, from the item's
 * facing onto that step. Null for an item that does not turn freely.
 */
export function keyRotate(d: DeviceView, dir: 1 | -1, fine: boolean): number | null {
  if (!turnsFreely(d) || boxOf(d.element) === null) return null;
  const now = typeof d.host?.['rotation'] === 'number' ? d.host['rotation'] : 0;
  const step = (fine ? 1 : 15) * 1_000_000;
  // Clockwise is a smaller facing (Core 13.1's angles run counter-clockwise).
  const k = Math.round(now / step);
  const onGrid = k * step === now ? k - dir : dir > 0 ? Math.floor(now / step) : Math.ceil(now / step);
  return normalRotation(onGrid * step);
}

/** A whole-degree angle, in microdegrees, in (−180°, 180°]. */
export function normalRotation(micro: number): number {
  const n = ((Math.round(micro) % 360_000_000) + 540_000_000) % 360_000_000 - 180_000_000;
  return n === -180_000_000 ? 180_000_000 : n;
}

/**
 * Turning by the rotate handle: the facing that points the item's back at the pointer from its
 * middle, snapped to 15° (⇧: 1°), and the host position that keeps the middle where it is.
 */
export function dragRotate(d: DeviceView, world: Point, fine: boolean): { rotation: number; position: [number, number] } | null {
  const b = boxOf(d.element);
  const mid = middleOf(d);
  if (b === null || mid === null || !turnsFreely(d)) return null;
  const dx = world[0] - mid[0];
  const dy = world[1] - mid[1];
  if (dx === 0 && dy === 0) return null;
  // The handle is behind the back: the facing is away from the pointer.
  const deg = (Math.atan2(-dy, -dx) * 180) / Math.PI;
  const step = fine ? 1 : 15;
  const snapped = Math.round(deg / step) * step;
  const rotation = normalRotation(snapped * 1_000_000);
  return { rotation, position: positionKeepingMiddle(d, rotation) };
}

/** The host position at which an element turned to `rotation` keeps the middle of its footprint where it is. */
export function positionKeepingMiddle(d: DeviceView, rotation: number): [number, number] {
  const b = boxOf(d.element);
  const mid = middleOf(d);
  const pos = d.host?.['position'];
  if (b === null || mid === null) return Array.isArray(pos) ? [Number(pos[0]), Number(pos[1])] : [0, 0];
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  const rad = (rotation / 1_000_000) * (Math.PI / 180);
  const u: Point = [Math.cos(rad), Math.sin(rad)];
  const v: Point = [-u[1], u[0]];
  return [Math.round(mid[0] - cx * u[0] - cy * v[0]), Math.round(mid[1] - cx * u[1] - cy * v[1])];
}

/** One batch that turns an element about its middle: its position and its rotation, one undo step. */
export function turnBatch(d: DeviceView, rotation: number): Batch {
  const position = positionKeepingMiddle(d, rotation);
  const now = typeof d.host?.['rotation'] === 'number' ? d.host['rotation'] : 0;
  const out: Batch = [];
  const pos = d.host?.['position'];
  if (!Array.isArray(pos) || pos[0] !== position[0] || pos[1] !== position[1]) out.push({ op: 'setProperty', id: d.id, path: '/host/position', value: position });
  if (rotation === 0) {
    if (now !== 0) out.push({ op: 'unsetProperty', id: d.id, path: '/host/rotation' });
  } else if (rotation !== now) out.push({ op: 'setProperty', id: d.id, path: '/host/rotation', value: rotation });
  return out;
}

// ─── The model ───────────────────────────────────────────────────────────────────────────────

/**
 * How an item's 3D model meets a new size. A procedural model (FLR-T-12.21) — every element whose
 * model is a starter-library proxy, or that has none — is drawn again from its box: a longer island
 * gets more bays. A project's own glTF model is drawn as it is, never stretched (Core 12.6): it is
 * fixed-size, and resizing changes what is measured — the box, the clearances — not what is drawn.
 */
export function modelKind(document: FloorspecDocument, d: { extension: string; element: Json }): 'procedural' | 'fixed' {
  if (d.extension !== 'FS_furniture') return 'procedural';
  const fb = d.element['fallback'];
  const asset = assetOf(document, isObject(fb) ? fb['asset'] : undefined);
  if (asset === null) return 'procedural';
  return furniture.isStarterLibraryModel(asset.sha256) ? 'procedural' : 'fixed';
}

/** The bays a procedural island is drawn with at a width and depth: as packages/mesh draws it. */
export function baysAt(category: string, size: Size): number | null {
  return category === 'island' ? islandBays(size.depth, size.width) : null;
}
