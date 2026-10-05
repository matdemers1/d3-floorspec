/**
 * FS_furniture 0.1.0 (registry/FS_furniture/spec.md): furniture pieces, appliances and casework,
 * each with a glTF model and a plan symbol; groups (`with`), connections, default envelopes, and
 * the interference lints.
 */
import { validate as validateSchema } from '../../generated/validate-FS_furniture.js';
import type * as G from '../../generated/types-FS_furniture.js';
import { halfString } from '../../derive/derive.js';
import { elementFrame, envelopesOverlap, footprintOf, openingFrame, type Footprint } from '../../derive/frames.js';
import { area2 } from '../../geometry/predicates.js';
import { entries, extElements, get, type Box, type ClearanceEnvelope } from '../../model/document.js';
import { record, sorted, type ExtensionContext, type ExtensionImplementation } from '../context.js';
import type { Element } from '../types.js';

export type FurnitureData = G.FSFurniture010;
export type Piece = Element<G.Piece>;
export type Appliance = Element<G.Appliance>;
export type Casework = Element<G.Casework>;
export type FurnitureElement = Piece | Appliance | Casework;

/** The kinds (collections) of FS_furniture (chapter 2). */
export const FURNITURE_KINDS = ['pieces', 'appliances', 'casework'] as const;
export type FurnitureKind = (typeof FURNITURE_KINDS)[number];

/** 2.5: how an item of each category is mounted. */
export type Mounting = 'floor' | 'wall' | 'builtIn';
const WALL = new Set(['shelf', 'wallCabinet', 'shelving']);
const BUILT_IN = new Set(['wallOven', 'cooktop', 'microwave']);
export const mounting = (category: string): Mounting => (WALL.has(category) ? 'wall' : BUILT_IN.has(category) ? 'builtIn' : 'floor');

/** 6.2: what FS_furniture derives for one element. */
export interface DerivedFurnitureItem {
  kind: FurnitureKind;
  category: string;
  width: number;
  depth: number;
  height: number;
  room?: string;
}

/** Chapter 6: what FS_furniture derives. */
export interface DerivedFurniture {
  items: Record<string, DerivedFurnitureItem>;
  rooms: Record<string, { items: string[]; floorArea: string }>;
  groups: Record<string, string[]>;
}

const MM = 1280;
type Form = 'front' | 'standing' | 'left' | 'right' | 'around';
/** 4.2: each category's default envelopes — name, purpose, form and distance in mm. */
const DEFAULTS: Record<string, readonly [string, ClearanceEnvelope['purpose'], Form, number][]> = {
  refrigerator: [['door', 'swing', 'front', 900]],
  freezer: [['door', 'swing', 'front', 900]],
  range: [['door', 'swing', 'front', 600]],
  wallOven: [['door', 'swing', 'front', 600]],
  dishwasher: [['door', 'swing', 'front', 700]],
  washer: [['door', 'swing', 'front', 700]],
  dryer: [['door', 'swing', 'front', 700]],
  sofa: [['front', 'access', 'standing', 600]],
  armchair: [['front', 'access', 'standing', 600]],
  desk: [['front', 'access', 'standing', 750]],
  diningTable: [['around', 'access', 'around', 750]],
  bed: [
    ['left', 'access', 'left', 600],
    ['right', 'access', 'right', 600],
  ],
  dresser: [['front', 'swing', 'front', 500]],
  sideboard: [['front', 'swing', 'front', 500]],
  wardrobe: [['front', 'swing', 'front', 600]],
  baseCabinet: [['front', 'swing', 'front', 600]],
  tallCabinet: [['front', 'swing', 'front', 600]],
  wallCabinet: [['front', 'swing', 'front', 400]],
  vanity: [['front', 'swing', 'front', 500]],
  island: [['front', 'workingSpace', 'standing', 1000]],
};

/** 4.2: the purpose of a category's default envelopes, for a category that has them. */
export const defaultPurpose = (category: string): ClearanceEnvelope['purpose'] | undefined => DEFAULTS[category]?.[0]?.[1];

/** 4.2: the default envelopes of an item of `category` with fallback box `box`, in its frame — `{}` for a category without any. */
export function defaultFurnitureEnvelopes(category: string, box: Box): Record<string, ClearanceEnvelope> {
  const out: Record<string, ClearanceEnvelope> = {};
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const top = Math.max(z1, z0 + 2000 * MM);
  for (const [name, purpose, form, mm] of DEFAULTS[category] ?? []) {
    const D = mm * MM;
    const [min, max]: [[number, number, number], [number, number, number]] =
      form === 'front'
        ? [[x1, y0, z0], [x1 + D, y1, z1]]
        : form === 'standing'
          ? [[x1, y0, z0], [x1 + D, y1, top]]
          : form === 'left'
            ? [[x0, y1, z0], [x1, y1 + D, top]]
            : form === 'right'
              ? [[x0, y0 - D, z0], [x1, y0, top]]
              : [[x0 - D, y0 - D, z0], [x1 + D, y1 + D, top]];
    out[name] = { purpose, shape: 'box', min, max };
  }
  return out;
}

function elements(ctx: ExtensionContext): [FurnitureKind, string, FurnitureElement][] {
  return FURNITURE_KINDS.flatMap((k) => ctx.coll<FurnitureElement>(k).map(([id, el]): [FurnitureKind, string, FurnitureElement] => [k, id, el]));
}

const own = (ctx: ExtensionContext): Map<string, FurnitureElement> => new Map(elements(ctx).map(([, id, el]) => [id, el]));

/** 4.3: one is with the other, or both are with the same element. */
function grouped(mine: ReadonlyMap<string, FurnitureElement>, a: string, b: string): boolean {
  const wa = mine.get(a)?.with;
  const wb = mine.get(b)?.with;
  return wa === b || wb === a || (wa !== undefined && wa === wb);
}

function invariants(ctx: ExtensionContext): void {
  const mine = own(ctx);
  for (const [id, el] of ctx.coll<Appliance>('appliances'))
    for (const c of el.connections ?? []) {
      const x = ctx.ext.get(c);
      if (!x || x.extension === 'FS_furniture') ctx.report('FS-FURN-INV-001', `${id}'s connection ${c} is not an element of another extension.`, [id]);
    }
  for (const [, id, el] of elements(ctx)) {
    if (el.with !== undefined) {
      const w = mine.get(el.with);
      if (el.with === id || !w || w.with !== undefined) ctx.report('FS-FURN-INV-002', `${id} is with ${el.with}, which is not another element of FS_furniture with nothing.`, [id]);
    }
    if (el.host?.mode === 'surface' && el.host.surface === 'ceiling') ctx.report('FS-FURN-INV-003', `${id} is hosted on a ceiling.`, [id]);
  }
}

/** 4.5: every element's footprint, as Core derives its fallback. */
function footprints(ctx: ExtensionContext): Map<string, Footprint> {
  return new Map(elements(ctx).map(([, id, el]) => [id, footprintOf(elementFrame(ctx.doc, ctx.analysis, el), el.fallback.box)]));
}

/** Core 13.5: every clearance envelope of an opening's type or of any extension's element, with its owner. */
function envelopes(ctx: ExtensionContext): [string, Footprint][] {
  const out: [string, Footprint][] = [];
  const doc = ctx.doc;
  for (const [oid, o] of entries(doc.openings)) {
    const t = o.fill === undefined ? undefined : get(doc.types, o.fill);
    const cl = t && t.kind !== 'wallType' ? entries(t.clearances) : [];
    if (!cl.length) continue;
    const frame = openingFrame(doc, oid);
    for (const [, env] of cl) out.push([oid, footprintOf(frame, env)]);
  }
  for (const x of extElements(doc)) {
    const cl = entries(x.element.clearances);
    if (!cl.length) continue;
    const frame = elementFrame(doc, ctx.analysis, x.element);
    for (const [, env] of cl) out.push([x.id, footprintOf(frame, env)]);
  }
  return out;
}

function lints(ctx: ExtensionContext): void {
  const mine = own(ctx);
  for (const [, id, el] of elements(ctx)) {
    const purpose = defaultPurpose(el.category);
    if (purpose && !ctx.hasPurpose(el, purpose)) ctx.report('FS-FURN-LINT-001', `${id} has no ${purpose} envelope, which a ${el.category} needs.`, [id]);
    if (el.host?.mode === 'wallFace' && el.fallback.box.min[0] < 0) ctx.report('FS-FURN-LINT-002', `${id}'s box reaches behind the wall face it is hosted on.`, [id]);
    if (mounting(el.category) === 'wall' && el.host?.mode !== 'wallFace') ctx.report('FS-FURN-LINT-003', `${id} is a ${el.category}, which hangs on a wall, and has no wallFace host.`, [id]);
  }
  const prints = footprints(ctx);
  for (const [owner, env] of envelopes(ctx))
    for (const [id, fp] of prints)
      if (id !== owner && !grouped(mine, owner, id) && envelopesOverlap(env, fp)) ctx.report('FS-FURN-LINT-004', `A clearance envelope of ${owner} runs into ${id}.`, [owner, id]);
  const ids = sorted(prints.keys());
  for (let i = 0; i < ids.length; i++)
    for (let k = i + 1; k < ids.length; k++) {
      const a = ids[i]!;
      const b = ids[k]!;
      if (!grouped(mine, a, b) && envelopesOverlap(prints.get(a)!, prints.get(b)!)) ctx.report('FS-FURN-LINT-005', `${a} and ${b} collide.`, [a, b]);
    }
}

function derive(ctx: ExtensionContext): DerivedFurniture {
  const rooms = ctx.rooms();
  const prints = footprints(ctx);
  const items: [string, DerivedFurnitureItem][] = [];
  const byRoom = new Map<string, string[]>();
  const area = new Map<string, bigint>();
  const groups = new Map<string, string[]>();
  for (const [kind, id, el] of elements(ctx)) {
    const b = el.fallback.box;
    const item: DerivedFurnitureItem = { kind, category: el.category, width: b.max[1] - b.min[1], depth: b.max[0] - b.min[0], height: b.max[2] - b.min[2] };
    const rid = rooms.get(id);
    if (rid !== undefined) {
      item.room = rid;
      byRoom.set(rid, [...(byRoom.get(rid) ?? []), id]);
      if (mounting(el.category) === 'floor')
        area.set(rid, (area.get(rid) ?? 0n) + area2(prints.get(id)!.footprint.map(([x, y]) => [BigInt(x), BigInt(y)] as const)));
    }
    items.push([id, item]);
    if (el.with !== undefined) groups.set(el.with, [...(groups.get(el.with) ?? []), id]);
  }
  return {
    items: record(items),
    rooms: record([...byRoom].map(([r, v]) => [r, { items: sorted(v), floorArea: halfString(area.get(r) ?? 0n) }])),
    groups: record([...groups].map(([g, v]) => [g, sorted(v)])),
  };
}

export const FS_FURNITURE: ExtensionImplementation<DerivedFurniture> = {
  name: 'FS_furniture',
  version: '0.1.0',
  code: 'FURN',
  catalogue: [
    { code: 'FS-FURN-SCH-001', severity: 'error', condition: 'the top-level data does not match the schema' },
    { code: 'FS-FURN-INV-001', severity: 'error', condition: "an appliance's connection is not an extension element of another extension; once for each such connection" },
    { code: 'FS-FURN-INV-002', severity: 'error', condition: 'a `with` is not another element of FS_furniture, or names one that has a `with`' },
    { code: 'FS-FURN-INV-003', severity: 'error', condition: 'an element hosted on a ceiling' },
    { code: 'FS-FURN-LINT-001', severity: 'warning', condition: "an element of a category with default envelopes (4.2) that has no clearance envelope of the category's purpose" },
    { code: 'FS-FURN-LINT-002', severity: 'warning', condition: 'an element with a `wallFace` host whose box\'s `min.x` is less than `0` (4.1)' },
    { code: 'FS-FURN-LINT-003', severity: 'info', condition: 'an element of a category mounted on a `wall` (2.5) without a `wallFace` host' },
    { code: 'FS-FURN-LINT-004', severity: 'warning', condition: 'a clearance envelope runs into an element of FS_furniture (4.5); once for each envelope and element' },
    { code: 'FS-FURN-LINT-005', severity: 'warning', condition: 'two elements of FS_furniture collide (4.5); once for each pair' },
  ],
  validate: (data) => validateSchema(data),
  invariants,
  lints,
  derive,
};
