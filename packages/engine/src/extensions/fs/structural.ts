/**
 * FS_structural 0.1.0 (registry/FS_structural/spec.md, Draft): bearing and shear flags, framing,
 * spans and headers recorded on walls, openings, slabs, rooms' floors and roofs — attributes for
 * handoff, never a structural design or a check of one (1.4). It adds no kind of element: its data is
 * each of those elements' own `extensions.FS_structural` (Core 12.7), checked as `{ <collection>: data }`
 * against the schema's `#/$defs/coreElements`.
 */
import { validate as validateTop } from '../../generated/validate-FS_structural.js';
import { validate as validateCore } from '../../generated/validate-FS_structural-core.js';
import { Surd } from '../../exact/surd.js';
import { effectiveLayers, entries, get, openingDimensions, wallElevations, type FloorspecDocument } from '../../model/document.js';
import { roomRings } from '../../slabs/floors.js';
import { record, sorted, type ExtensionContext, type ExtensionImplementation } from '../context.js';

const NAME = 'FS_structural';
/** 1.3: where its data may be. */
const DEFINED = ['walls', 'openings', 'slabs', 'rooms', 'roofs'] as const;
/** 1.3.3: every other collection whose elements have an `extensions` member. */
const OTHERS = ['buildings', 'levels', 'junctions', 'separators', 'types', 'materials', 'assets', 'stairs', 'optionSets', 'options'] as const;
const NO_MEMBERS = new Set(['solid', 'panels']);
const MEMBER_SYSTEMS = new Set(['studs', 'joists', 'rafters', 'trusses']);
const UNFRAMED = new Set(['concrete', 'concreteMasonry', 'masonry']);

type Json = Record<string, unknown>;
interface Member {
  width: number;
  depth: number;
}
interface Framing {
  material: string;
  system: string;
  member?: Member;
  spacing?: number;
}
interface Span {
  direction: [number, number];
  length?: number;
}

/** What FS_structural derives (chapter 5). */
export interface DerivedStructural {
  levels: Record<string, { bearing: string[]; shear: string[]; openings: string[] }>;
  spans: Record<string, { direction: [number, number]; extent: number; span: number }>;
  needsEngineer: string[];
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An element's own FS_structural data, when it has some. */
function dataOf(el: unknown): Json | undefined {
  const x = isObject(el) ? el['extensions'] : undefined;
  const v = isObject(x) ? x[NAME] : undefined;
  return isObject(v) ? v : undefined;
}

const has = (el: unknown): boolean => isObject(el) && isObject(el['extensions']) && Object.hasOwn(el['extensions'], NAME);

/** 1.3.1 to 1.3.3: the top-level data, the data on every element against #/$defs/coreElements, and none elsewhere. */
function validate(data: unknown, document?: unknown): boolean {
  if (!validateTop(data)) return false;
  if (!isObject(document)) return true;
  for (const c of DEFINED) {
    const coll = document[c];
    if (!isObject(coll)) continue;
    for (const el of Object.values(coll)) if (has(el) && !validateCore({ [c]: (el as { extensions: Json }).extensions[NAME] })) return false;
  }
  for (const c of OTHERS) {
    const coll = document[c];
    if (isObject(coll)) for (const el of Object.values(coll)) if (has(el)) return false;
  }
  const items = isObject(document['program']) ? document['program']['items'] : undefined;
  if (isObject(items)) for (const el of Object.values(items)) if (has(el)) return false;
  return true;
}

/** (collection, ID, data) of every element that carries FS_structural data, in a fixed order. */
function carriers(doc: FloorspecDocument): [(typeof DEFINED)[number], string, Json][] {
  const out: [(typeof DEFINED)[number], string, Json][] = [];
  for (const c of DEFINED)
    for (const [id, el] of entries(doc[c] as Record<string, unknown> | undefined)) {
      const v = dataOf(el);
      if (v !== undefined) out.push([c, id, v]);
    }
  return out;
}

function framings(doc: FloorspecDocument): [string, Framing][] {
  const out: [string, Framing][] = [];
  for (const [c, id, v] of carriers(doc)) {
    const f = c === 'rooms' ? (isObject(v['floor']) ? v['floor']['framing'] : undefined) : v['framing'];
    if (isObject(f)) out.push([id, f as unknown as Framing]);
  }
  return out;
}

function spans(doc: FloorspecDocument): ['slabs' | 'rooms', string, Span][] {
  const out: ['slabs' | 'rooms', string, Span][] = [];
  for (const [c, id, v] of carriers(doc)) {
    if (c !== 'rooms' && c !== 'slabs') continue;
    const s = c === 'rooms' ? (isObject(v['floor']) ? v['floor']['span'] : undefined) : v['span'];
    if (isObject(s)) out.push([c, id, s as unknown as Span]);
  }
  return out;
}

function invariants(ctx: ExtensionContext): void {
  for (const [id, f] of framings(ctx.doc)) {
    const inv1 = NO_MEMBERS.has(f.system) && (f.member !== undefined || f.spacing !== undefined);
    const inv3 = UNFRAMED.has(f.material) && MEMBER_SYSTEMS.has(f.system);
    if (inv1) ctx.report('FS-STRC-INV-001', `${id}'s ${f.system} framing has a member or a spacing.`, [id]);
    if (inv3) ctx.report('FS-STRC-INV-003', `${id}'s ${f.material} framing has a member system (${f.system}).`, [id]);
    if (!inv1 && !inv3 && f.member !== undefined && f.spacing !== undefined && f.spacing < f.member.width)
      ctx.report('FS-STRC-INV-002', `${id}'s framing spacing is less than its member's width.`, [id]);
  }
  for (const [, id, s] of spans(ctx.doc))
    if (s.direction[0] === 0 && s.direction[1] === 0) ctx.report('FS-STRC-INV-004', `${id}'s span has no direction.`, [id]);
}

const bearing = (doc: FloorspecDocument, wall: string): boolean => dataOf(get(doc.walls, wall))?.['bearing'] === true;

const thickness = (doc: FloorspecDocument, wall: string): number | undefined => {
  const w = get(doc.walls, wall);
  const layers = w === undefined ? undefined : effectiveLayers(doc, w);
  return layers === undefined ? undefined : layers.reduce((s, l) => s + l.thickness, 0);
};

/** 3.2: how far an outline reaches along a direction, exact and rounded once. */
export function extent(points: readonly (readonly [bigint, bigint])[], direction: readonly [number, number]): number {
  const dx = BigInt(direction[0]);
  const dy = BigInt(direction[1]);
  const proj = points.map((p) => p[0] * dx + p[1] * dy);
  let lo = proj[0]!;
  let hi = proj[0]!;
  for (const v of proj) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const n = dx * dx + dy * dy;
  return Number(Surd.sqrt(n).mulInt(hi - lo).divInt(n).round());
}

function outline(ctx: ExtensionContext, c: 'slabs' | 'rooms', id: string): (readonly [bigint, bigint])[] {
  if (c === 'slabs') return get(ctx.doc.slabs, id)!.boundary.map((p) => [BigInt(p[0]), BigInt(p[1])] as const);
  const room = get(ctx.doc.rooms, id)!;
  const la = ctx.analysis.levels.get(room.level)!;
  return roomRings(la.geometry!, la.roomFaces.get(id)!).outer;
}

function lints(ctx: ExtensionContext): void {
  const doc = ctx.doc;
  for (const [oid, o] of entries(doc.openings)) {
    const wid = o.wall;
    const h = dataOf(o)?.['header'] as { member: Member; plies?: number } | undefined;
    if (h === undefined) {
      if (bearing(doc, wid)) ctx.report('FS-STRC-LINT-001', `${oid} is in the bearing wall ${wid} and has no header.`, [oid, wid]);
      continue;
    }
    const t = thickness(doc, wid);
    if (t !== undefined && (h.plies ?? 1) * h.member.width > t) ctx.report('FS-STRC-LINT-002', `${oid}'s header is wider than ${wid} is thick.`, [oid, wid]);
    const dim = openingDimensions(doc, o);
    const el = wallElevations(doc, get(doc.walls, wid)!)!;
    const room = el.top - el.base - BigInt(dim.sill + (dim.height ?? 0));
    if (BigInt(h.member.depth) > room) ctx.report('FS-STRC-LINT-004', `${oid}'s header does not fit between its head and the top of ${wid}.`, [oid, wid]);
  }
  for (const [wid, w] of entries(doc.walls)) {
    const v = dataOf(w);
    if (v === undefined) continue;
    const f = v['framing'] as Framing | undefined;
    if (f !== undefined && f.system === 'studs' && f.member !== undefined) {
      const t = thickness(doc, wid);
      if (t !== undefined && f.member.depth > t) ctx.report('FS-STRC-LINT-003', `${wid}'s studs are deeper than it is thick.`, [wid]);
    }
    if (v['bearing'] === true && f === undefined) ctx.report('FS-STRC-LINT-006', `${wid} bears and says nothing of how it is framed.`, [wid]);
  }
  for (const [c, id, s] of spans(doc))
    if (s.length !== undefined && s.length > extent(outline(ctx, c, id), s.direction)) ctx.report('FS-STRC-LINT-005', `${id}'s span is longer than the outline reaches that way.`, [id]);
}

function derive(ctx: ExtensionContext): DerivedStructural {
  const doc = ctx.doc;
  const levels = entries(doc.levels).map(([lid]): [string, DerivedStructural['levels'][string]] => {
    const walls = entries(doc.walls).filter(([, w]) => w.level === lid).map(([id]) => id);
    const bear = walls.filter((w) => bearing(doc, w));
    const shear = walls.filter((w) => dataOf(get(doc.walls, w))?.['shear'] === true);
    const openings = entries(doc.openings).filter(([, o]) => bear.includes(o.wall)).map(([id]) => id);
    return [lid, { bearing: sorted(bear), shear: sorted(shear), openings: sorted(openings) }];
  });
  const sp = spans(doc).map(([c, id, s]): [string, DerivedStructural['spans'][string]] => {
    const e = extent(outline(ctx, c, id), s.direction);
    return [id, { direction: [s.direction[0], s.direction[1]], extent: e, span: s.length ?? e }];
  });
  return {
    levels: record(levels),
    spans: record(sp),
    needsEngineer: sorted(carriers(doc).filter(([, , v]) => v['needsEngineer'] === true).map(([, id]) => id)),
  };
}

export const FS_STRUCTURAL: ExtensionImplementation<DerivedStructural> = {
  name: NAME,
  version: '0.1.0',
  code: 'STRC',
  catalogue: [
    { code: 'FS-STRC-SCH-001', severity: 'error', condition: 'the top-level data, or the data on an element, does not match the schema, or an element that may not carry FS_structural data does' },
    { code: 'FS-STRC-INV-001', severity: 'error', condition: 'a solid or panel framing has a member or a spacing' },
    { code: 'FS-STRC-INV-002', severity: 'error', condition: "a framing's spacing is less than its member's width" },
    { code: 'FS-STRC-INV-003', severity: 'error', condition: 'a framing of concrete, concrete masonry or masonry has a member system' },
    { code: 'FS-STRC-INV-004', severity: 'error', condition: "a span's direction is `[0, 0]`" },
    { code: 'FS-STRC-LINT-001', severity: 'warning', condition: 'an opening in a wall whose `bearing` is `true` has no header (2.4)' },
    { code: 'FS-STRC-LINT-002', severity: 'warning', condition: 'a header is wider than its wall is thick (2.4)' },
    { code: 'FS-STRC-LINT-003', severity: 'warning', condition: "a wall's studs are deeper than the wall is thick" },
    { code: 'FS-STRC-LINT-004', severity: 'warning', condition: "a header does not fit between its opening's head and its wall's top" },
    { code: 'FS-STRC-LINT-005', severity: 'warning', condition: "a span's recorded `length` is longer than its extent (3.2)" },
    { code: 'FS-STRC-LINT-006', severity: 'info', condition: 'a wall whose `bearing` is `true` has no framing' },
  ],
  validate,
  invariants,
  lints,
  derive,
};
