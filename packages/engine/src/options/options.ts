/**
 * Design options (Core 0.3, chapter 19): option sets and options, membership, designs and their
 * views, the checked designs, the option invariants and lint, and the derived `options` member.
 *
 * A **design** chooses one option of every option set; the **primary design** chooses every set's
 * primary (19.3). The **view** of a design is the document as seen in it: every element in an option
 * the design does not choose is gone, and so are `optionSets`, `options` and every remaining
 * element's `option` member — a document without design options, to which chapters 1–18 apply as
 * they stand. The **checked designs** are the primary design and, for every option that is not its
 * set's primary, its **option design**: the primary design with that one option chosen instead
 * (19.5).
 */
import { jsonEqual } from '../canonical/canonicalize.js';
import { entries, get, type FloorspecDocument } from '../model/document.js';
import { IN_OPTIONS, type Reference } from '../validate/references.js';
import { cmpStr, type Diagnostic } from '../validate/diagnostic.js';

/** A design: option set ID → the option it chooses, for every set of the document. */
export type Design = Record<string, string>;

/** A checked design (19.5): the primary design (tag undefined) or an option design (tag: its option's ID). */
export interface CheckedDesign {
  readonly tag: string | undefined;
  readonly design: Design;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a document has design options at all (a Core 0.3 document with an option set or an option). */
export function hasOptions(doc: { floorspec?: unknown; optionSets?: unknown; options?: unknown }): boolean {
  return doc.floorspec === '0.3' && ((isObject(doc.optionSets) && Object.keys(doc.optionSets).length > 0) || (isObject(doc.options) && Object.keys(doc.options).length > 0));
}

/** Every extension collection object of a 0.3 document (12.5). */
function extCollections(doc: { floorspec?: unknown; extensions?: unknown }): Record<string, unknown>[] {
  if (doc.floorspec !== '0.3' || !isObject(doc.extensions)) return [];
  const out: Record<string, unknown>[] = [];
  for (const data of Object.values(doc.extensions))
    if (isObject(data) && isObject(data.collections)) for (const c of Object.values(data.collections)) if (isObject(c)) out.push(c);
  return out;
}

/** 19.2: element ID → the option it is in, for every element in an option. */
export function membership(doc: FloorspecDocument): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of IN_OPTIONS) for (const [id, e] of entries(doc[c] as Record<string, { option?: string }> | undefined)) if (e.option !== undefined) out.set(id, e.option);
  for (const coll of extCollections(doc))
    for (const [id, el] of Object.entries(coll)) if (isObject(el) && typeof el.option === 'string') out.set(id, el.option);
  return out;
}

/** The options of a set, sorted by ID. */
export function optionsOf(doc: FloorspecDocument, set: string): string[] {
  return entries(doc.options)
    .filter(([, o]) => o.set === set)
    .map(([id]) => id);
}

/** The primary design (19.3): every set's primary. */
export function primaryDesign(doc: FloorspecDocument): Design {
  const out: Design = {};
  for (const [sid, s] of entries(doc.optionSets)) out[sid] = s.primary;
  return out;
}

/** 19.5: the primary design, then every option design, in order of its option's ID. */
export function checkedDesigns(doc: FloorspecDocument): CheckedDesign[] {
  const primary = primaryDesign(doc);
  const out: CheckedDesign[] = [{ tag: undefined, design: primary }];
  for (const [oid, o] of entries(doc.options)) if (primary[o.set] !== oid) out.push({ tag: oid, design: { ...primary, [o.set]: oid } });
  return out;
}

/**
 * 19.3: the document as seen in a design. Works on any JSON value with the shape of a document,
 * so the schema tier's view of a document (with non-integer numbers marked) has views too.
 */
export function viewOf<T>(doc: T, design: Design): T {
  const d = doc as unknown as Record<string, unknown>;
  const chosen = new Set(Object.values(design));
  const keep = (e: unknown): boolean => !isObject(e) || typeof e.option !== 'string' || chosen.has(e.option);
  const strip = (e: unknown): unknown => {
    if (!isObject(e) || !Object.hasOwn(e, 'option')) return e;
    const rest = { ...e };
    delete rest.option;
    return rest;
  };
  const filter = (c: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [id, e] of Object.entries(c))
      if (keep(e)) Object.defineProperty(out, id, { value: strip(e), enumerable: true, writable: true, configurable: true });
    return out;
  };
  const v: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(d)) if (k !== 'optionSets' && k !== 'options') v[k] = x;
  for (const c of IN_OPTIONS) if (isObject(d[c])) v[c] = filter(d[c]);
  if (d.floorspec === '0.3' && isObject(d.extensions)) {
    const exts: Record<string, unknown> = {};
    for (const [name, data] of Object.entries(d.extensions)) {
      if (isObject(data) && isObject(data.collections)) {
        const colls: Record<string, unknown> = {};
        for (const [cname, coll] of Object.entries(data.collections)) colls[cname] = isObject(coll) ? filter(coll) : coll;
        exts[name] = { ...data, collections: colls };
      } else exts[name] = data;
    }
    v.extensions = exts;
  }
  return v as T;
}

/**
 * A design given as an input (19.6): an object naming option sets of the document, each mapped to
 * one of its own options; every set it does not name takes its primary. Undefined when the input is
 * not such an object.
 */
export function resolveDesign(doc: FloorspecDocument, input: unknown): Design | undefined {
  if (!isObject(input)) return undefined;
  const out = primaryDesign(doc);
  for (const [sid, oid] of Object.entries(input)) {
    if (get(doc.optionSets, sid) === undefined || typeof oid !== 'string') return undefined;
    const o = get(doc.options, oid);
    if (!o || o.set !== sid) return undefined;
    out[sid] = oid;
  }
  return out;
}

/**
 * The checked design a design is: `{ tag: undefined }` for the primary design, `{ tag: option }` for
 * that option's design, or undefined for a design that is not a checked one.
 */
export function checkedTagOf(doc: FloorspecDocument, design: Design): { tag: string | undefined } | undefined {
  const primary = primaryDesign(doc);
  const differ = Object.keys(design)
    .sort(cmpStr)
    .filter((s) => design[s] !== primary[s])
    .map((s) => design[s]!);
  if (!differ.length) return { tag: undefined };
  return differ.length === 1 ? { tag: differ[0] } : undefined;
}

// ── validation ───────────────────────────────────────────────────────────────

export interface OptionProblem {
  readonly code: 'FS-INV-1101' | 'FS-INV-1102';
  readonly elements: string[];
  readonly pointer: string;
}

/** FS-INV-1101 and FS-INV-1102 (19.1.2, 19.4.1), of the document as a whole, once its references resolve. */
export function optionInvariants(doc: FloorspecDocument, refs: readonly Reference[]): OptionProblem[] {
  const out: OptionProblem[] = [];
  for (const [sid, s] of entries(doc.optionSets))
    if (get(doc.options, s.primary)!.set !== sid) out.push({ code: 'FS-INV-1101', elements: [sid, s.primary], pointer: `/optionSets/${sid}/primary` });
  const m = membership(doc);
  const seen = new Set<string>();
  for (const r of refs) {
    if (r.owner === undefined) continue;
    const t = m.get(r.target);
    const key = `${r.owner}\u0000${r.target}`;
    if (t !== undefined && t !== m.get(r.owner) && !seen.has(key)) {
      seen.add(key);
      out.push({ code: 'FS-INV-1102', elements: [r.owner, r.target], pointer: '' });
    }
  }
  return out;
}

/**
 * 19.5.2: per = [tag, diagnostics] of each checked design, the primary design first. Every
 * diagnostic of the primary design is reported as it is; one of an option design is reported, with
 * `design`, unless the primary design has one with the same code, severity and elements not already
 * matched.
 */
export function mergeDesigns(per: readonly { tag: string | undefined; diagnostics: readonly Diagnostic[] }[]): Diagnostic[] {
  if (!per.length) return [];
  const base = per[0]!.diagnostics;
  const out: Diagnostic[] = [...base];
  const key = (d: Diagnostic): string => JSON.stringify([d.code, d.severity, [...d.elements].sort(cmpStr)]);
  for (const { tag, diagnostics } of per.slice(1)) {
    const pool = new Map<string, number>();
    for (const d of base) pool.set(key(d), (pool.get(key(d)) ?? 0) + 1);
    for (const d of diagnostics) {
      const k = key(d);
      const n = pool.get(k) ?? 0;
      if (n > 0) pool.set(k, n - 1);
      else out.push({ ...d, ...(tag !== undefined && { design: tag }) });
    }
  }
  return out;
}

/** FS-LINT-017 (19.8): option sets with exactly one option. */
export function singleOptionSets(doc: FloorspecDocument): string[] {
  const count = new Map<string, number>();
  for (const [, o] of entries(doc.options)) count.set(o.set, (count.get(o.set) ?? 0) + 1);
  return entries(doc.optionSets)
    .map(([sid]) => sid)
    .filter((sid) => count.get(sid) === 1);
}

// ── derived values (19.6.3) ──────────────────────────────────────────────────

/** The derived members keyed by element ID that `affected` does not compare as they stand. */
const NOT_COMPARED = new Set(['program', 'options', 'extensions', 'finishes']);
/** …and those it compares one level down: the program's items, and the rooms and walls of `finishes`. */
const NESTED: readonly [string, string][] = [
  ['program', 'items'],
  ['finishes', 'rooms'],
  ['finishes', 'walls'],
];

/** 19.6.3: the IDs present in both designs' derived values whose values there differ, sorted. */
export function affected(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const compare = (x: Record<string, unknown>, y: Record<string, unknown>): void => {
    for (const i of Object.keys(x)) if (Object.hasOwn(y, i) && !jsonEqual(x[i], y[i])) ids.add(i);
  };
  for (const [k, va] of Object.entries(a)) {
    if (NOT_COMPARED.has(k) || !isObject(va)) continue;
    const vb = b[k];
    if (isObject(vb)) compare(va, vb);
  }
  for (const [top, sub] of NESTED) {
    const pa = a[top];
    const pb = b[top];
    if (isObject(pa) && isObject(pb)) compare(isObject(pa[sub]) ? pa[sub] : {}, isObject(pb[sub]) ? pb[sub] : {});
  }
  return [...ids].sort(cmpStr);
}

export interface DerivedOption {
  /** The IDs of the elements in the option, sorted. */
  members: string[];
  /** Every room of the option's own design, with its net area (6.4). */
  rooms: Record<string, string>;
  /** What differs between the option's design and the primary design (empty for the primary). */
  affected: string[];
}

export interface DerivedOptionSet {
  /** The option the derived design chooses. */
  chosen: string;
  options: Record<string, DerivedOption>;
}

/** 19.6.3: the derived `options` member. `derivedBy` maps each checked design's tag ('' for the primary) to its derived values. */
export function deriveOptions(
  doc: FloorspecDocument,
  design: Design,
  derivedBy: ReadonlyMap<string, { rooms: Record<string, { area: string }> } & Record<string, unknown>>,
): Record<string, DerivedOptionSet> {
  const m = membership(doc);
  const primary = primaryDesign(doc);
  const base = derivedBy.get('')!;
  const out: Record<string, DerivedOptionSet> = {};
  for (const [sid] of entries(doc.optionSets)) {
    const options: Record<string, DerivedOption> = {};
    for (const oid of optionsOf(doc, sid)) {
      const dv = oid === primary[sid] ? base : derivedBy.get(oid)!;
      const rooms: Record<string, string> = {};
      for (const [rid, r] of entries(dv.rooms)) rooms[rid] = r.area;
      options[oid] = {
        members: [...m]
          .filter(([, o]) => o === oid)
          .map(([e]) => e)
          .sort(cmpStr),
        rooms,
        affected: affected(base, dv),
      };
    }
    out[sid] = { chosen: design[sid]!, options };
  }
  return out;
}
