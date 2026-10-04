/**
 * The five primitives and three shorthands (chapter 2), applied to the working copy. Each changes it
 * in exactly one way, or fails the batch.
 */
import { fail } from './diagnostics.js';
import { COLLECTIONS, type CollectionName, type WorkingCopy } from './model/working.js';
import type { ResolvedPrimitive } from './types.js';
import { clone, cmpStr, deleteMember, getMember, isObject, parsePointer, setMember, type JsonObject } from './lib/json.js';

/** The collection and element an add primitive (or shorthand) adds (2.1.2). */
export function addTarget(p: Extract<ResolvedPrimitive, { op: 'addElement' | 'addJunction' | 'addWall' | 'addSeparator' }>): { collection: CollectionName; element: unknown } {
  switch (p.op) {
    case 'addElement':
      return { collection: p.collection, element: p.element };
    case 'addJunction':
    case 'addWall':
    case 'addSeparator': {
      const element: JsonObject = {};
      for (const k of Object.keys(p)) if (k !== 'op' && k !== 'id') setMember(element, k, (p as unknown as JsonObject)[k]);
      return { collection: p.op === 'addJunction' ? 'junctions' : p.op === 'addWall' ? 'walls' : 'separators', element };
    }
  }
}

/** Apply one resolved primitive. `ptr` points at the request member a failure is reported on. */
export function applyPrimitive(wc: WorkingCopy, p: ResolvedPrimitive, ptr: { op: string; id: string }): void {
  switch (p.op) {
    case 'addElement':
    case 'addJunction':
    case 'addWall':
    case 'addSeparator': {
      // 2.1.1: fail only when the ID is in use (1.5.2); never check the content.
      if (wc.unavailable(p.id))
        fail('FS-OPS-005', `${p.id} is ${wc.exists(p.id) ? 'already used in this document' : 'retired: it once named an element of this document'}`, [], ptr.id);
      const { collection, element } = addTarget(p);
      setMember(wc.ensureCollection(collection), p.id, clone(element));
      wc.touch();
      return;
    }
    case 'removeElement':
      removeElement(wc, p.id, p.cascade === true, ptr.id);
      return;
    case 'setProperty':
      setProperty(wc, p.id, p.path, p.value, ptr.op);
      return;
    case 'unsetProperty':
      unsetProperty(wc, p.id, p.path, ptr.op);
      return;
    case 'moveJunction':
      // 2.4.1: exactly setProperty of /position.
      setProperty(wc, p.id, '/position', p.to, ptr.op);
      return;
  }
}

// ── 2.2 removeElement ─────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** IDs in a collection whose element satisfies a test, sorted. */
function where(wc: WorkingCopy, c: CollectionName, test: (e: JsonObject) => boolean): string[] {
  return wc.ids(c).filter((id) => {
    const e = wc.elementIn(c, id);
    return e !== undefined && test(e);
  });
}

const layerMaterials = (e: JsonObject): unknown[] => {
  const layers = getMember(e, 'layers');
  return Array.isArray(layers) ? layers.map((l) => getMember(l, 'material')) : [];
};

/** Every element that refers to a type, material or asset (2.2: they block its removal). */
function referrers(wc: WorkingCopy, id: string, c: CollectionName): string[] {
  switch (c) {
    case 'types':
      return [...where(wc, 'walls', (e) => getMember(e, 'type') === id), ...where(wc, 'openings', (e) => getMember(e, 'fill') === id)];
    case 'materials':
      return [
        ...where(wc, 'walls', (e) => layerMaterials(e).includes(id)),
        ...where(wc, 'types', (e) => layerMaterials(e).includes(id)),
        ...where(wc, 'rooms', (e) => ['wallFinish', 'floorFinish', 'ceilingFinish'].some((m) => getMember(e, m) === id)),
        ...where(wc, 'slabs', (e) => getMember(e, 'material') === id),
      ];
    case 'assets':
      return where(wc, 'materials', (e) => getMember(getMember(e, 'texture'), 'asset') === id);
    default:
      return [];
  }
}

/** What removing an element would leave pointing at nothing: the "Blocks, otherwise" column of 2.2. */
function blockers(wc: WorkingCopy, id: string, c: CollectionName): string[] {
  switch (c) {
    case 'buildings':
      return where(wc, 'levels', (e) => getMember(e, 'building') === id);
    case 'levels': {
      const on = (['junctions', 'walls', 'separators', 'rooms', 'slabs'] as const).flatMap((k) => where(wc, k, (e) => getMember(e, 'level') === id));
      const vertical = where(wc, 'walls', (e) => getMember(getMember(e, 'base'), 'level') === id || getMember(getMember(e, 'top'), 'level') === id);
      return [...new Set([...on, ...vertical])];
    }
    case 'junctions':
      return (['walls', 'separators'] as const).flatMap((k) => where(wc, k, (e) => getMember(e, 'start') === id || getMember(e, 'end') === id));
    case 'walls':
      return where(wc, 'openings', (e) => getMember(e, 'wall') === id);
    default:
      return [];
  }
}

/** What removing an element takes with it when `cascade` is true: the "Takes with it" column of 2.2. */
function takes(wc: WorkingCopy, id: string, c: CollectionName): string[] {
  switch (c) {
    case 'buildings':
      return where(wc, 'levels', (e) => getMember(e, 'building') === id);
    case 'levels': {
      const on = (['junctions', 'walls', 'separators', 'rooms', 'slabs'] as const).flatMap((k) => where(wc, k, (e) => getMember(e, 'level') === id));
      const walls = new Set(where(wc, 'walls', (e) => getMember(e, 'level') === id));
      return [...on, ...where(wc, 'openings', (e) => walls.has(str(getMember(e, 'wall')) ?? ''))];
    }
    case 'junctions':
    case 'walls':
      return blockers(wc, id, c);
    default:
      return [];
  }
}

export function removeElement(wc: WorkingCopy, id: string, cascade: boolean, ptr: string): void {
  const c = wc.collectionOf(id);
  if (!c) return fail('FS-OPS-003', `there is no element ${id} to remove`, [], ptr);
  if (c === 'types' || c === 'materials' || c === 'assets') {
    const refs = referrers(wc, id, c);
    if (refs.length) fail('FS-OPS-006', `${id} cannot be removed while ${refs.join(', ')} refer to it`, [id, ...refs], ptr);
  } else if (!cascade) {
    const b = blockers(wc, id, c);
    if (b.length) fail('FS-OPS-006', `${id} cannot be removed while ${b.join(', ')} depend on it; remove them first, or use cascade`, [id, ...b], ptr);
  }
  // The elements to remove: id, and with cascade what it takes with it, transitively (2.2.2).
  const gone = new Map<string, CollectionName>([[id, c]]);
  if (cascade) {
    const work = [id];
    while (work.length) {
      const x = work.pop()!;
      for (const y of takes(wc, x, gone.get(x)!))
        if (!gone.has(y)) {
          gone.set(y, wc.collectionOf(y)!);
          work.push(y);
        }
    }
  }
  for (const [x, cx] of gone) deleteMember(wc.collection(cx)!, x);
  // A wall is always removed from join.through, which unsets that join (2.2).
  const goneWalls = new Set([...gone].filter(([, cx]) => cx === 'walls').map(([x]) => x));
  if (goneWalls.size)
    for (const j of wc.ids('junctions')) {
      const e = wc.elementIn('junctions', j);
      const through = getMember(getMember(e, 'join'), 'through');
      if (e && Array.isArray(through) && through.some((w) => typeof w === 'string' && goneWalls.has(w))) deleteMember(e, 'join');
    }
  wc.touch();
}

// ── 2.3 setProperty and unsetProperty ─────────────────────────────────────────

/** The object a setProperty/unsetProperty addresses: an element, or $project, $site, $document. */
function target(wc: WorkingCopy, id: string, create: boolean, ptr: string): JsonObject {
  if (id === '$document') return wc.doc;
  if (id === '$project') {
    const p = getMember(wc.doc, 'project');
    if (!isObject(p)) return fail('FS-OPS-003', 'the document has no project', [], ptr);
    return p;
  }
  if (id === '$site') {
    const s = getMember(wc.doc, 'site');
    if (isObject(s)) return s;
    if (s === undefined && create) {
      // 2.3: setting a member of $site creates the site if the project has none.
      const site: JsonObject = {};
      setMember(wc.doc, 'site', site);
      return site;
    }
    return fail('FS-OPS-003', 'the project has no site', [], ptr);
  }
  const c = wc.collectionOf(id);
  if (!c) return fail('FS-OPS-003', `there is no element ${id}`, [], ptr);
  const e = wc.collection(c)![id];
  if (!isObject(e)) return fail('FS-OPS-003', `${id} is not an object, so it has no members`, [id], ptr);
  return e;
}

function tokensOf(id: string, path: string, ptr: string): string[] {
  const tokens = parsePointer(path);
  if (tokens === undefined) return fail('FS-OPS-003', `${JSON.stringify(path)} is not a JSON Pointer`, [], ptr);
  if (tokens.length === 0) return fail('FS-OPS-003', 'the path is empty: it must name a member', [], ptr);
  if (id === '$document' && (COLLECTIONS as readonly string[]).includes(tokens[0]!))
    fail('FS-OPS-003', `$document addresses the document's members other than its collections; ${tokens[0]} is a collection`, [], ptr);
  return tokens;
}

const arrayIndex = (t: string, length: number, allowEnd: boolean): number | undefined => {
  if (t === '-' && allowEnd) return length;
  if (!/^(0|[1-9][0-9]*)$/.test(t)) return undefined;
  const i = Number(t);
  return i < length || (allowEnd && i === length) ? i : undefined;
};

export function setProperty(wc: WorkingCopy, id: string, path: string, value: unknown, ptr: string): void {
  const tokens = tokensOf(id, path, ptr);
  let node: unknown = target(wc, id, true, ptr);
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    if (Array.isArray(node)) {
      const k = arrayIndex(t, node.length, false);
      if (k === undefined) return fail('FS-OPS-003', `${path}: ${t} is not an index of the array there`, [], ptr);
      node = node[k];
    } else if (isObject(node)) {
      if (!Object.hasOwn(node, t)) setMember(node, t, {});
      node = node[t];
    } else return fail('FS-OPS-003', `${path}: there is a ${typeof node} on the way, not an object`, [], ptr);
  }
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(node)) {
    const k = arrayIndex(last, node.length, true);
    if (k === undefined) return fail('FS-OPS-003', `${path}: ${last} is not an index of the array there`, [], ptr);
    node[k] = clone(value);
  } else if (isObject(node)) setMember(node, last, clone(value));
  else return fail('FS-OPS-003', `${path}: there is a ${typeof node} on the way, not an object`, [], ptr);
  wc.touch();
}

export function unsetProperty(wc: WorkingCopy, id: string, path: string, ptr: string): void {
  const tokens = tokensOf(id, path, ptr);
  let node: unknown = target(wc, id, false, ptr);
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    if (Array.isArray(node)) {
      const k = arrayIndex(t, node.length, false);
      node = k === undefined ? undefined : node[k];
    } else node = isObject(node) && Object.hasOwn(node, t) ? node[t] : undefined;
    if (node === undefined) return fail('FS-OPS-003', `${id} has no member ${path}`, [], ptr);
  }
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(node)) {
    const k = arrayIndex(last, node.length, false);
    if (k === undefined) return fail('FS-OPS-003', `${id} has no member ${path}`, [], ptr);
    node.splice(k, 1);
  } else if (isObject(node) && Object.hasOwn(node, last)) deleteMember(node, last);
  else return fail('FS-OPS-003', `${id} has no member ${path}`, [], ptr);
  wc.touch();
}

export const sortIds = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(cmpStr);
