/**
 * The seven primitives and three shorthands (chapter 2), applied to the working copy. Each changes
 * it in exactly one way, or fails the batch. Ops 0.2 adds program items and extension elements to
 * what they add and remove, and the adjacency primitives (2.6).
 */
import { fail } from './diagnostics.js';
import { ITEMS, type CollectionName, type Place, type WorkingCopy } from './model/working.js';
import type { ResolvedPrimitive } from './types.js';
import { clone, cmpStr, deleteMember, escapeToken, getMember, isObject, parsePointer, setMember, type JsonObject } from './lib/json.js';

type AddPrimitive = Extract<ResolvedPrimitive, { op: 'addElement' | 'addJunction' | 'addWall' | 'addSeparator' }>;

/** Where an add primitive (or shorthand) puts its element, and the element (2.1, 2.1.2). */
export function addTarget(p: AddPrimitive): { place: Place; element: unknown } {
  switch (p.op) {
    case 'addElement':
      if (p.extension !== undefined) return { place: { kind: 'ext', extension: p.extension, collection: p.collection }, element: p.element };
      return { place: p.collection === ITEMS ? { kind: ITEMS } : { kind: p.collection as CollectionName }, element: p.element };
    case 'addJunction':
    case 'addWall':
    case 'addSeparator': {
      const element: JsonObject = {};
      for (const k of Object.keys(p)) if (k !== 'op' && k !== 'id') setMember(element, k, (p as unknown as JsonObject)[k]);
      return { place: { kind: p.op === 'addJunction' ? 'junctions' : p.op === 'addWall' ? 'walls' : 'separators' }, element };
    }
  }
}

/**
 * 2.1.3: the object a new element goes into, creating `program` and its `items`, or `extensions`,
 * the extension's data, its `collections` and the collection, where they are missing; FS-OPS-003
 * when one of them is present and is not an object.
 */
function container(wc: WorkingCopy, place: Place, ptr: string): JsonObject {
  if (place.kind !== ITEMS && place.kind !== 'ext') return wc.ensureCollection(place.kind);
  const path = place.kind === ITEMS ? ['program', 'items'] : ['extensions', place.extension, 'collections', place.collection];
  let cur: JsonObject = wc.doc;
  for (const k of path) {
    if (!Object.hasOwn(cur, k)) setMember(cur, k, {});
    const next = cur[k];
    if (!isObject(next)) return fail('FS-OPS-003', `/${path.map(escapeToken).join('/')} leads through a value that is not an object`, [], ptr);
    cur = next;
  }
  return cur;
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
      const { place, element } = addTarget(p);
      const target = container(wc, place, `${ptr.op}/collection`);
      setMember(target, p.id, clone(element));
      wc.named(p.id);
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
    case 'setAdjacency':
    case 'removeAdjacency':
      adjacency(wc, p, ptr.op);
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

/** Extension elements (Ops 0.2) satisfying a test, by ID. */
function extWhere(wc: WorkingCopy, test: (e: JsonObject) => boolean): string[] {
  return wc
    .extElements()
    .filter((x) => isObject(x.element) && test(x.element))
    .map((x) => x.id);
}

const hostIs = (member: string, id: string) => (e: JsonObject): boolean => getMember(getMember(e, 'host'), member) === id;
const fallbackIs = (members: readonly string[], id: string) => (e: JsonObject): boolean => {
  const f = getMember(e, 'fallback');
  return isObject(f) && members.some((m) => getMember(f, m) === id);
};

const layerMaterials = (e: JsonObject): unknown[] => {
  const layers = getMember(e, 'layers');
  return Array.isArray(layers) ? layers.map((l) => getMember(l, 'material')) : [];
};

/** What blocks removing an element without cascade — and always, for a type, material, asset or program item (2.2). */
function blockers(wc: WorkingCopy, id: string, kind: Place['kind']): string[] {
  const onLevel = (e: JsonObject): boolean => hostIs('level', id)(e) || fallbackIs(['level'], id)(e);
  switch (kind) {
    case 'buildings':
      return where(wc, 'levels', (e) => getMember(e, 'building') === id);
    case 'levels': {
      const on = (['junctions', 'walls', 'separators', 'rooms', 'slabs'] as const).flatMap((k) => where(wc, k, (e) => getMember(e, 'level') === id));
      const vertical = where(wc, 'walls', (e) => getMember(getMember(e, 'base'), 'level') === id || getMember(getMember(e, 'top'), 'level') === id);
      return [...on, ...vertical, ...extWhere(wc, onLevel)];
    }
    case 'junctions':
      return (['walls', 'separators'] as const).flatMap((k) => where(wc, k, (e) => getMember(e, 'start') === id || getMember(e, 'end') === id));
    case 'walls':
      return [...where(wc, 'openings', (e) => getMember(e, 'wall') === id), ...extWhere(wc, hostIs('wall', id))];
    case 'rooms':
      return extWhere(wc, hostIs('room', id));
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
      return [...where(wc, 'materials', (e) => getMember(getMember(e, 'texture'), 'asset') === id), ...extWhere(wc, fallbackIs(['asset', 'symbol'], id))];
    case ITEMS:
      return where(wc, 'rooms', (e) => getMember(e, 'brief') === id);
    default:
      return [];
  }
}

/** What removing an element takes with it when `cascade` is true: the "Takes with it" column of 2.2. */
function takes(wc: WorkingCopy, id: string, kind: Place['kind']): string[] {
  switch (kind) {
    case 'buildings':
      return where(wc, 'levels', (e) => getMember(e, 'building') === id);
    case 'levels': {
      const on = (['junctions', 'walls', 'separators', 'rooms', 'slabs'] as const).flatMap((k) => where(wc, k, (e) => getMember(e, 'level') === id));
      return [...on, ...extWhere(wc, (e) => hostIs('level', id)(e) || fallbackIs(['level'], id)(e))];
    }
    case 'junctions':
      return (['walls', 'separators'] as const).flatMap((k) => where(wc, k, (e) => getMember(e, 'start') === id || getMember(e, 'end') === id));
    case 'walls':
      return [...where(wc, 'openings', (e) => getMember(e, 'wall') === id), ...extWhere(wc, hostIs('wall', id))];
    case 'rooms':
      return extWhere(wc, hostIs('room', id));
    default:
      return [];
  }
}

export function removeElement(wc: WorkingCopy, id: string, cascade: boolean, ptr: string): void {
  const loc = wc.locate(id);
  if (!loc) return fail('FS-OPS-003', `there is no element ${id} to remove`, [], ptr);
  const kind = loc.place.kind;
  // The elements to remove: id, and with cascade what it takes with it, transitively (2.2.2).
  const gone = new Map<string, { place: Place; container: JsonObject }>([[id, loc]]);
  if (!cascade || kind === 'types' || kind === 'materials' || kind === 'assets' || kind === ITEMS) {
    const b = [...new Set(blockers(wc, id, kind))].filter((x) => x !== id);
    if (b.length)
      fail(
        'FS-OPS-006',
        `${id} cannot be removed while ${b.join(', ')} ${kind === 'types' || kind === 'materials' || kind === 'assets' || kind === ITEMS ? 'refer to it' : 'depend on it; remove them first, or use cascade'}`,
        [id, ...b],
        ptr,
      );
  } else {
    const work = [id];
    while (work.length) {
      const x = work.pop()!;
      for (const y of takes(wc, x, gone.get(x)!.place.kind))
        if (!gone.has(y)) {
          gone.set(y, wc.locate(y)!);
          work.push(y);
        }
    }
  }
  for (const [x, l] of gone) deleteMember(l.container, x);
  // A wall is always removed from join.through, which unsets that join (2.2).
  const goneWalls = new Set([...gone].filter(([, l]) => l.place.kind === 'walls').map(([x]) => x));
  if (goneWalls.size)
    for (const j of wc.ids('junctions')) {
      const e = wc.elementIn('junctions', j);
      const through = getMember(getMember(e, 'join'), 'through');
      if (e && Array.isArray(through) && through.some((w) => typeof w === 'string' && goneWalls.has(w))) deleteMember(e, 'join');
    }
  if (wc.v02) {
    // 2.2.3: whether cascade or not, an adjacency naming a removed item goes with it, and an item's
    // `level` with the level it names.
    const goneItems = new Set([...gone].filter(([, l]) => l.place.kind === ITEMS).map(([x]) => x));
    const program = getMember(wc.doc, 'program');
    const adjacency = getMember(program, 'adjacency');
    if (goneItems.size && isObject(program) && Array.isArray(adjacency))
      setMember(
        program,
        'adjacency',
        adjacency.filter((a) => !(isObject(a) && (goneItems.has(str(getMember(a, 'a')) ?? '\u0000') || goneItems.has(str(getMember(a, 'b')) ?? '\u0000')))),
      );
    const goneLevels = new Set([...gone].filter(([, l]) => l.place.kind === 'levels').map(([x]) => x));
    if (goneLevels.size)
      for (const item of Object.values(wc.items())) {
        const level = getMember(item, 'level');
        if (isObject(item) && typeof level === 'string' && goneLevels.has(level)) deleteMember(item, 'level');
      }
  }
  wc.touch();
}

// ── 2.6 setAdjacency and removeAdjacency (Ops 0.2) ────────────────────────────

const samePair = (e: unknown, a: string, b: string, kind: string): boolean => {
  if (!isObject(e) || getMember(e, 'kind') !== kind) return false;
  const x = getMember(e, 'a');
  const y = getMember(e, 'b');
  return typeof x === 'string' && typeof y === 'string' && ((x === a && y === b) || (x === b && y === a));
};

function adjacency(wc: WorkingCopy, p: Extract<ResolvedPrimitive, { op: 'setAdjacency' | 'removeAdjacency' }>, ptr: string): void {
  const create = p.op === 'setAdjacency';
  let program = getMember(wc.doc, 'program');
  if (program === undefined && create) {
    program = {};
    setMember(wc.doc, 'program', program);
  }
  if (!isObject(program)) return fail('FS-OPS-003', 'the document has no program', [], ptr);
  if (!Object.hasOwn(program, 'adjacency') && create) setMember(program, 'adjacency', []);
  const list: unknown = getMember(program, 'adjacency');
  if (!Array.isArray(list)) return fail('FS-OPS-003', "the program's adjacency is not an array", [], ptr);
  if (p.op === 'setAdjacency') {
    const entry: JsonObject = { a: p.a, b: p.b, kind: p.kind };
    if (Object.hasOwn(p, 'weight')) setMember(entry, 'weight', clone(p.weight));
    const i = list.findIndex((e) => samePair(e, p.a, p.b, p.kind));
    if (i >= 0) list[i] = entry;
    else list.push(entry);
  } else {
    const keep: unknown[] = list.filter((e) => !samePair(e, p.a, p.b, p.kind));
    if (keep.length === list.length) return fail('FS-OPS-003', `the program has no ${p.kind} adjacency of ${p.a} and ${p.b}`, [], ptr);
    list.splice(0, list.length, ...keep);
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
  const loc = wc.locate(id);
  if (!loc) return fail('FS-OPS-003', `there is no element ${id}`, [], ptr);
  const e = loc.container[id];
  if (!isObject(e)) return fail('FS-OPS-003', `${id} is not an object, so it has no members`, [id], ptr);
  return e;
}

/** The members $document addresses (2.3): the document's top-level members other than its collections. */
const DOCUMENT_MEMBERS: readonly string[] = ['floorspec', 'project', 'site', 'extensionsUsed', 'extensionsRequired', 'extensions', 'extras'];
/** Ops 0.2 adds the program. */
const DOCUMENT_MEMBERS_02: readonly string[] = [...DOCUMENT_MEMBERS, 'program'];

function tokensOf(wc: WorkingCopy, id: string, path: string, ptr: string): string[] {
  const members = wc.v02 ? DOCUMENT_MEMBERS_02 : DOCUMENT_MEMBERS;
  const own = id.startsWith('$') ? [] : [id];
  const tokens = parsePointer(path);
  if (tokens === undefined) return fail('FS-OPS-003', `${JSON.stringify(path)} is not a JSON Pointer`, own, ptr);
  if (tokens.length === 0) return fail('FS-OPS-003', 'the path is empty: it must name a member', own, ptr);
  if (id === '$document' && !members.includes(tokens[0]!)) fail('FS-OPS-003', `$document addresses ${members.join(', ')}; ${tokens[0]} is not one of them`, [], ptr);
  return tokens;
}

/** An array element is addressed by an index that exists (2.3.1): no `-`, no appending. */
const arrayIndex = (t: string, length: number): number | undefined => {
  if (!/^(0|[1-9][0-9]*)$/.test(t)) return undefined;
  const i = Number(t);
  return i < length ? i : undefined;
};

export function setProperty(wc: WorkingCopy, id: string, path: string, value: unknown, ptr: string): void {
  let node: unknown = target(wc, id, true, ptr);
  const tokens = tokensOf(wc, id, path, ptr);
  const own = id.startsWith('$') ? [] : [id];
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    if (Array.isArray(node)) {
      const k = arrayIndex(t, node.length);
      if (k === undefined) return fail('FS-OPS-003', `${path}: ${t} is not an index of the array there`, own, ptr);
      node = node[k];
    } else if (isObject(node)) {
      if (!Object.hasOwn(node, t)) setMember(node, t, {});
      node = node[t];
    } else return fail('FS-OPS-003', `${path}: there is a ${typeof node} on the way, not an object`, own, ptr);
  }
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(node)) {
    const k = arrayIndex(last, node.length);
    if (k === undefined) return fail('FS-OPS-003', `${path}: ${last} is not an index of the array there`, own, ptr);
    node[k] = clone(value);
  } else if (isObject(node)) setMember(node, last, clone(value));
  else return fail('FS-OPS-003', `${path}: there is a ${typeof node} on the way, not an object`, own, ptr);
  wc.touch();
}

export function unsetProperty(wc: WorkingCopy, id: string, path: string, ptr: string): void {
  let node: unknown = target(wc, id, false, ptr);
  const tokens = tokensOf(wc, id, path, ptr);
  const own = id.startsWith('$') ? [] : [id];
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    if (Array.isArray(node)) {
      const k = arrayIndex(t, node.length);
      node = k === undefined ? undefined : node[k];
    } else node = isObject(node) && Object.hasOwn(node, t) ? node[t] : undefined;
    if (node === undefined) return fail('FS-OPS-003', `${id} has no member ${path}`, own, ptr);
  }
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(node)) {
    const k = arrayIndex(last, node.length);
    if (k === undefined) return fail('FS-OPS-003', `${id} has no member ${path}`, own, ptr);
    node.splice(k, 1);
  } else if (isObject(node) && Object.hasOwn(node, last)) deleteMember(node, last);
  else return fail('FS-OPS-003', `${id} has no member ${path}`, own, ptr);
  wc.touch();
}

export const sortIds = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(cmpStr);
