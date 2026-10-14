/**
 * FS_renovation 0.1.0 (registry/FS_renovation/spec.md, Draft, FLR-ADR-048): a remodel — each
 * element's renovation status, `existing` (the default), `demolish` or `new`, and the house's two
 * states, as it stands and when the work is done, each a view of the document that must be a valid
 * Core document. It adds no kind of element: a wall's, separator's, opening's, room's, slab's,
 * roof's or stair's status is its own `extensions.FS_renovation.status` (checked as
 * `{ <collection>: data }` against the schema's `#/$defs/coreElements`); an extension element's is
 * the member of the top-level `elements` named by its ID.
 *
 * Besides the extension, this module is what every view of a remodel reads: `statusOf`,
 * `renovationStatuses`, `stateView` and the filters' styles (`filterStyle`, chapter 3).
 */
import { validate as validateTop } from '../../generated/validate-FS_renovation.js';
import { validate as validateCore } from '../../generated/validate-FS_renovation-core.js';
import { isqrt, toSafeNumber } from '../../exact/bigint.js';
import { polylineLength } from '../../geometry/arcs.js';
import { COLLECTIONS, entries, extElements, get, programItems, wallArc, type FloorspecDocument } from '../../model/document.js';
import { references } from '../../validate/references.js';
import { invariants as coreInvariants, Reporter, type Analysis } from '../../validate/invariants.js';
import { record, sorted, type ExtensionContext, type ExtensionImplementation } from '../context.js';

const NAME = 'FS_renovation';
/** 1.3: the collections whose elements carry their status on themselves. */
export const RENOVATION_COLLECTIONS = ['walls', 'separators', 'openings', 'rooms', 'slabs', 'roofs', 'stairs'] as const;
/** 1.3.3: every other collection whose elements have an `extensions` member. */
const OTHERS = ['buildings', 'levels', 'junctions', 'types', 'materials', 'assets', 'optionSets', 'options'] as const;

/** 2.1: an element's renovation status. */
export type RenovationStatus = 'existing' | 'demolish' | 'new';
export const RENOVATION_STATUSES: readonly RenovationStatus[] = ['existing', 'demolish', 'new'];
/** 2.2: the two states. */
export type RenovationState = 'existing' | 'proposed';
/** 3.1: the four filters. */
export type RenovationFilter = 'existing' | 'demolition' | 'proposed' | 'combined';
export const RENOVATION_FILTERS: readonly RenovationFilter[] = ['existing', 'demolition', 'proposed', 'combined'];
/** 3.1: how a filter draws an element. */
export type RenovationStyle = 'plain' | 'existing' | 'demolished' | 'new' | 'hidden';

const IN_STATE: Record<RenovationState, readonly RenovationStatus[]> = { existing: ['existing', 'demolish'], proposed: ['existing', 'new'] };

/** 3.1's table: the style each filter draws each status in. */
const STYLES: Record<RenovationFilter, Record<RenovationStatus, RenovationStyle>> = {
  existing: { existing: 'plain', demolish: 'plain', new: 'hidden' },
  demolition: { existing: 'existing', demolish: 'demolished', new: 'hidden' },
  proposed: { existing: 'existing', demolish: 'hidden', new: 'new' },
  combined: { existing: 'existing', demolish: 'demolished', new: 'new' },
};

/** 3.1: how `filter` draws an element of `status`. */
export const filterStyle = (filter: RenovationFilter, status: RenovationStatus): RenovationStyle => STYLES[filter][status];

/** 3.1: the state whose rooms and areas a filter shows; undefined for `combined` (the document's own). */
export const filterState = (filter: RenovationFilter): RenovationState | undefined =>
  filter === 'proposed' ? 'proposed' : filter === 'combined' ? undefined : 'existing';

/** What FS_renovation derives (chapter 5). */
export interface RenovationQuantities {
  walls: number;
  wallLength: number;
  separators: number;
  openings: number;
  rooms: number;
  slabs: number;
  slabArea: string;
  roofs: number;
  stairs: number;
  elements: number;
}
export interface DerivedRenovation {
  status: Record<RenovationStatus, string[]>;
  quantities: Record<RenovationStatus, RenovationQuantities>;
  states: Record<RenovationState, { rooms: Record<string, string>; area: string }>;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStatus = (v: unknown): v is RenovationStatus => v === 'existing' || v === 'demolish' || v === 'new';

const has = (el: unknown): boolean => isObject(el) && isObject(el['extensions']) && Object.hasOwn(el['extensions'], NAME);

/** An element's own status, when it records one. */
function ownStatus(el: unknown): RenovationStatus | undefined {
  const x = isObject(el) ? el['extensions'] : undefined;
  const v = isObject(x) ? x[NAME] : undefined;
  const s = isObject(v) ? v['status'] : undefined;
  return isStatus(s) ? s : undefined;
}

/** The top-level `elements`: extension elements' statuses by ID. */
function topElements(doc: FloorspecDocument): Json {
  const data = (doc.extensions as Json | undefined)?.[NAME];
  const els = isObject(data) ? data['elements'] : undefined;
  return isObject(els) ? els : {};
}

/** Does the document use FS_renovation (declare it in `extensionsUsed`)? */
export const usesRenovation = (doc: FloorspecDocument): boolean => isObject(doc.extensionsUsed) && Object.hasOwn(doc.extensionsUsed, NAME);

/**
 * 2.1: the status of every element that has one — the seven collections' and every extension
 * element's — by ID; `existing` where none is recorded. An element without a status (a junction, a
 * level) is not in the map.
 */
export function renovationStatuses(doc: FloorspecDocument): Map<string, RenovationStatus> {
  const out = new Map<string, RenovationStatus>();
  for (const c of RENOVATION_COLLECTIONS)
    for (const [id, el] of entries(doc[c] as Record<string, unknown> | undefined)) out.set(id, ownStatus(el) ?? 'existing');
  const top = topElements(doc);
  for (const x of extElements(doc)) {
    const s = top[x.id];
    out.set(x.id, isStatus(s) ? s : 'existing');
  }
  return out;
}

/** 2.1: one element's status; undefined for an element that has none (a junction, a level, nothing). */
export function statusOf(doc: FloorspecDocument, id: string): RenovationStatus | undefined {
  for (const c of RENOVATION_COLLECTIONS) {
    const el = get(doc[c] as Record<string, unknown> | undefined, id);
    if (el !== undefined) return ownStatus(el) ?? 'existing';
  }
  if (extElements(doc).some((x) => x.id === id)) {
    const s = topElements(doc)[id];
    return isStatus(s) ? s : 'existing';
  }
  return undefined;
}

/**
 * 2.2: the view of a state — the document with every element not in the state removed, and every
 * junction's join through a removed wall removed. The document itself is not changed.
 */
export function stateView(doc: FloorspecDocument, state: RenovationState): FloorspecDocument {
  const st = renovationStatuses(doc);
  const gone = new Set([...st].filter(([, s]) => !IN_STATE[state].includes(s)).map(([id]) => id));
  if (gone.size === 0) return doc;
  const v = structuredClone(doc) as FloorspecDocument & Json;
  const keep = (coll: unknown): Json => Object.fromEntries(Object.entries(coll as Json).filter(([id]) => !gone.has(id)));
  for (const c of RENOVATION_COLLECTIONS) if (isObject(v[c])) (v as Json)[c] = keep(v[c]);
  for (const data of Object.values((v.extensions ?? {}) as Json)) {
    if (!isObject(data) || !isObject(data['collections'])) continue;
    const cs = data['collections'];
    for (const [name, coll] of Object.entries(cs)) if (isObject(coll)) cs[name] = keep(coll);
  }
  for (const j of Object.values((v.junctions ?? {}) as Record<string, { join?: { kind: string; through?: string[] } }>))
    if (j.join?.kind === 'butt' && (j.join.through ?? []).some((w) => gone.has(w))) delete j.join;
  return v;
}

/**
 * A state as a plain document to draw, export or measure (3.1): the view of the state (2.2) with
 * FS_renovation's declaration and its data — top-level and on every element — left out, so that a
 * reader that implements FS_renovation reads it as the house it is, with nothing left to renovate.
 */
export function stateDocument(doc: FloorspecDocument, state: RenovationState): FloorspecDocument {
  const without = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([k]) => k !== NAME));
  const v = structuredClone(stateView(doc, state)) as FloorspecDocument & Json;
  if (isObject(v.extensionsUsed)) (v as Json)['extensionsUsed'] = without(v.extensionsUsed);
  if (Array.isArray(v.extensionsRequired)) (v as Json)['extensionsRequired'] = v.extensionsRequired.filter((n) => n !== NAME);
  if (isObject(v.extensions)) (v as Json)['extensions'] = without(v.extensions);
  for (const c of RENOVATION_COLLECTIONS) {
    const coll = v[c] as Record<string, Json> | undefined;
    if (!isObject(coll)) continue;
    for (const [id, el] of Object.entries(coll)) {
      const x = el['extensions'];
      if (!isObject(x) || !Object.hasOwn(x, NAME)) continue;
      const rest = without(x);
      coll[id] = Object.keys(rest).length === 0 ? Object.fromEntries(Object.entries(el).filter(([k]) => k !== 'extensions')) : { ...el, extensions: rest };
    }
  }
  return v;
}

/** 1.3.1 to 1.3.3: the top-level data, the data on every element against #/$defs/coreElements, and none elsewhere. */
function validate(data: unknown, document?: unknown): boolean {
  if (!validateTop(data)) return false;
  if (!isObject(document)) return true;
  for (const c of RENOVATION_COLLECTIONS) {
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

/** 2.4: the errors Core reports of a state's view, as a document of its draft without known extensions. */
function viewErrors(view: FloorspecDocument, analysis: Analysis): { code: string; elements: string[] }[] {
  const r = new Reporter();
  coreInvariants(view, r, { core02: analysis.core02, core03: analysis.core03, core04: analysis.core04 ?? false });
  return r.diagnostics.filter((d) => d.severity === 'error');
}

function invariants(ctx: ExtensionContext): void {
  const doc = ctx.doc;
  const core = new Set<string>();
  for (const c of COLLECTIONS) for (const [id] of entries(doc[c] as Record<string, unknown> | undefined)) core.add(id);
  for (const [id] of programItems(doc)) core.add(id);
  for (const id of sorted(Object.keys(topElements(doc))))
    if (core.has(id)) ctx.report('FS-RENO-INV-001', `elements gives ${id} a status, but ${id} is not an extension element: a core element's status is on the element.`, [id], `/extensions/${NAME}/elements/${id}`);
  const st = renovationStatuses(doc);
  const seen = new Set<string>();
  let crossed = false;
  for (const ref of references(doc)) {
    if (ref.owner === undefined) continue;
    const a = st.get(ref.owner);
    const b = st.get(ref.target);
    const key = `${ref.owner}\u0000${ref.target}`;
    if (a === undefined || b === undefined || seen.has(key)) continue;
    if ((Object.keys(IN_STATE) as RenovationState[]).some((s) => IN_STATE[s].includes(a) && !IN_STATE[s].includes(b))) {
      seen.add(key);
      crossed = true;
      ctx.report('FS-RENO-INV-002', `${ref.owner} (${a}) refers to ${ref.target} (${b}), which a state that has ${ref.owner} does not have.`, [ref.owner, ref.target]);
    }
  }
  if (crossed) return;
  for (const [state, code] of [['existing', 'FS-RENO-INV-003'], ['proposed', 'FS-RENO-INV-004']] as const)
    for (const d of viewErrors(stateView(doc, state), ctx.analysis))
      ctx.report(code, `The ${state} state is not a valid house: ${d.code} of ${d.elements.join(', ') || 'the document'}.`, d.elements);
}

function lints(ctx: ExtensionContext): void {
  for (const s of renovationStatuses(ctx.doc).values()) if (s !== 'existing') return;
  ctx.report('FS-RENO-LINT-001', 'The document uses FS_renovation and no element is to be demolished or new.', []);
}

/** 5.3: a straight wall's exact length rounded once; an arc wall's length L (Core 21.5). */
export function wallLength(doc: FloorspecDocument, id: string): number {
  const arc = wallArc(doc, id);
  if (arc && arc !== 'unfit') return toSafeNumber(polylineLength(arc));
  const w = get(doc.walls, id)!;
  const a = get(doc.junctions, w.start)!.position;
  const b = get(doc.junctions, w.end)!.position;
  const dx = BigInt(b[0] - a[0]);
  const dy = BigInt(b[1] - a[1]);
  const n = dx * dx + dy * dy;
  const k = isqrt(n);
  return toSafeNumber(n - k * k > k ? k + 1n : k);
}

/** Half of a BigInt, as a decimal string (Core 6.4). */
const half = (twice: bigint): string => `${twice / 2n}${twice % 2n === 1n ? '.5' : ''}`;
const twice = (s: string): bigint => (s.endsWith('.5') ? BigInt(s.slice(0, -2)) * 2n + 1n : BigInt(s) * 2n);

function shoelace2(ring: readonly (readonly [number, number])[]): bigint {
  let s = 0n;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    s += BigInt(p[0]) * BigInt(q[1]) - BigInt(q[0]) * BigInt(p[1]);
  }
  return s < 0n ? -s : s;
}

/** 5.4: every room of a view, by ID, with its net area — from the view's own analysis. */
export function stateRooms(view: FloorspecDocument, analysis: Analysis): Record<string, string> {
  const r = new Reporter();
  const a = coreInvariants(view, r, { core02: analysis.core02, core03: analysis.core03, core04: analysis.core04 ?? false });
  const out: [string, string][] = [];
  if (a === undefined) return {};
  for (const la of a.levels.values()) {
    const g = la.geometry;
    if (!g) continue;
    for (const [rid, face] of la.roomFaces) out.push([rid, half(g.roomPolygon(g.faces[face]!).area2)]);
  }
  return record(out);
}

function derive(ctx: ExtensionContext): DerivedRenovation {
  const doc = ctx.doc;
  const st = renovationStatuses(doc);
  const status = Object.fromEntries(RENOVATION_STATUSES.map((s) => [s, sorted([...st].filter(([, x]) => x === s).map(([id]) => id))])) as Record<RenovationStatus, string[]>;
  const ext = extElements(doc);
  const quantities = Object.fromEntries(
    RENOVATION_STATUSES.map((s) => {
      const of = (c: string): string[] => entries(doc[c as keyof FloorspecDocument] as Record<string, unknown> | undefined).map(([id]) => id).filter((id) => st.get(id) === s);
      const walls = of('walls');
      const q: RenovationQuantities = {
        walls: walls.length,
        wallLength: walls.reduce((n, id) => n + wallLength(doc, id), 0),
        separators: of('separators').length,
        openings: of('openings').length,
        rooms: of('rooms').length,
        slabs: of('slabs').length,
        slabArea: half(of('slabs').reduce((n, id) => n + shoelace2(get(doc.slabs, id)!.boundary), 0n)),
        roofs: of('roofs').length,
        stairs: of('stairs').length,
        elements: ext.filter((x) => st.get(x.id) === s).length,
      };
      return [s, q];
    }),
  ) as Record<RenovationStatus, RenovationQuantities>;
  const states = Object.fromEntries(
    (['existing', 'proposed'] as const).map((state) => {
      const rooms = stateRooms(stateView(doc, state), ctx.analysis);
      return [state, { rooms, area: half(Object.values(rooms).reduce((n, a) => n + twice(a), 0n)) }];
    }),
  ) as DerivedRenovation['states'];
  return { status, quantities, states };
}

export const FS_RENOVATION: ExtensionImplementation<DerivedRenovation> = {
  name: NAME,
  version: '0.1.0',
  code: 'RENO',
  catalogue: [
    { code: 'FS-RENO-SCH-001', severity: 'error', condition: 'the top-level data, or the data on an element, does not match the schema, or an element that may not carry FS_renovation data does' },
    { code: 'FS-RENO-INV-001', severity: 'error', condition: 'an ID in `elements` is the ID of an element of a core collection or of a program item' },
    { code: 'FS-RENO-INV-002', severity: 'error', condition: 'an element that has a status refers to an element that has a status and is not in a state the first is in' },
    { code: 'FS-RENO-INV-003', severity: 'error', condition: 'the view of the existing state breaks a Core invariant' },
    { code: 'FS-RENO-INV-004', severity: 'error', condition: 'the view of the proposed state breaks a Core invariant' },
    { code: 'FS-RENO-LINT-001', severity: 'info', condition: 'no element has the status "demolish" or "new"' },
  ],
  validate,
  invariants,
  lints,
  derive,
};
