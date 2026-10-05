/**
 * The working copy of a transaction (1.2): document A, deep-copied, changed in place by each
 * primitive, and the bookkeeping ID minting needs (1.5).
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
  'types',
  'materials',
  'assets',
] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

export const isCollection = (s: unknown): s is CollectionName => typeof s === 'string' && (COLLECTIONS as readonly string[]).includes(s);

/** 1.5: the prefix of a minted ID, per collection. */
export const PREFIX: Readonly<Record<CollectionName, string>> = {
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
};

/** The reserved targets of setProperty and unsetProperty (2.3). */
export const RESERVED_TARGETS = ['$project', '$site', '$document'] as const;
export type ReservedTarget = (typeof RESERVED_TARGETS)[number];

export class WorkingCopy {
  readonly doc: JsonObject;
  /** IDs of the elements of A. */
  readonly inA: ReadonlySet<string>;
  /** Junction IDs of A (5.1: the survivor of a merge is the one that was in A). */
  readonly junctionsInA: ReadonlySet<string>;
  readonly retired: ReadonlySet<string>;
  /** IDs named or minted earlier in this batch, including any removed again since (1.5). */
  readonly used = new Set<string>();
  /** Bumped on every change, so derived views (faces) can be cached between changes. */
  version = 0;

  constructor(doc: JsonObject, retired: readonly string[]) {
    this.doc = doc;
    this.retired = new Set(retired);
    this.inA = new Set(this.allIds());
    this.junctionsInA = new Set(Object.keys(this.collection('junctions') ?? {}));
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

  /** Every element ID in the working copy. */
  allIds(): string[] {
    const out: string[] = [];
    for (const c of COLLECTIONS) out.push(...Object.keys(this.collection(c) ?? {}));
    return out;
  }

  collectionOf(id: string): CollectionName | undefined {
    for (const c of COLLECTIONS) {
      const coll = this.collection(c);
      if (coll && Object.hasOwn(coll, id)) return c;
    }
    return undefined;
  }

  exists(id: string): boolean {
    return this.collectionOf(id) !== undefined;
  }

  /** The element with this ID, as stored (any JSON value mid-batch). */
  element(id: string): unknown {
    const c = this.collectionOf(id);
    return c ? this.collection(c)![id] : undefined;
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

  /** 1.5.2: is this ID used anywhere in the working copy, or retired? */
  unavailable(id: string): boolean {
    return this.exists(id) || this.retired.has(id);
  }

  /** Record an ID an operation named for an element it created (1.5). */
  named(id: string): void {
    this.used.add(id);
  }

  /**
   * Mint an ID for a new element of a collection (1.5): its prefix and one more than the largest n
   * among the IDs `^<prefix>[0-9]+$` in A, named or minted earlier in this batch (removed again
   * or not), and retired. Every ID in the working copy is one of these, so a minted ID is free.
   */
  mint(collection: CollectionName): string {
    const prefix = PREFIX[collection];
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
    for (const id of this.used) consider(id);
    for (const id of this.retired) consider(id);
    const id = `${prefix}${max + 1n}`;
    this.used.add(id);
    return id;
  }
}
