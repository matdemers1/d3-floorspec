/**
 * Canonical form (9.2) and content hash (9.3).
 *
 * Step 1 — omit constant defaults — walks the document beside the bundled Core 0.2 schema, whose
 * `default` keywords are exactly the constant defaults of Core 0.2 (schema/core/README.md). Members
 * with a derived default and typed properties carry no `default`, so they are never removed. The
 * content of extension data — including Core 0.2's extension elements (12.5) — and of `extras` is
 * never touched; the member itself goes only when it is `{}`, its default. A declaration object
 * in `extensionsUsed` without a `schema` is written as its version string (12.1).
 *
 * One canonicalizer serves both drafts: Core 0.2 only adds members, each with Core 0.1's meaning
 * when absent (1.2.4), and none of the rules 0.2 adds can apply to a valid 0.1 document.
 */
import { SCHEMA } from '../generated/schema.js';
import { sha256Hex } from '../hash/sha256.js';
import { writeJcs, writePretty } from '../json/serialize.js';

type Schema = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function resolveRef(ref: string): Schema {
  if (!ref.startsWith('#')) throw new Error(`unsupported $ref ${ref}`);
  let node: unknown = SCHEMA;
  for (const raw of ref.slice(1).split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = (node as Record<string, unknown>)[key];
    if (node === undefined) throw new Error(`unresolvable $ref ${ref}`);
  }
  return node as Schema;
}

/** Deep equality of JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** A shallow structural match, enough to choose the branch of a `oneOf` / `anyOf` a valid value is in. */
function matches(value: unknown, schema: Schema): boolean {
  const s = flatten(schema);
  if (s.type === 'object' && !isObject(value)) return false;
  if (s.type === 'array' && !Array.isArray(value)) return false;
  if (s.type === 'string' && typeof value !== 'string') return false;
  if ('const' in s && !jsonEqual(value, s.const)) return false;
  if (Array.isArray(s.enum) && !s.enum.some((e) => jsonEqual(e, value))) return false;
  if (isObject(value)) {
    if (Array.isArray(s.required) && !s.required.every((r) => Object.hasOwn(value, r as string))) return false;
    const props = isObject(s.properties) ? s.properties : {};
    if (s.additionalProperties === false && !Object.keys(value).every((k) => Object.hasOwn(props, k))) return false;
    for (const [k, sub] of Object.entries(props)) {
      if (!Object.hasOwn(value, k)) continue;
      const f = flatten(sub as Schema);
      if ('const' in f && !jsonEqual(value[k], f.const)) return false;
      if (Array.isArray(f.enum) && !f.enum.some((e) => jsonEqual(e, value[k]))) return false;
    }
  }
  return true;
}

/** Follow `$ref`s, merging sibling keywords (the referring schema's own keywords win). */
function flatten(schema: Schema): Schema {
  let s = schema;
  const merged: Schema = {};
  for (let guard = 0; guard < 64; guard++) {
    for (const [k, v] of Object.entries(s)) if (k !== '$ref' && !(k in merged)) merged[k] = v;
    if (typeof s.$ref !== 'string') return merged;
    s = resolveRef(s.$ref);
  }
  throw new Error('$ref chain too deep');
}

/** The applicable schema for a value: its own keywords plus the branch of oneOf/anyOf it is in. */
function applicable(value: unknown, schema: Schema): Schema {
  const s = flatten(schema);
  const out: Schema = { ...s };
  const props: Record<string, unknown> = isObject(s.properties) ? { ...s.properties } : {};
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = s[key];
    if (!Array.isArray(branches)) continue;
    for (const b of branches as Schema[]) {
      if (key !== 'allOf' && !matches(value, b)) continue;
      const fb = applicable(value, b);
      // A branch's member schemas refine the parent's: both apply, and the branch carries the
      // defaults of the members it adds.
      if (isObject(fb.properties)) for (const [k, v] of Object.entries(fb.properties)) props[k] = k in props ? { allOf: [props[k], v] } : v;
      if ('additionalProperties' in fb && !('additionalProperties' in out)) out.additionalProperties = fb.additionalProperties;
      if ('items' in fb && !('items' in out)) out.items = fb.items;
      if (key !== 'allOf') break;
    }
  }
  out.properties = props;
  return out;
}

/** The constant default of a member schema, if it has one (on the schema or along its $refs/allOf). */
function defaultOf(schema: Schema): { value: unknown } | undefined {
  const s = flatten(schema);
  if ('default' in s) return { value: s.default };
  if (Array.isArray(s.allOf)) for (const b of s.allOf as Schema[]) {
    const d = defaultOf(b);
    if (d) return d;
  }
  return undefined;
}

function memberSchema(s: Schema, key: string): Schema | undefined {
  const props = s.properties as Record<string, Schema>;
  if (Object.hasOwn(props, key)) return props[key];
  if (isObject(s.patternProperties))
    for (const [pat, sub] of Object.entries(s.patternProperties)) if (new RegExp(pat, 'u').test(key)) return sub as Schema;
  if (isObject(s.additionalProperties)) return s.additionalProperties;
  return undefined;
}

function stripSchemaKeywords(value: unknown, schema: Schema): unknown {
  if (Array.isArray(value)) {
    const s = applicable(value, schema);
    const items = isObject(s.items) ? (s.items as Schema) : undefined;
    return items ? value.map((v) => strip(v, items)) : value;
  }
  if (!isObject(value)) return value;
  const s = applicable(value, schema);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const sub = memberSchema(s, key);
    let v = value[key];
    if (sub) {
      // Extension data and extras are never changed (9.2), whatever their schemas describe.
      if (key !== 'extensions' && key !== 'extras') v = strip(v, sub);
      const d = defaultOf(sub);
      if (d && jsonEqual(v, d.value)) continue;
    }
    Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function strip(value: unknown, schema: Schema): unknown {
  // allOf member schemas (built by `applicable` when a branch refines a member) apply together.
  const f = flatten(schema);
  if (Array.isArray(f.allOf) && !isObject(f.properties) && f.type === undefined) {
    let v = value;
    for (const b of f.allOf as Schema[]) v = stripSchemaKeywords(v, b);
    return v;
  }
  return stripSchemaKeywords(value, schema);
}

/** 9.2 step 1: the document with every member equal to its constant default removed. */
export function omitDefaults(doc: unknown): unknown {
  const schema: Schema = SCHEMA;
  const out = strip(doc, schema);
  // 12.1: `{ "version": v }` is written `v`.
  if (isObject(out) && isObject(out.extensionsUsed)) {
    const used = out.extensionsUsed;
    for (const k of Object.keys(used)) {
      const d = used[k];
      if (isObject(d) && Object.keys(d).length === 1 && Object.hasOwn(d, 'version'))
        Object.defineProperty(used, k, { value: d.version, enumerable: true, writable: true, configurable: true });
    }
  }
  return out;
}

/** The canonical form (9.2) of a valid document, as a string ending in one line feed. */
export function canonicalize(doc: unknown): string {
  return writePretty(omitDefaults(doc));
}

/** The content hash (9.3): SHA-256 of the RFC 8785 serialization after 9.2 step 1, in hex. */
export function contentHash(doc: unknown): string {
  return sha256Hex(writeJcs(omitDefaults(doc)));
}
