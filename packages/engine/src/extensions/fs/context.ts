/**
 * FS_context 0.1.0 (registry/FS_context/spec.md, FLR-ADR-064): what surrounds a house and is never part
 * of it — streets with their curbs, planting strips and sidewalks, neighbouring buildings as simple
 * massing, and trees beyond the lot. It adds no kind of element and requires no other extension: its
 * records are not elements, so nothing Core derives counts them (1.5). The IDs of FS_site's survey and
 * pads, FS_lighting's scenes, FS_views's views and FS_annotation's strings and notes are read from their
 * data as it is.
 *
 * Everything normative is exact: a gable's or hip's rectangle is tested with BigInt dot products, a
 * street's length is each segment's length rounded once, and a footprint's area is the shoelace's.
 */
import { validate as validateSchema } from '../../generated/validate-FS_context.js';
import type * as G from '../../generated/types-FS_context.js';
import { halfString } from '../../derive/derive.js';
import { isqrt, toSafeNumber } from '../../exact/bigint.js';
import { area2, isSimple, locate, type IPoint } from '../../geometry/predicates.js';
import { entries, ipoint, type FloorspecDocument } from '../../model/document.js';
import { record, type ExtensionContext, type ExtensionImplementation } from '../context.js';

export type ContextData = G.FSContext010;
export type Street = G.Street;
export type Neighbour = G.Neighbour;
export type ContextTree = G.Tree;
export type RoofForm = 'flat' | 'gable' | 'hip';
export type TreeForm = 'deciduous' | 'evergreen';

export const NAME = 'FS_context';
const P = (...path: (string | number)[]): string => '/extensions/FS_context/' + path.join('/');
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 2.1: a curb's width and height when a street does not say: 6″. */
export const CURB = 195_072;
/** 1.3: the three record maps. */
export const RECORDS = ['streets', 'neighbours', 'trees'] as const;
export type ContextMember = (typeof RECORDS)[number];

/** Chapter 8: what FS_context derives. */
export interface DerivedContext {
  streets: Record<string, { length: number; width: number }>;
  neighbours: Record<string, { roof: RoofForm; area: string; eaves: number; ridge: number }>;
  trees: Record<string, { form: TreeForm; top: number }>;
}

/** FS-CTXT-1.3: the IDs of the other extensions' records, read as data. */
function readAsData(doc: FloorspecDocument): Set<string> {
  const out = new Set<string>();
  const others = [
    ['FS_lighting', 'scenes'],
    ['FS_views', 'views'],
    ['FS_annotation', 'dimensions'],
    ['FS_annotation', 'notes'],
    ['FS_site', 'spots'],
    ['FS_site', 'contours'],
    ['FS_site', 'pads'],
  ] as const;
  for (const [name, member] of others) {
    const data = (doc.extensions as Json | undefined)?.[name];
    const m = isObject(data) ? data[member] : undefined;
    if (isObject(m)) for (const k of Object.keys(m)) out.add(k);
  }
  return out;
}

/** FS_context's top-level data of a document, or an empty object. */
export function contextData(doc: FloorspecDocument): Json {
  const d = (doc.extensions as Json | undefined)?.[NAME];
  return isObject(d) ? d : {};
}

/** Does this document use FS_context (declare it)? */
export const usesContext = (doc: FloorspecDocument): boolean => isObject(doc.extensionsUsed) && NAME in doc.extensionsUsed;

/** 3.2: four vertices, each corner a right angle — exactly. */
export function isRectangle(ring: readonly IPoint[]): boolean {
  if (ring.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = ring[(i + 3) % 4]!;
    const b = ring[i]!;
    const c = ring[(i + 1) % 4]!;
    if ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) !== 0n) return false;
  }
  return true;
}

/** 5.2: the points of a record that are tested against the lot. */
function pointsOf(member: ContextMember, r: Street | Neighbour | ContextTree): IPoint[] {
  if (member === 'streets') return (r as Street).points.map(ipoint);
  if (member === 'neighbours') return (r as Neighbour).boundary.map(ipoint);
  return [ipoint((r as ContextTree).at)];
}

const roundSqrt = (n: bigint): bigint => (isqrt(4n * n) + 1n) / 2n;

/** 8.2: a street's length — each segment's length rounded once — and its overall width. */
export function streetMeasures(s: Street): { length: number; width: number } {
  let length = 0n;
  for (let i = 1; i < s.points.length; i++) {
    const a = ipoint(s.points[i - 1]!);
    const b = ipoint(s.points[i]!);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    length += roundSqrt(dx * dx + dy * dy);
  }
  return { length: toSafeNumber(length), width: s.width + 2 * ((s.curb ?? CURB) + (s.strip ?? 0) + (s.sidewalk ?? 0)) };
}

/** 3.1: a neighbour's eaves and ridge, elevations. */
export function neighbourHeights(n: Neighbour): { eaves: number; ridge: number } {
  const eaves = (n.elevation ?? 0) + n.height;
  return { eaves, ridge: eaves + (n.rise ?? 0) };
}

// ── the extension ─────────────────────────────────────────────────────────────

function invariants(ctx: ExtensionContext): void {
  const taken = ctx.space();
  for (const id of readAsData(ctx.doc)) taken.add(id);
  const seen = new Set<string>();
  const bad = new Set<string>();
  for (const member of RECORDS)
    for (const [id] of ctx.records(member)) {
      if (taken.has(id) || seen.has(id)) bad.add(id);
      seen.add(id);
    }
  for (const id of [...bad].sort()) ctx.report('FS-CTXT-INV-001', `The ID ${id} of FS_context's context is also the ID of an element, a record of another extension or another of FS_context's records.`, [id]);
  for (const [id, s] of ctx.records<Street>('streets'))
    if (s.points.some((p, i) => i > 0 && p[0] === s.points[i - 1]![0] && p[1] === s.points[i - 1]![1])) ctx.report('FS-CTXT-INV-002', `Street ${id} repeats a point of its centreline.`, [id], P('streets', id, 'points'));
  for (const [id, n] of ctx.records<Neighbour>('neighbours')) {
    const ring = n.boundary.map(ipoint);
    if (!isSimple(ring) || area2(ring) === 0n) ctx.report('FS-CTXT-INV-003', `Neighbour ${id}'s footprint is not a simple polygon with an area.`, [id], P('neighbours', id, 'boundary'));
    else if ((n.roof === 'gable' || n.roof === 'hip') && !isRectangle(ring)) ctx.report('FS-CTXT-INV-004', `Neighbour ${id} has a ${n.roof} roof on a footprint that is not a rectangle: make it flat, or draw it as more than one neighbour.`, [id], P('neighbours', id, 'boundary'));
  }
}

function lints(ctx: ExtensionContext): void {
  const b = ctx.doc.site?.boundary;
  if (!Array.isArray(b)) return;
  const lot = b.map(ipoint);
  for (const member of RECORDS)
    for (const [id, r] of ctx.records<Street | Neighbour | ContextTree>(member))
      if (pointsOf(member, r).some((p) => locate(p, lot) === 'inside')) ctx.report('FS-CTXT-LINT-001', `${id} is context standing in the lot: context is what is beyond it. A tree the design keeps is a plant; a building on the lot is the design.`, [id]);
}

function derive(ctx: ExtensionContext): DerivedContext {
  return {
    streets: record(ctx.records<Street>('streets').map(([id, s]) => [id, streetMeasures(s)] as const)),
    neighbours: record(
      ctx.records<Neighbour>('neighbours').map(([id, n]) => {
        const a = area2(n.boundary.map(ipoint));
        return [id, { roof: n.roof ?? 'flat', area: halfString(a < 0n ? -a : a), ...neighbourHeights(n) }] as const;
      }),
    ),
    trees: record(ctx.records<ContextTree>('trees').map(([id, t]) => [id, { form: t.form ?? 'deciduous', top: (t.elevation ?? 0) + t.height }] as const)),
  };
}

export const FS_CONTEXT: ExtensionImplementation<DerivedContext> = {
  name: NAME,
  version: '0.1.0',
  code: 'CTXT',
  catalogue: [
    { code: 'FS-CTXT-SCH-001', severity: 'error', condition: 'the top-level data does not match the schema' },
    { code: 'FS-CTXT-INV-001', severity: 'error', condition: "a record's ID is the ID of an element, a program item, an extension element, a scene, a view, a dimension string, a note, a spot, a contour line or a pad, or of another of FS_context's records" },
    { code: 'FS-CTXT-INV-002', severity: 'error', condition: 'a street with two equal consecutive points' },
    { code: 'FS-CTXT-INV-003', severity: 'error', condition: "a neighbour's `boundary` that is not a simple polygon enclosing a positive area" },
    { code: 'FS-CTXT-INV-004', severity: 'error', condition: "a neighbour with a gable or a hip roof whose `boundary` is not a rectangle" },
    { code: 'FS-CTXT-LINT-001', severity: 'info', condition: 'the document has a lot, and a street, a neighbour or a tree stands in it' },
  ],
  validate: (data) => validateSchema(data),
  invariants,
  lints,
  derive,
};

/** Every context record of a document as it is written, by member and ID (for a drawing, the MCP, the editor). */
export function contextRecords(doc: FloorspecDocument): { streets: [string, Street][]; neighbours: [string, Neighbour][]; trees: [string, ContextTree][] } {
  const d = contextData(doc);
  return {
    streets: entries(d.streets as Record<string, Street> | undefined),
    neighbours: entries(d.neighbours as Record<string, Neighbour> | undefined),
    trees: entries(d.trees as Record<string, ContextTree> | undefined),
  };
}
