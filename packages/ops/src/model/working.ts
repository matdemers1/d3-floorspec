/**
 * The working copy of a transaction (1.2): document A, deep-copied, changed in place by each
 * primitive, and the bookkeeping ID minting needs (1.5).
 *
 * The document's one space of IDs (0.3): an element of one of Core's thirteen collections (eleven,
 * and Core 0.3's roofs and stairs), and — in
 * Ops 0.2 and 0.3, in a working copy that declares "0.2" or "0.3" — a program item (Core §11.1) or
 * an extension element (Core §12.5). Which a working copy declares is read from it as it stands;
 * under Ops 0.1, or in a document that declares "0.1", only the eleven collections hold elements.
 */
import { cmpStr, getMember, isObject, setMember, type JsonObject } from '../lib/json.js';

/** The element collections of Core §1.1, in its table order. */
export const COLLECTIONS = [
  'buildings',
  'levels',
  'junctions',
  'walls',
  'separators',
  'openings',
  'rooms',
  'slabs',
  'roofs',
  'types',
  'materials',
  'assets',
  'stairs',
  'optionSets',
  'options',
] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

/** Core 0.3's collections (chapters 16, 17, 19), which only an Ops 0.3 request may add to (Ops 0.3 §1.1.3). */
export const CORE03_COLLECTIONS: readonly CollectionName[] = ['roofs', 'stairs', 'optionSets', 'options'];

/** Ops 0.3, 2.8 (Core §19.2): the collections whose elements may be in a design option, beside extension elements. */
export const IN_OPTIONS: readonly CollectionName[] = ['junctions', 'walls', 'separators', 'openings', 'rooms', 'slabs', 'roofs', 'stairs'];

/** The collections addElement may name in a request of this draft: Ops 0.3 adds roofs, stairs, option sets and options. */
export const collectionsOf = (ops: OpsVersion): readonly CollectionName[] => (ops === '0.3' ? COLLECTIONS : COLLECTIONS.filter((c) => !CORE03_COLLECTIONS.includes(c)));

/**
 * The draft of Floorspec Ops a transaction follows. Ops 0.3 adds no operation and no member: it is
 * Ops 0.2 applied with a Core 0.3 reader (Ops 0.3 §0.4), and addElement may name Core 0.3's roofs
 * and stairs, so everything this package says of "Ops 0.2" holds of 0.3 too.
 */
export type OpsVersion = '0.1' | '0.2' | '0.3';

/** Ops 0.2 or later: the program and extension elements are elements (0.3). */
export const atLeast02 = (ops: OpsVersion): boolean => ops !== '0.1';

/** Ops 0.2: the program's items, as addElement names them (2.1). */
export const ITEMS = 'items';
/** What kind of element an ID names: a collection, a program item, or an extension element (Ops 0.2). */
export type ElementKind = CollectionName | typeof ITEMS | 'ext';

/** Where an element lives: one of the eleven collections, the program's items, or an extension's collection. */
export type Place = { kind: CollectionName } | { kind: typeof ITEMS } | { kind: 'ext'; extension: string; collection: string };

export const isCollection = (s: unknown): s is CollectionName => typeof s === 'string' && (COLLECTIONS as readonly string[]).includes(s);

/** 1.5: the prefix of a minted ID, per collection; `items` (Ops 0.2) is the program's items. */
export const PREFIX: Readonly<Record<CollectionName, string>> & { readonly items: string } = {
  buildings: 'B',
  levels: 'L',
  junctions: 'J',
  walls: 'W',
  separators: 'S',
  openings: 'O',
  rooms: 'R',
  slabs: 'SL',
  types: 'T',
  materials: 'M',
  assets: 'A',
  roofs: 'RF',
  stairs: 'ST',
  optionSets: 'OS',
  options: 'OP',
  items: 'P',
};
/** 1.5 (Ops 0.2): every extension collection shares one prefix. */
export const EXTENSION_PREFIX = 'X';

/** The reserved targets of setProperty and unsetProperty (2.3). */
export const RESERVED_TARGETS = ['$project', '$site', '$document'] as const;
export type ReservedTarget = (typeof RESERVED_TARGETS)[number];

/** One extension collection of a document (Ops 0.2). */
export interface ExtCollection {
  readonly extension: string;
  readonly collection: string;
  readonly elements: JsonObject;
}

/**
 * Does this document, read by this draft, hold program items and extension elements (0.3)? Only
 * under Ops 0.2 or later, and only when it declares "0.2" or "0.3" (Core §1.2.6).
 */
export const holds02 = (doc: unknown, ops: OpsVersion): boolean => {
  if (!atLeast02(ops)) return false;
  const v = getMember(doc, 'floorspec');
  return v === '0.2' || v === '0.3';
};

/** The program's items of a document, or {} where there are none to address. */
export function itemsOf(doc: unknown, ops: OpsVersion): JsonObject {
  if (!holds02(doc, ops)) return {};
  const items = getMember(getMember(doc, 'program'), 'items');
  return isObject(items) ? items : {};
}

/** Every extension collection, by extension name and then collection name (only well-formed ones). */
export function extCollectionsOf(doc: unknown, ops: OpsVersion): ExtCollection[] {
  if (!holds02(doc, ops)) return [];
  const exts = getMember(doc, 'extensions');
  if (!isObject(exts)) return [];
  const out: ExtCollection[] = [];
  for (const extension of Object.keys(exts).sort(cmpStr)) {
    const cs = getMember(exts[extension], 'collections');
    if (!isObject(cs)) continue;
    for (const collection of Object.keys(cs).sort(cmpStr)) {
      const elements = cs[collection];
      if (isObject(elements)) out.push({ extension, collection, elements });
    }
  }
  return out;
}

/** Every extension element, sorted by ID. */
export function extElementsOf(doc: unknown, ops: OpsVersion): { extension: string; collection: string; id: string; element: unknown }[] {
  const out = extCollectionsOf(doc, ops).flatMap((c) => Object.keys(c.elements).map((id) => ({ extension: c.extension, collection: c.collection, id, element: c.elements[id] })));
  return out.sort((a, b) => cmpStr(a.id, b.id));
}

/** (place, container) for every place an element can be: the eleven collections, the items, then the extension collections. */
export function placesOf(doc: unknown, ops: OpsVersion): { place: Place; container: JsonObject }[] {
  const out: { place: Place; container: JsonObject }[] = COLLECTIONS.map((c) => {
    const v = getMember(doc, c);
    return { place: { kind: c }, container: isObject(v) ? v : {} };
  });
  if (holds02(doc, ops)) {
    out.push({ place: { kind: ITEMS }, container: itemsOf(doc, ops) });
    for (const c of extCollectionsOf(doc, ops)) out.push({ place: { kind: 'ext', extension: c.extension, collection: c.collection }, container: c.elements });
  }
  return out;
}

/** Every element ID of a document. */
export function idsOf(doc: unknown, ops: OpsVersion): Set<string> {
  const out = new Set<string>();
  for (const { container } of placesOf(doc, ops)) for (const id of Object.keys(container)) out.add(id);
  return out;
}

export const samePlace = (a: Place, b: Place): boolean =>
  a.kind === b.kind && (a.kind !== 'ext' || (b.kind === 'ext' && a.extension === b.extension && a.collection === b.collection));

export class WorkingCopy {
  readonly doc: JsonObject;
  readonly ops: OpsVersion;
  /** IDs of the elements of A. */
  readonly inA: ReadonlySet<string>;
  /** Junction IDs of A (5.1: the survivor of a merge is the one that was in A). */
  readonly junctionsInA: ReadonlySet<string>;
  readonly retired: ReadonlySet<string>;
  /** IDs named or minted earlier in this batch, including any removed again since (1.5). */
  readonly used = new Set<string>();
  /** Bumped on every change, so derived views (faces) can be cached between changes. */
  version = 0;
  /**
   * Ops 0.3, 2.8: `context.option`, the option the batch edits in — every element a primitive adds
   * to a collection that may be in an option, without an `option` of its own, is added in it; and
   * faces, rooms and the junctions at a point are read in the edit design.
   */
  editOption: string | undefined;

  constructor(doc: JsonObject, retired: readonly string[], ops: OpsVersion = '0.2') {
    this.doc = doc;
    this.ops = ops;
    this.retired = new Set(retired);
    this.inA = idsOf(doc, ops);
    this.junctionsInA = new Set(Object.keys(this.collection('junctions') ?? {}));
  }

  /** Ops 0.2 or later (Ops 0.3 has 0.2's operations and members). */
  get v02(): boolean {
    return atLeast02(this.ops);
  }

  touch(): void {
    this.version++;
  }

  /** A collection, or undefined when the document omits it (or it is not an object). */
  collection(name: CollectionName): JsonObject | undefined {
    const c = getMember(this.doc, name);
    return isObject(c) ? c : undefined;
  }

  /** A collection, created empty when absent. */
  ensureCollection(name: CollectionName): JsonObject {
    const c = this.collection(name);
    if (c) return c;
    const created: JsonObject = {};
    setMember(this.doc, name, created);
    this.touch();
    return created;
  }

  /** Every element ID in the working copy (0.3). */
  allIds(): string[] {
    return [...idsOf(this.doc, this.ops)];
  }

  /** Where an element is, and the object that holds it. */
  locate(id: string): { place: Place; container: JsonObject } | undefined {
    for (const p of placesOf(this.doc, this.ops)) if (Object.hasOwn(p.container, id)) return p;
    return undefined;
  }

  /** The kind of element an ID names: a collection, `items` or `ext`. */
  kindOf(id: string): ElementKind | undefined {
    return this.locate(id)?.place.kind;
  }

  /** The collection of one of the eleven an ID is in. */
  collectionOf(id: string): CollectionName | undefined {
    for (const c of COLLECTIONS) {
      const coll = this.collection(c);
      if (coll && Object.hasOwn(coll, id)) return c;
    }
    return undefined;
  }

  exists(id: string): boolean {
    return this.locate(id) !== undefined;
  }

  /** The element with this ID, as stored (any JSON value mid-batch). */
  element(id: string): unknown {
    const l = this.locate(id);
    return l ? l.container[id] : undefined;
  }

  /** The element, when it is in `collection` and is an object. */
  elementIn(collection: CollectionName, id: string): JsonObject | undefined {
    const c = this.collection(collection);
    if (!c || !Object.hasOwn(c, id)) return undefined;
    const e = c[id];
    return isObject(e) ? e : undefined;
  }

  /** IDs of a collection, sorted. */
  ids(collection: CollectionName): string[] {
    return Object.keys(this.collection(collection) ?? {}).sort(cmpStr);
  }

  /** The program's items (Ops 0.2), or {} where there are none to address. */
  items(): JsonObject {
    return itemsOf(this.doc, this.ops);
  }

  /** Every extension element (Ops 0.2), sorted by ID. */
  extElements(): { extension: string; collection: string; id: string; element: unknown }[] {
    return extElementsOf(this.doc, this.ops);
  }

  /** 1.5.2: is this ID used anywhere in the working copy, or retired? */
  unavailable(id: string): boolean {
    return this.exists(id) || this.retired.has(id);
  }

  /** Record an ID an operation named for an element it created (1.5). */
  named(id: string): void {
    this.used.add(id);
  }

  /**
   * Mint an ID for a new element (1.5): its prefix and one more than the largest n among the IDs
   * `^<prefix>[0-9]+$` of every element in A and in the working copy, named or minted earlier in
   * this batch (removed again or not), and retired. A collection name, `items`, or a prefix.
   */
  mint(collection: CollectionName | typeof ITEMS | { prefix: string }): string {
    const prefix = typeof collection === 'string' ? PREFIX[collection] : collection.prefix;
    const re = new RegExp(`^${prefix}([0-9]+)$`);
    let max = 0n;
    const consider = (id: string): void => {
      const m = re.exec(id);
      if (m) {
        const n = BigInt(m[1]!);
        if (n > max) max = n;
      }
    };
    for (const id of this.inA) consider(id);
    for (const id of idsOf(this.doc, this.ops)) consider(id);
    for (const id of this.used) consider(id);
    for (const id of this.retired) consider(id);
    const id = `${prefix}${max + 1n}`;
    this.used.add(id);
    return id;
  }
}
