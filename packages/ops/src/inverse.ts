/**
 * The inverse of a committed result (1.6): the structural difference from B back to A, as
 * primitives in the order the specification gives. Both documents are compared in their canonical
 * content (Core §9.2 step 1), so a member equal to its constant default is no difference.
 */
import { jsonEqual } from '@floorspec/engine';
import { applyPrimitive } from './primitives.js';
import { atLeast02, extCollectionsOf, ITEMS, itemsOf, WorkingCopy, type CollectionName, type OpsVersion, type Place } from './model/working.js';
import type { ResolvedPrimitive } from './types.js';
import { clone, cmpStr, escapeToken, getMember, isObject, sortedKeys, type JsonObject } from './lib/json.js';

/** The collection order of 1.6 step 1. */
export const INVERSE_ORDER: readonly CollectionName[] = [
  'openings',
  'rooms',
  'slabs',
  'separators',
  'walls',
  'junctions',
  'levels',
  'buildings',
  'types',
  'materials',
  'assets',
];

const collectionOf = (doc: JsonObject, c: CollectionName): JsonObject => {
  const v = getMember(doc, c);
  return isObject(v) ? v : {};
};

/** setProperty / unsetProperty for each top-level member that differs, by member name (1.6 step 3). */
function memberDiff(id: string, a: unknown, b: unknown, skip: ReadonlySet<string> = new Set()): ResolvedPrimitive[] {
  const ao = isObject(a) ? a : {};
  const bo = isObject(b) ? b : {};
  const names = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].filter((n) => !skip.has(n)).sort(cmpStr);
  const out: ResolvedPrimitive[] = [];
  for (const n of names) {
    const inA = Object.hasOwn(ao, n);
    const inB = Object.hasOwn(bo, n);
    const path = `/${escapeToken(n)}`;
    if (inA && (!inB || !jsonEqual(ao[n], bo[n]))) out.push({ op: 'setProperty', id, path, value: clone(ao[n]) });
    else if (inB && !inA) out.push({ op: 'unsetProperty', id, path });
  }
  return out;
}

/** The document's own members step 4 compares (1.6): Ops 0.1's, and Ops 0.2's (the program too). */
const DOCUMENT_MEMBERS = ['floorspec', 'extensionsUsed', 'extensionsRequired', 'extensions', 'extras'] as const;

const pick = (o: unknown, names: readonly string[]): JsonObject => {
  const out: JsonObject = {};
  if (isObject(o)) for (const n of names) if (Object.hasOwn(o, n)) out[n] = o[n];
  return out;
};

/** 1.6 step 4: the project, the site and the document's other top-level members, A against `b`. */
function documentDiff(aCanon: JsonObject, b: JsonObject, ops: OpsVersion): ResolvedPrimitive[] {
  const out = memberDiff('$project', getMember(aCanon, 'project'), getMember(b, 'project'));
  const sa = getMember(aCanon, 'site');
  const sb = getMember(b, 'site');
  if (sa !== undefined && sb !== undefined) out.push(...memberDiff('$site', sa, sb));
  // A site that B lacks is set back whole, and one that A lacks is removed whole, as $document's
  // /site: unsetting every member of $site would leave an empty site, not none.
  else if (sa !== undefined) out.push({ op: 'setProperty', id: '$document', path: '/site', value: clone(sa) });
  else if (sb !== undefined) out.push({ op: 'unsetProperty', id: '$document', path: '/site' });
  const rest: string[] = [...DOCUMENT_MEMBERS];
  if (atLeast02(ops)) {
    const pa = getMember(aCanon, 'program');
    const pb = getMember(b, 'program');
    // Ops 0.2: when both have a program, its members are compared one by one.
    if (isObject(pa) && isObject(pb)) out.push(...memberDiff('$document', pa, pb).map((p) => ({ ...p, path: `/program${(p as { path: string }).path}` }) as ResolvedPrimitive));
    else rest.push('program');
  }
  out.push(...memberDiff('$document', pick(aCanon, rest), pick(b, rest)));
  return out;
}

export function inverseOf(aCanon: JsonObject, bCanon: JsonObject, ops: OpsVersion = '0.2'): ResolvedPrimitive[] {
  if (atLeast02(ops)) return inverse02(aCanon, bCanon);
  // 1. Property differences, by collection in the order of step 2 and by ID.
  const out: ResolvedPrimitive[] = [];
  for (const c of INVERSE_ORDER) {
    const a = collectionOf(aCanon, c);
    const b = collectionOf(bCanon, c);
    for (const id of sortedKeys(a)) if (Object.hasOwn(b, id)) out.push(...memberDiff(id, a[id], b[id]));
  }
  // 2. Remove what B added.
  for (const c of INVERSE_ORDER) {
    const a = collectionOf(aCanon, c);
    for (const id of sortedKeys(collectionOf(bCanon, c))) if (!Object.hasOwn(a, id)) out.push({ op: 'removeElement', id });
  }
  // 3. Add back what B removed, in the reverse collection order, exactly as it is in A.
  for (const c of [...INVERSE_ORDER].reverse()) {
    const b = collectionOf(bCanon, c);
    const a = collectionOf(aCanon, c);
    for (const id of sortedKeys(a)) if (!Object.hasOwn(b, id)) out.push({ op: 'addElement', collection: c, id, element: clone(a[id]) as Record<string, unknown> });
  }
  // 4. The project, the site and the document's other top-level members.
  out.push(...documentDiff(aCanon, bCanon, '0.1'));
  return out;
}

/** Ops 0.2, 1.6 step 2's order: program items before levels; Ops 0.3's roofs and then stairs after slabs (a 0.2 document has neither). */
const INVERSE_ORDER_02: readonly (CollectionName | typeof ITEMS)[] = ['openings', 'rooms', 'slabs', 'roofs', 'stairs', 'separators', 'walls', 'junctions', ITEMS, 'levels', 'buildings', 'types', 'materials', 'assets'];

const placeKey = (p: Place): string => (p.kind === 'ext' ? `ext\u0000${p.extension}\u0000${p.collection}` : p.kind);

/** The elements of a document at a place (Ops 0.2). */
function elementsAt(doc: JsonObject, p: Place): JsonObject {
  if (p.kind === ITEMS) return itemsOf(doc, '0.2');
  if (p.kind === 'ext') return extCollectionsOf(doc, '0.2').find((c) => c.extension === p.extension && c.collection === p.collection)?.elements ?? {};
  return collectionOf(doc, p.kind);
}

/**
 * 1.6 in Ops 0.2: program items and extension elements are elements — extension collections first,
 * by extension and collection name — and step 4 compares A with the document that applying steps
 * 1 to 3 to B leaves, as it is (not in canonical form), so the empty objects they leave behind are
 * removed too and a 0.1 document comes back without a program its draft does not have.
 */
function inverse02(aCanon: JsonObject, bCanon: JsonObject): ResolvedPrimitive[] {
  const exts = new Map<string, Place>();
  for (const doc of [aCanon, bCanon])
    for (const c of extCollectionsOf(doc, '0.2')) {
      const p: Place = { kind: 'ext', extension: c.extension, collection: c.collection };
      exts.set(placeKey(p), p);
    }
  const extPlaces = [...exts.values()].sort((x, y) => {
    const a = x as Extract<Place, { kind: 'ext' }>;
    const b = y as Extract<Place, { kind: 'ext' }>;
    return cmpStr(a.extension, b.extension) || cmpStr(a.collection, b.collection);
  });
  const places: Place[] = [...extPlaces, ...INVERSE_ORDER_02.map((k): Place => ({ kind: k }))];
  const out: ResolvedPrimitive[] = [];
  for (const p of places) {
    const a = elementsAt(aCanon, p);
    const b = elementsAt(bCanon, p);
    for (const id of sortedKeys(a)) if (Object.hasOwn(b, id)) out.push(...memberDiff(id, a[id], b[id]));
  }
  for (const p of places) {
    const a = elementsAt(aCanon, p);
    for (const id of sortedKeys(elementsAt(bCanon, p))) if (!Object.hasOwn(a, id)) out.push({ op: 'removeElement', id });
  }
  for (const p of [...places].reverse()) {
    const a = elementsAt(aCanon, p);
    const b = elementsAt(bCanon, p);
    for (const id of sortedKeys(a))
      if (!Object.hasOwn(b, id)) {
        const element = clone(a[id]) as Record<string, unknown>;
        out.push(p.kind === 'ext' ? { op: 'addElement', extension: p.extension, collection: p.collection, id, element } : { op: 'addElement', collection: p.kind, id, element });
      }
  }
  // B': what steps 1 to 3 leave.
  const wc = new WorkingCopy(clone(bCanon), [], '0.2');
  for (const p of out) applyPrimitive(wc, p, { op: '', id: '' });
  out.push(...documentDiff(aCanon, wc.doc, '0.2'));
  return out;
}
