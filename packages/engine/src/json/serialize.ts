/**
 * JSON writers for canonical form (9.2) and the content hash (9.3): RFC 8785 (JCS) strings and
 * numbers, object members sorted by UTF-16 code units.
 *
 * Neither writer uses `JSON.stringify` on objects: a JS object enumerates integer-like member names
 * ("2", "10") before all others in numeric order, which is not the code-unit order RFC 8785 sorts
 * by, and element IDs may be all digits.
 */

const ESCAPES: Record<number, string> = { 0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0c: '\\f', 0x0d: '\\r', 0x22: '\\"', 0x5c: '\\\\' };

/** A string as RFC 8785 §3.2.2.2 writes it. Refuses an unpaired surrogate (9.1.3). */
export function writeString(s: string): string {
  let out = '"';
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      const next = s.charCodeAt(i + 1);
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      throw new TypeError('cannot serialize a string with an unpaired surrogate');
    }
    if (c < 0x20 || c === 0x22 || c === 0x5c) {
      out += s.slice(run, i) + (ESCAPES[c] ?? '\\u' + c.toString(16).padStart(4, '0'));
      run = i + 1;
    }
  }
  return out + s.slice(run) + '"';
}

/** A number as RFC 8785 §3.2.2.3 writes it: ECMAScript's Number serialization. */
export function writeNumber(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError(`cannot serialize ${n}: RFC 8785 numbers are finite`);
  return n === 0 ? '0' : String(n);
}

function sortedKeys(o: object): string[] {
  return Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The compact RFC 8785 serialization. */
export function writeJcs(value: unknown): string {
  const parts: string[] = [];
  const walk = (v: unknown): void => {
    if (v === null) parts.push('null');
    else if (v === true) parts.push('true');
    else if (v === false) parts.push('false');
    else if (typeof v === 'number') parts.push(writeNumber(v));
    else if (typeof v === 'string') parts.push(writeString(v));
    else if (Array.isArray(v)) {
      parts.push('[');
      v.forEach((x, i) => {
        if (i) parts.push(',');
        walk(x);
      });
      parts.push(']');
    } else if (isPlainObject(v)) {
      parts.push('{');
      sortedKeys(v).forEach((k, i) => {
        if (i) parts.push(',');
        parts.push(writeString(k), ':');
        walk(v[k]);
      });
      parts.push('}');
    } else throw new TypeError(`cannot serialize a value of type ${typeof v}`);
  };
  walk(value);
  return parts.join('');
}

/**
 * The indented form of 9.2 step 2: exactly `JSON.stringify(sorted, null, 2)` with RFC 8785 strings
 * and numbers, followed by one line feed.
 */
export function writePretty(value: unknown): string {
  const parts: string[] = [];
  const walk = (v: unknown, indent: string): void => {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        parts.push('[]');
        return;
      }
      const inner = indent + '  ';
      parts.push('[\n');
      v.forEach((x, i) => {
        parts.push(inner);
        walk(x, inner);
        parts.push(i < v.length - 1 ? ',\n' : '\n');
      });
      parts.push(indent, ']');
    } else if (isPlainObject(v)) {
      const keys = sortedKeys(v);
      if (keys.length === 0) {
        parts.push('{}');
        return;
      }
      const inner = indent + '  ';
      parts.push('{\n');
      keys.forEach((k, i) => {
        parts.push(inner, writeString(k), ': ');
        walk(v[k], inner);
        parts.push(i < keys.length - 1 ? ',\n' : '\n');
      });
      parts.push(indent, '}');
    } else {
      parts.push(writeJcs(v));
    }
  };
  walk(value, '');
  parts.push('\n');
  return parts.join('');
}
