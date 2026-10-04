import { createHash } from 'node:crypto';

/**
 * Canonical Floorspec JSON and its content hash.
 *
 * TEMPORARY: this lives in the server only until `@floorspec/engine` exports `canonicalize` and
 * `contentHash` (FLR-T-1.4). From then on the server must import them from the engine and this file
 * must be deleted — two canonicalisers are two answers to "what is this document's hash", and the
 * engine's is the one the conformance suite checks (FLR-ADR-009, FLR-ADR-010).
 *
 * Two serialisations of the same value:
 *   - `jcs` is RFC 8785 (JSON Canonicalization Scheme): no whitespace, object keys sorted by UTF-16
 *     code units, numbers as ECMAScript prints them. It is what is hashed.
 *   - `canonicalJson` is the file form: the same key order and number spelling, two-space indent,
 *     LF line endings and a final newline. It is what a person downloads and diffs.
 *
 * Both are hand-written serialisers rather than `JSON.stringify` over a sorted copy, because a
 * JavaScript object enumerates integer-like keys ("9", "10") in numeric order whatever order they
 * were inserted in, and JCS wants "10" before "9".
 */

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export class CanonicalError extends Error {}

function number(value: number): string {
  if (!Number.isFinite(value)) throw new CanonicalError('NaN and Infinity have no JSON form');
  // ECMAScript Number::toString, which is exactly what RFC 8785 §3.2.2.3 prescribes; -0 prints "0".
  return JSON.stringify(value);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function string(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new CanonicalError('a string holds a lone surrogate, which is not Unicode');
  // ECMAScript JSON string escaping, which RFC 8785 §3.2.2.2 adopts.
  return JSON.stringify(value);
}

/** Keys in UTF-16 code-unit order: JavaScript's default string comparison is exactly that. */
function keysOf(value: { readonly [key: string]: Json }): string[] {
  return Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function serialise(value: Json, indent: string | null, depth: number): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return number(value);
  if (typeof value === 'string') return string(value);

  const pad = indent === null ? '' : `\n${indent.repeat(depth + 1)}`;
  const close = indent === null ? '' : `\n${indent.repeat(depth)}`;
  const colon = indent === null ? ':' : ': ';

  if (Array.isArray(value)) {
    const items = value as readonly Json[];
    if (items.length === 0) return '[]';
    return `[${items.map((item) => `${pad}${serialise(item, indent, depth + 1)}`).join(',')}${close}]`;
  }

  const object = value as { readonly [key: string]: Json };
  const keys = keysOf(object);
  if (keys.length === 0) return '{}';
  return `{${keys
    .map((key) => {
      const inner = object[key];
      if (inner === undefined) throw new CanonicalError(`"${key}" is undefined, which has no JSON form`);
      return `${pad}${string(key)}${colon}${serialise(inner, indent, depth + 1)}`;
    })
    .join(',')}${close}}`;
}

/** RFC 8785 JCS serialisation. */
export function jcs(value: Json): string {
  return serialise(value, null, 0);
}

/** The canonical file form: JCS order and numbers, 2-space indent, LF, final newline. */
export function canonicalJson(value: Json): string {
  return `${serialise(value, '  ', 0)}\n`;
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of the JCS serialisation. */
export function contentHash(value: Json): string {
  return createHash('sha256').update(jcs(value), 'utf8').digest('hex');
}
