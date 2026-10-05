/**
 * What every official extension's rules share (each extension's spec, chapter 1): the extension's
 * data in one valid document, the one space of IDs, the room an element is in, and diagnostics in
 * the extension's own namespace (FS-<CODE>-SCH-, -INV-, -LINT-).
 */
import { COLLECTIONS, entries, extElements, ipoint, programItems, type ExtElement, type ExtensionElement, type FloorspecDocument } from '../model/document.js';
import type { Analysis } from '../validate/invariants.js';
import type { Diagnostic, Severity } from '../validate/diagnostic.js';

/** One row of an extension's diagnostic catalogue (its spec's chapter on diagnostics). */
export interface ExtensionDiagnostic {
  readonly code: string;
  readonly severity: Severity;
  /** The condition, as the catalogue words it. */
  readonly condition: string;
}

/** An extension the engine implements: one version of one official extension. */
export interface ExtensionImplementation<Derived = unknown> {
  readonly name: string;
  readonly version: string;
  /** The extension's statement and diagnostic code: `ELEC` for FS-ELEC-3.1.1 and FS-ELEC-INV-002. */
  readonly code: string;
  /** Every diagnostic it reports. */
  readonly catalogue: readonly ExtensionDiagnostic[];
  /**
   * Its schema (generated from the registry's schema file): does its top-level data match — and,
   * for an extension whose data lives on core elements (FS_structural), the data on each element of
   * `document` (the document as the schema sees it)?
   */
  validate(data: unknown, document?: unknown): boolean;
  /** Its invariants, for data that matched its schema. */
  invariants(ctx: ExtensionContext): void;
  /** Its lints, for a valid document. */
  lints(ctx: ExtensionContext): void;
  /** What it derives, for a valid document: `derived.extensions[name]`. */
  derive(ctx: ExtensionContext): Derived;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export class ExtensionContext {
  readonly doc: FloorspecDocument;
  readonly analysis: Analysis;
  readonly impl: ExtensionImplementation;
  /** The extension's top-level data, `extensions.<name>` (an object: it matched the schema). */
  readonly data: Json;
  /** Every extension element of every extension, by ID. */
  readonly ext: ReadonlyMap<string, ExtElement>;
  private readonly out: Diagnostic[];
  private roomCache?: Map<string, string | undefined>;

  constructor(doc: FloorspecDocument, analysis: Analysis, impl: ExtensionImplementation, out: Diagnostic[]) {
    this.doc = doc;
    this.analysis = analysis;
    this.impl = impl;
    this.out = out;
    const data = (doc.extensions as Json | undefined)?.[impl.name];
    this.data = isObject(data) ? data : {};
    this.ext = new Map(extElements(doc).map((x) => [x.id, x]));
  }

  /** One of the extension's own collections, sorted by ID. */
  coll<E = ExtensionElement>(name: string): [string, E][] {
    const cs = this.data.collections;
    return entries((isObject(cs) ? cs[name] : undefined) as Record<string, E> | undefined);
  }

  /** One of the extension's own records (circuits, stacks, gas sources), sorted by ID. */
  records<R>(member: string): [string, R][] {
    return entries(this.data[member] as Record<string, R> | undefined);
  }

  /** The kind (collection) and element, when `id` is an element of this extension; the caller names the kind it expects. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- a typed view, as coll's
  own<E = ExtensionElement>(id: string): { collection: string; element: E } | undefined {
    const x = this.ext.get(id);
    return x && x.extension === this.impl.name ? { collection: x.collection, element: x.element as E } : undefined;
  }

  /** Core 3.1.3: every ID of an element, a program item or an extension element. */
  space(): Set<string> {
    const out = new Set<string>();
    for (const c of COLLECTIONS) for (const [id] of entries(this.doc[c] as Record<string, unknown> | undefined)) out.add(id);
    for (const [id] of programItems(this.doc)) out.add(id);
    for (const id of this.ext.keys()) out.add(id);
    return out;
  }

  hasPurpose(el: ExtensionElement, purpose: string): boolean {
    return Object.values(el.clearances ?? {}).some((e) => e?.purpose === purpose);
  }

  report(code: string, message: string, elements: string[], pointer?: string): void {
    const row = this.impl.catalogue.find((c) => c.code === code);
    if (!row) throw new Error(`${code} is not in ${this.impl.name}'s catalogue`);
    this.out.push({ code, severity: row.severity, message, elements: [...new Set(elements)].sort(), location: pointer === undefined ? {} : { pointer } });
  }

  /**
   * The room of every extension element (FS_electrical 6.1, and each extension's derived values):
   * a surface host's room; for a wallFace host, the room anchored in the face on the host's side of
   * the wall (the face left of its location line walked from start to end for "left"); for a free
   * host, the room anchored in the bounded face containing its position, unless the position is on
   * a location line; otherwise none.
   */
  rooms(): Map<string, string | undefined> {
    if (this.roomCache) return this.roomCache;
    const levels = new Map<string, { edgeIndex: Map<string, number>; faceOfCycle: Map<number, number>; roomOfFace: Map<number, string> }>();
    const level = (lid: string) => {
      let l = levels.get(lid);
      if (!l) {
        const la = this.analysis.levels.get(lid)!;
        const g = la.geometry!;
        const cycleIndex = new Map(g.graph.cycles.map((c, i) => [c, i]));
        const faceOfCycle = new Map<number, number>();
        g.faces.forEach((f, i) => {
          for (const c of [f.outer, ...f.inner]) faceOfCycle.set(cycleIndex.get(c)!, i);
        });
        const roomOfFace = new Map<number, string>();
        for (const [rid, face] of la.roomFaces) roomOfFace.set(face, rid);
        l = { edgeIndex: new Map(g.edges.map((e, i) => [e.id, i])), faceOfCycle, roomOfFace };
        levels.set(lid, l);
      }
      return l;
    };
    const out = new Map<string, string | undefined>();
    for (const [id, x] of this.ext) {
      const host = x.element.host;
      let room: string | undefined;
      if (host?.mode === 'surface') room = host.room;
      else if (host?.mode === 'wallFace') {
        const lid = this.doc.walls![host.wall]!.level;
        const l = level(lid);
        const i = l.edgeIndex.get(host.wall)!;
        const g = this.analysis.levels.get(lid)!.geometry!;
        const face = l.faceOfCycle.get(g.graph.cycleOf[host.side === 'left' ? 2 * i : 2 * i + 1]!);
        room = face === undefined ? undefined : l.roomOfFace.get(face);
      } else if (host?.mode === 'free') {
        const where = this.analysis.levels.get(host.level)!.geometry!.locateAnchor(ipoint(host.position));
        room = where.kind === 'face' ? level(host.level).roomOfFace.get(where.face) : undefined;
      }
      out.set(id, room);
    }
    this.roomCache = out;
    return out;
  }

  /** Every room that holds an element of this extension, and those elements, sorted. */
  roomsDerived(): Record<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [id, room] of this.rooms()) {
      if (room === undefined || this.ext.get(id)!.extension !== this.impl.name) continue;
      out.set(room, [...(out.get(room) ?? []), id]);
    }
    return record([...out].map(([k, v]) => [k, sorted(v)]));
  }
}

/**
 * An object from [ID, value] pairs, its members in ID order (UTF-16 code units, as 10.2 sorts).
 * Members are defined, not assigned, so an ID such as `constructor` is an ordinary member.
 */
export function record<T>(pairs: Iterable<readonly [string, T]>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  return out;
}

/** A sorted copy of a list of IDs. */
export const sorted = (ids: Iterable<string>): string[] => [...ids].sort();
