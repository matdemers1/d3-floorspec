/**
 * FS_landscape 0.1.0 (registry/FS_landscape/spec.md): plants by a species-agnostic size class,
 * planting beds, lawns and hardscape lines; hosts on a level's ground or an outdoor room's floor,
 * outlines and lines in the element's frame, and the vertical in its box (FLR-ADR-041, FLR-ADR-042).
 */
import { validate as validateSchema } from '../../generated/validate-FS_landscape.js';
import type * as G from '../../generated/types-FS_landscape.js';
import { halfString } from '../../derive/derive.js';
import { elementFrame, hostFrame, placementOf, planPoint, type Frame } from '../../derive/frames.js';
import { isqrt, toSafeNumber } from '../../exact/bigint.js';
import { area2, isSimple, locate, type IPoint } from '../../geometry/predicates.js';
import { entries, get, ipoint } from '../../model/document.js';
import { record, sorted, type ExtensionContext, type ExtensionImplementation } from '../context.js';
import type { Element } from '../types.js';

export type LandscapeData = G.FSLandscape010;
export type Plant = Element<G.Plant>;
export type Bed = Element<G.Bed>;
export type Lawn = Element<G.Lawn>;
export type Hardscape = Element<G.Hardscape>;
export type LandscapeElement = Plant | Bed | Lawn | Hardscape;

/** The kinds (collections) of FS_landscape (chapter 2). */
export const LANDSCAPE_KINDS = ['plants', 'beds', 'lawns', 'hardscape'] as const;
export type LandscapeKind = (typeof LANDSCAPE_KINDS)[number];

export type PlantForm = G.Plant['form'];
export type SizeClass = 'small' | 'medium' | 'large';

const MM = 1280;
/** 2.3: the lower bounds of medium and large, by form, in millimetres. */
export const SIZE_BOUNDS: Readonly<Record<PlantForm, readonly [number, number]>> = {
  tree: [8000, 14000],
  shrub: [900, 2000],
  grass: [600, 1200],
  groundcover: [150, 300],
};

/** 2.3: a plant's size class from its form and its height (its box's vertical extent). */
export function sizeClass(form: PlantForm, height: number): SizeClass {
  const [m, l] = SIZE_BOUNDS[form];
  return height < m * MM ? 'small' : height < l * MM ? 'medium' : 'large';
}

/** 6.2: what FS_landscape derives for one plant. */
export interface DerivedPlant {
  form: PlantForm;
  size: SizeClass;
  spread: number;
  height: number;
  position: [number, number];
  room?: string;
}

/** Chapter 6: what FS_landscape derives. */
export interface DerivedLandscape {
  plants: Record<string, DerivedPlant>;
  beds: Record<string, { area: string; plants: string[] }>;
  lawns: Record<string, { area: string }>;
  hardscape: Record<string, { form: G.Hardscape['form']; length: number }>;
}

/** 3.4: local points taken to the plan by a frame, exactly, and rounded once. */
export function toPlan(fr: Frame, points: readonly (readonly [number, number])[]): IPoint[] {
  return points.map(([p, q]) => {
    const { x, y } = planPoint(fr, BigInt(p), BigInt(q));
    return [x.round(), y.round()] as const;
  });
}

/** round(√n) for n ≥ 0: never a tie, since (k + ½)² is never an integer. */
function roundSqrt(n: bigint): bigint {
  const k = isqrt(n);
  return n - k * k > k ? k + 1n : k;
}

/** 6.4: a line's length, the sum of its segments' lengths, each rounded once. */
export function lineLength(points: readonly (readonly [number, number])[]): number {
  let s = 0n;
  for (let i = 0; i + 1 < points.length; i++) {
    const dx = BigInt(points[i + 1]![0] - points[i]![0]);
    const dy = BigInt(points[i + 1]![1] - points[i]![1]);
    s += roundSqrt(dx * dx + dy * dy);
  }
  return toSafeNumber(s);
}

/** 3.5: an element's geometry inside its box, horizontally and exactly, in its frame. */
export function insideBox(kind: LandscapeKind, el: LandscapeElement): boolean {
  const [x0, y0] = el.fallback.box.min;
  const [x1, y1] = el.fallback.box.max;
  if (kind === 'plants') return x0 <= 0 && 0 <= x1 && y0 <= 0 && 0 <= y1;
  if (kind === 'beds' || kind === 'lawns') return (el as Bed | Lawn).boundary.every(([p, q]) => x0 <= p && p <= x1 && y0 <= q && q <= y1);
  const h = Math.floor((el as Hardscape).width / 2);
  return (el as Hardscape).points.every(([p, q]) => x0 <= p - h && p + h <= x1 && y0 <= q - h && q + h <= y1);
}

function elements(ctx: ExtensionContext): [LandscapeKind, string, LandscapeElement][] {
  return LANDSCAPE_KINDS.flatMap((k) => ctx.coll<LandscapeElement>(k).map(([id, el]): [LandscapeKind, string, LandscapeElement] => [k, id, el]));
}

/** 6.1: a plant's position, its placement's point in plan. */
function position(ctx: ExtensionContext, el: Plant): IPoint {
  const [x, y] = placementOf(hostFrame(ctx.doc, ctx.analysis, el.host!)).point;
  return [BigInt(x), BigInt(y)];
}

/** Every bed's level and outline in plan. */
function beds(ctx: ExtensionContext): [string, string, IPoint[]][] {
  return ctx.coll<Bed>('beds').map(([id, el]) => [id, el.fallback.level, toPlan(elementFrame(ctx.doc, ctx.analysis, el), el.boundary)]);
}

function invariants(ctx: ExtensionContext): void {
  for (const [kind, id, el] of elements(ctx)) {
    const host = el.host;
    if (host?.mode === 'wallFace' || (host?.mode === 'surface' && host.surface === 'ceiling'))
      ctx.report('FS-LAND-INV-001', `${id} is hosted on a ${host.mode === 'wallFace' ? 'wall face' : 'ceiling'}: landscape stands on the ground or a floor.`, [id]);
    if (kind === 'plants') {
      const p = el as Plant;
      if (host === undefined) ctx.report('FS-LAND-INV-002', `The plant ${id} has no host: a plant stands at its host's position.`, [id]);
      const h = p.fallback.box.max[2] - p.fallback.box.min[2];
      if (p.clearHeight !== undefined && p.clearHeight >= h) ctx.report('FS-LAND-INV-003', `${id}'s clearHeight is not less than its height.`, [id]);
    } else if (kind === 'beds' || kind === 'lawns') {
      const ring = (el as Bed | Lawn).boundary.map(ipoint);
      if (!isSimple(ring) || area2(ring) === 0n) ctx.report('FS-LAND-INV-004', `${id}'s boundary is not a simple polygon enclosing a positive area.`, [id]);
    } else {
      const pts = (el as Hardscape).points;
      if (pts.some((p, i) => i + 1 < pts.length && p[0] === pts[i + 1]![0] && p[1] === pts[i + 1]![1]))
        ctx.report('FS-LAND-INV-005', `${id}'s line repeats a point.`, [id]);
    }
  }
}

function lints(ctx: ExtensionContext): void {
  for (const [kind, id, el] of elements(ctx))
    if (!insideBox(kind, el)) ctx.report('FS-LAND-LINT-001', `${id}'s ${kind === 'plants' ? 'position' : 'geometry'} is not inside its box.`, [id]);
  const outlines = beds(ctx);
  const rooms = ctx.rooms();
  const slabs = entries(ctx.doc.slabs);
  for (const [id, el] of ctx.coll<Plant>('plants')) {
    const level = el.fallback.level;
    const at = position(ctx, el);
    if (!outlines.some(([, lv, ring]) => lv === level && locate(at, ring) === 'inside'))
      for (const [sid, s] of slabs)
        if (s.level === level && locate(at, s.boundary.map(ipoint)) === 'inside') ctx.report('FS-LAND-LINT-002', `${id} stands on the paving of ${sid}, in no bed.`, [id, sid]);
    const rid = rooms.get(id);
    if (rid !== undefined && (get(ctx.doc.rooms, rid)?.function ?? 'unspecified') !== 'exterior') ctx.report('FS-LAND-LINT-003', `${id} stands in ${rid}, which is not exterior.`, [id, rid]);
  }
}

function derive(ctx: ExtensionContext): DerivedLandscape {
  const rooms = ctx.rooms();
  const positions: [string, string, IPoint][] = [];
  const plants: [string, DerivedPlant][] = [];
  for (const [id, el] of ctx.coll<Plant>('plants')) {
    const { min, max } = el.fallback.box;
    const height = max[2] - min[2];
    const at = position(ctx, el);
    positions.push([id, el.fallback.level, at]);
    const p: DerivedPlant = { form: el.form, size: sizeClass(el.form, height), spread: Math.max(max[0] - min[0], max[1] - min[1]), height, position: [toSafeNumber(at[0]), toSafeNumber(at[1])] };
    const rid = rooms.get(id);
    if (rid !== undefined) p.room = rid;
    plants.push([id, p]);
  }
  const area = (ring: readonly IPoint[]): string => {
    const a = area2(ring);
    return halfString(a < 0n ? -a : a);
  };
  return {
    plants: record(plants),
    beds: record(beds(ctx).map(([id, level, ring]) => [id, { area: area(ring), plants: sorted(positions.filter(([, lv, at]) => lv === level && locate(at, ring) === 'inside').map(([pid]) => pid)) }])),
    lawns: record(ctx.coll<Lawn>('lawns').map(([id, el]) => [id, { area: area(toPlan(elementFrame(ctx.doc, ctx.analysis, el), el.boundary)) }])),
    hardscape: record(ctx.coll<Hardscape>('hardscape').map(([id, el]) => [id, { form: el.form, length: lineLength(el.points) }])),
  };
}

export const FS_LANDSCAPE: ExtensionImplementation<DerivedLandscape> = {
  name: 'FS_landscape',
  version: '0.1.0',
  code: 'LAND',
  catalogue: [
    { code: 'FS-LAND-SCH-001', severity: 'error', condition: 'the top-level data does not match the schema' },
    { code: 'FS-LAND-INV-001', severity: 'error', condition: 'an element hosted on a wall face or a ceiling' },
    { code: 'FS-LAND-INV-002', severity: 'error', condition: 'a plant without a host' },
    { code: 'FS-LAND-INV-003', severity: 'error', condition: 'a plant whose `clearHeight` is not less than its height' },
    { code: 'FS-LAND-INV-004', severity: 'error', condition: "a bed's or a lawn's `boundary` that is not a simple polygon enclosing a positive area" },
    { code: 'FS-LAND-INV-005', severity: 'error', condition: 'a hardscape element with two equal consecutive points' },
    { code: 'FS-LAND-LINT-001', severity: 'warning', condition: 'an element whose geometry is not inside its box (3.5)' },
    { code: 'FS-LAND-LINT-002', severity: 'info', condition: 'a plant on paving: strictly inside a slab of its level, and strictly inside no bed' },
    { code: 'FS-LAND-LINT-003', severity: 'info', condition: 'a plant indoors: in a room whose `function` is not `"exterior"`' },
  ],
  validate: (data) => validateSchema(data),
  invariants,
  lints,
  derive,
};
