/**
 * The inverse of a committed result (1.6): the structural difference from B back to A, as
 * primitives in the order the specification gives. Both documents are compared in their canonical
 * content (Core §9.2 step 1), so a member equal to its constant default is no difference.
 */
import { jsonEqual } from '@floorspec/engine';
import type { CollectionName } from './model/working.js';
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

/** The members of the document that are neither collections nor the project and site. */
const NOT_DOCUMENT = new Set<string>([...INVERSE_ORDER, 'project', 'site']);

export function inverseOf(aCanon: JsonObject, bCanon: JsonObject): ResolvedPrimitive[] {
  // The member changes of step 3 come first. In the order 1.6 lists, a removal of step 1 can be
  // blocked by an element still referring to what it removes — a wall split by normalization still
  // ends at the junction the split made — so 1.6.1 could not hold. The conformance suite's oracle
  // applies step 3 before steps 1 and 2, and so does this applier (reported on the specification).
  const members: ResolvedPrimitive[] = [];
  for (const c of INVERSE_ORDER) {
    const a = collectionOf(aCanon, c);
    const b = collectionOf(bCanon, c);
    for (const id of sortedKeys(a)) if (Object.hasOwn(b, id)) members.push(...memberDiff(id, a[id], b[id]));
  }
  const out: ResolvedPrimitive[] = [...members];
  // 1. Remove what B added.
  for (const c of INVERSE_ORDER) {
    const a = collectionOf(aCanon, c);
    for (const id of sortedKeys(collectionOf(bCanon, c))) if (!Object.hasOwn(a, id)) out.push({ op: 'removeElement', id });
  }
  // 2. Add back what B removed, in the reverse collection order, exactly as it is in A.
  for (const c of [...INVERSE_ORDER].reverse()) {
    const b = collectionOf(bCanon, c);
    const a = collectionOf(aCanon, c);
    for (const id of sortedKeys(a)) if (!Object.hasOwn(b, id)) out.push({ op: 'addElement', collection: c, id, element: clone(a[id]) as Record<string, unknown> });
  }
  // 4. The project, the site and the document's other top-level members.
  out.push(...memberDiff('$project', getMember(aCanon, 'project'), getMember(bCanon, 'project')));
  const sa = getMember(aCanon, 'site');
  const sb = getMember(bCanon, 'site');
  if (sa !== undefined && sb !== undefined) out.push(...memberDiff('$site', sa, sb));
  // A site that B lacks is set back whole, and one that A lacks is removed whole, as $document's
  // /site: unsetting every member of $site would leave an empty site, not none.
  else if (sa !== undefined) out.push({ op: 'setProperty', id: '$document', path: '/site', value: clone(sa) });
  else if (sb !== undefined) out.push({ op: 'unsetProperty', id: '$document', path: '/site' });
  out.push(...memberDiff('$document', aCanon, bCanon, NOT_DOCUMENT));
  return out;
}
