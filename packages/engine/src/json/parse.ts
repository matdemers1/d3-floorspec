/**
 * The strict reader of 9.1: a JSON text (RFC 8259) in UTF-8, without a byte order mark, with no
 * duplicate member names and no unpaired surrogates (the I-JSON rules of RFC 7493).
 *
 * `JSON.parse` cannot be used: it keeps the last of two duplicate members without saying so, and
 * accepts lone surrogates. This is a small iterative tokenizer (no recursion, so nesting depth is
 * bounded only by memory) that reports
 *
 * - FS-JSON-001 — not well-formed UTF-8, not a well-formed JSON text, or a byte order mark;
 * - FS-JSON-002 — a duplicate member name, compared after unescaping;
 * - FS-JSON-003 — an unpaired surrogate, written literally or as a `\u` escape;
 *
 * and records every number written with a fraction or an exponent, because a length written `1.0`
 * is not a JSON integer (2.1.1) although it parses to one.
 */
import type { Diagnostic } from '../validate/diagnostic.js';
import { pointer, type JsonPath } from './pointer.js';

export interface ParseResult {
  /** The parsed value; absent when the text is not well-formed (FS-JSON-001). */
  value?: unknown;
  /** FS-JSON-* diagnostics, in the order found. Empty when the text is a valid I-JSON text. */
  diagnostics: Diagnostic[];
  /** Paths of the numbers written with a fraction or an exponent. */
  nonIntegerLiterals: JsonPath[];
}

class Malformed extends Error {}

/** Decode UTF-8, refusing a BOM and every ill-formed sequence: overlong forms, encoded surrogate
 * code points and anything above U+10FFFF (RFC 3629). */
function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    throw new Malformed('the text begins with a byte order mark');
  const units: number[] = [];
  const chunks: string[] = [];
  const flush = (): void => {
    if (units.length) {
      chunks.push(String.fromCharCode(...units));
      units.length = 0;
    }
  };
  let i = 0;
  const n = bytes.length;
  const cont = (k: number): number => {
    const b = bytes[k];
    if (b === undefined || (b & 0xc0) !== 0x80) throw new Malformed(`malformed UTF-8 at byte ${k}`);
    return b & 0x3f;
  };
  while (i < n) {
    const b0 = bytes[i]!;
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
      i += 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      cp = ((b0 & 0x1f) << 6) | cont(i + 1);
      i += 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      cp = ((b0 & 0x0f) << 12) | (cont(i + 1) << 6) | cont(i + 2);
      if (cp < 0x800) throw new Malformed(`overlong UTF-8 at byte ${i}`);
      // A surrogate code point encoded directly is ill-formed UTF-8 (9.1: FS-JSON-001, not 003).
      if (cp >= 0xd800 && cp <= 0xdfff) throw new Malformed(`an encoded surrogate code point at byte ${i}`);
      i += 3;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      cp = ((b0 & 0x07) << 18) | (cont(i + 1) << 12) | (cont(i + 2) << 6) | cont(i + 3);
      if (cp < 0x10000 || cp > 0x10ffff) throw new Malformed(`invalid UTF-8 at byte ${i}`);
      i += 4;
    } else {
      throw new Malformed(`malformed UTF-8 at byte ${i}`);
    }
    if (cp >= 0x10000) {
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else {
      units.push(cp);
    }
    if (units.length >= 8192) flush();
  }
  flush();
  return chunks.join('');
}

/** A path as a linked list from the leaf, so nesting n deep costs O(n), not O(n²). */
type PathNode = { readonly parent: PathNode; readonly key: string | number } | undefined;

function materialize(node: PathNode): JsonPath {
  const out: (string | number)[] = [];
  for (let n = node; n; n = n.parent) out.push(n.key);
  return out.reverse();
}

type Frame =
  | { kind: 'object'; value: Record<string, unknown>; keys: Set<string>; path: PathNode; key: string | undefined }
  | { kind: 'array'; value: unknown[]; path: PathNode };

const isHigh = (u: number): boolean => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number): boolean => u >= 0xdc00 && u <= 0xdfff;

/** Parse a Floorspec JSON text, given as UTF-8 bytes or as an already-decoded string. */
export function parseJson(input: string | Uint8Array): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const nonIntegerLiterals: JsonPath[] = [];
  let text: string;
  try {
    if (typeof input === 'string') {
      if (input.charCodeAt(0) === 0xfeff) throw new Malformed('the text begins with a byte order mark');
      text = input;
    } else {
      text = decodeUtf8(input);
    }
    const value = parseText(text, diagnostics, nonIntegerLiterals);
    return { value, diagnostics, nonIntegerLiterals };
  } catch (e) {
    if (e instanceof Malformed)
      return {
        diagnostics: [{ code: 'FS-JSON-001', severity: 'error', message: `Not a well-formed UTF-8 JSON text: ${e.message}.`, elements: [], location: {} }],
        nonIntegerLiterals: [],
      };
    throw e;
  }
}

function parseText(s: string, diagnostics: Diagnostic[], nonIntegerLiterals: JsonPath[]): unknown {
  let i = 0;
  const n = s.length;
  const ws = (): void => {
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const fail = (what: string): never => {
    throw new Malformed(`${what} at offset ${i}`);
  };

  const readString = (path: PathNode, isKey: boolean): string => {
    // s[i] is the opening quote
    i++;
    const units: number[] = [];
    for (;;) {
      if (i >= n) fail('unterminated string');
      const c = s.charCodeAt(i);
      if (c === 0x22) {
        break;
      } else if (c === 0x5c) {
        const e = s.charCodeAt(i + 1);
        let u: number;
        switch (e) {
          case 0x22: u = 0x22; break;
          case 0x5c: u = 0x5c; break;
          case 0x2f: u = 0x2f; break;
          case 0x62: u = 0x08; break;
          case 0x66: u = 0x0c; break;
          case 0x6e: u = 0x0a; break;
          case 0x72: u = 0x0d; break;
          case 0x74: u = 0x09; break;
          case 0x75: {
            const hex = s.slice(i + 2, i + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail('invalid \\u escape');
            u = parseInt(hex, 16);
            i += 4;
            break;
          }
          default:
            return fail('invalid escape');
        }
        i += 2;
        units.push(u);
      } else if (c < 0x20) {
        return fail('unescaped control character in a string');
      } else {
        units.push(c);
        i++;
      }
    }
    i++; // closing quote
    // Any surrogate left unpaired after unescaping is FS-JSON-003.
    let unpaired = false;
    for (let k = 0; k < units.length; k++) {
      const u = units[k]!;
      if (isHigh(u) && k + 1 < units.length && isLow(units[k + 1]!)) {
        k++;
      } else if (isHigh(u) || isLow(u)) {
        unpaired = true;
      }
    }
    if (unpaired)
      diagnostics.push({
        code: 'FS-JSON-003',
        severity: 'error',
        message: `A ${isKey ? 'member name' : 'string'} contains an unpaired surrogate.`,
        elements: [],
        location: { pointer: pointer(materialize(path)) },
      });
    let out = '';
    for (let k = 0; k < units.length; k += 8192) out += String.fromCharCode(...units.slice(k, k + 8192));
    return out;
  };

  const readNumber = (path: PathNode): number => {
    const m = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(s.slice(i, i + 4096));
    if (!m || m[0].length === 0 || m[0] === '-') return fail('invalid number');
    const lit = m[0];
    // A literal longer than the window would have been cut; refuse rather than misread it.
    if (lit.length === 4096) fail('number literal too long');
    i += lit.length;
    if (m[1] !== undefined || m[2] !== undefined) nonIntegerLiterals.push(materialize(path));
    return Number(lit);
  };

  const readLiteral = (): unknown => {
    if (s.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (s.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (s.startsWith('null', i)) {
      i += 4;
      return null;
    }
    return fail('unexpected character');
  };

  const stack: Frame[] = [];
  let root: unknown;

  const attach = (v: unknown): void => {
    const top = stack[stack.length - 1];
    if (!top) {
      root = v;
    } else if (top.kind === 'array') {
      top.value.push(v);
    } else {
      const key = top.key!;
      // defineProperty, so a member named "__proto__" is an ordinary member.
      Object.defineProperty(top.value, key, { value: v, enumerable: true, writable: true, configurable: true });
      top.key = undefined;
    }
  };
  const childPath = (): PathNode => {
    const top = stack[stack.length - 1];
    if (!top) return undefined;
    return { parent: top.path, key: top.kind === 'array' ? top.value.length : top.key! };
  };

  // States: expecting a value; after a value (expect , or close); expecting a key.
  ws();
  let expectValue = true;
  for (;;) {
    if (expectValue) {
      ws();
      if (i >= n) fail('unexpected end of text');
      const c = s.charCodeAt(i);
      const path = childPath();
      if (c === 0x7b) {
        i++;
        const obj: Record<string, unknown> = {};
        attach(obj);
        stack.push({ kind: 'object', value: obj, keys: new Set(), path, key: undefined });
        ws();
        if (s.charCodeAt(i) === 0x7d) {
          i++;
          stack.pop();
          expectValue = false;
        } else {
          readKey();
        }
        continue;
      }
      if (c === 0x5b) {
        i++;
        const arr: unknown[] = [];
        attach(arr);
        stack.push({ kind: 'array', value: arr, path });
        ws();
        if (s.charCodeAt(i) === 0x5d) {
          i++;
          stack.pop();
          expectValue = false;
        }
        continue;
      }
      if (c === 0x22) attach(readString(path, false));
      else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) attach(readNumber(path));
      else attach(readLiteral());
      expectValue = false;
      continue;
    }
    // after a value
    ws();
    const top = stack[stack.length - 1];
    if (!top) break;
    const c = s.charCodeAt(i);
    if (c === 0x2c) {
      i++;
      if (top.kind === 'object') readKey();
      expectValue = true;
      continue;
    }
    if ((top.kind === 'object' && c === 0x7d) || (top.kind === 'array' && c === 0x5d)) {
      i++;
      stack.pop();
      continue;
    }
    fail(i >= n ? 'unexpected end of text' : 'expected , or a closing bracket');
  }
  ws();
  if (i < n) fail('unexpected text after the value');
  return root;

  function readKey(): void {
    ws();
    const top = stack[stack.length - 1];
    if (top?.kind !== 'object') return fail('internal: key outside an object');
    if (s.charCodeAt(i) !== 0x22) fail('expected a member name');
    const key = readString(top.path, true);
    ws();
    if (s.charCodeAt(i) !== 0x3a) fail('expected :');
    i++;
    if (top.keys.has(key)) {
      diagnostics.push({
        code: 'FS-JSON-002',
        severity: 'error',
        message: `An object has the member name ${JSON.stringify(key)} twice.`,
        elements: [],
        location: { pointer: pointer([...materialize(top.path), key]) },
      });
    }
    top.keys.add(key);
    top.key = key;
    expectValue = true;
  }
}
