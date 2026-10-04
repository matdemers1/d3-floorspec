/**
 * Small JSON helpers. A working copy is plain JSON whose member names come from documents and
 * requests, so a member is never written with `obj[key] = v` (a name like `__proto__` would reach
 * the prototype) and never read without `Object.hasOwn`.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = Record<string, unknown>;

export const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

export function has(o: unknown, key: string): boolean {
  return isObject(o) && Object.hasOwn(o, key);
}

export function getMember(o: unknown, key: string): unknown {
  return isObject(o) && Object.hasOwn(o, key) ? o[key] : undefined;
}

/** Define an own, enumerable data member, whatever its name. */
export function setMember(o: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

export function deleteMember(o: JsonObject, key: string): void {
  if (Object.hasOwn(o, key)) Reflect.deleteProperty(o, key);
}

/** A deep copy of a JSON value, keeping every member as an own data member. */
export function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x: unknown) => clone(x)) as T;
  if (isObject(v)) {
    const out: JsonObject = {};
    for (const k of Object.keys(v)) setMember(out, k, clone(v[k]));
    return out as T;
  }
  return v;
}

/** Compare strings as sequences of UTF-16 code units (how Floorspec sorts IDs and member names). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const sortedKeys = (o: unknown): string[] => (isObject(o) ? Object.keys(o).sort(cmpStr) : []);

/** Decode one JSON Pointer reference token (RFC 6901). */
export const unescapeToken = (t: string): string => t.replace(/~1/g, '/').replace(/~0/g, '~');
export const escapeToken = (t: string | number): string => String(t).replace(/~/g, '~0').replace(/\//g, '~1');

/** Split a JSON Pointer into its tokens; undefined when it is not a pointer (does not start with `/`). */
export function parsePointer(p: string): string[] | undefined {
  if (p === '') return [];
  if (!p.startsWith('/')) return undefined;
  const tokens = p.slice(1).split('/');
  // `~` must be followed by 0 or 1.
  if (tokens.some((t) => /~(?![01])/.test(t))) return undefined;
  return tokens.map(unescapeToken);
}

export const toPointer = (tokens: readonly (string | number)[]): string => tokens.map((t) => '/' + escapeToken(t)).join('');
