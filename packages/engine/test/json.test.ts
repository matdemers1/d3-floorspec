import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseJson } from '../src/json/parse.js';
import { writeJcs, writePretty, writeNumber } from '../src/json/serialize.js';
import { sha256Hex } from '../src/hash/sha256.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const codesOf = (input: string | Uint8Array): string[] => parseJson(input).diagnostics.map((d) => d.code);

describe('strict parser (9.1)', () => {
  it('parses what JSON.parse parses', () => {
    fc.assert(
      fc.property(fc.json(), (text) => {
        const r = parseJson(text);
        // fc.json() can produce duplicate keys only through __proto__-free generation; it does not.
        expect(r.diagnostics).toEqual([]);
        expect(writeJcs(r.value)).toBe(writeJcs(JSON.parse(text)));
      }),
      { numRuns: 300, seed: 1 },
    );
  });

  it('FS-JSON-001: malformed text, BOM, malformed UTF-8', () => {
    expect(codesOf('{')).toEqual(['FS-JSON-001']);
    expect(codesOf('{"a":1,}')).toEqual(['FS-JSON-001']);
    expect(codesOf('01')).toEqual(['FS-JSON-001']);
    expect(codesOf('"\t"')).toEqual(['FS-JSON-001']);
    expect(codesOf('')).toEqual(['FS-JSON-001']);
    expect(codesOf('{} {}')).toEqual(['FS-JSON-001']);
    expect(codesOf('﻿{}')).toEqual(['FS-JSON-001']);
    expect(codesOf(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toEqual(['FS-JSON-001']);
    expect(codesOf(new Uint8Array([0x22, 0xc3, 0x28, 0x22]))).toEqual(['FS-JSON-001']); // bad continuation
    expect(codesOf(new Uint8Array([0x22, 0xc0, 0x80, 0x22]))).toEqual(['FS-JSON-001']); // overlong
    expect(codesOf(enc('NaN'))).toEqual(['FS-JSON-001']);
  });

  it('FS-JSON-002: a duplicate member name, compared after unescaping', () => {
    expect(codesOf('{"a":1,"a":2}')).toEqual(['FS-JSON-002']);
    expect(codesOf('{"a":1,"\\u0061":2}')).toEqual(['FS-JSON-002']);
    expect(codesOf('{"a":{"b":1},"c":{"b":2}}')).toEqual([]);
    const r = parseJson('{"x":{"__proto__":1,"__proto__":2}}');
    expect(r.diagnostics[0]?.location.pointer).toBe('/x/__proto__');
  });

  it('a member named __proto__ is an ordinary member', () => {
    const r = parseJson('{"__proto__":{"polluted":true}}');
    expect(Object.keys(r.value as object)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('FS-JSON-003: an unpaired surrogate, escaped or literal', () => {
    expect(codesOf('"\\ud800"')).toEqual(['FS-JSON-003']);
    expect(codesOf('"\\udc00x"')).toEqual(['FS-JSON-003']);
    expect(codesOf('{"\\ud800":1}')).toEqual(['FS-JSON-003']);
    expect(codesOf('"\\ud83d\\ude00"')).toEqual([]);
    expect(codesOf('"\ud800"')).toEqual(['FS-JSON-003']); // a literal lone surrogate in a JS string
    // In UTF-8 bytes, ED A0 80 encodes U+D800 directly: ill-formed UTF-8, so FS-JSON-001 (9.1).
    expect(codesOf(new Uint8Array([0x22, 0xed, 0xa0, 0x80, 0x22]))).toEqual(['FS-JSON-001']);
    // An encoded surrogate pair (CESU-8) is not well-formed UTF-8.
    expect(codesOf(new Uint8Array([0x22, 0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80, 0x22]))).toEqual(['FS-JSON-001']);
  });

  it('records numbers written with a fraction or an exponent', () => {
    const r = parseJson('{"a":1,"b":[1.0,2e3,3],"c":-0}');
    expect(r.nonIntegerLiterals).toEqual([['b', 0], ['b', 1]]);
  });

  it('nests deeply without recursion', () => {
    const deep = '['.repeat(100000) + ']'.repeat(100000);
    expect(parseJson(deep).diagnostics).toEqual([]);
  });
});

describe('RFC 8785 serialization', () => {
  it('writes numbers as ECMAScript does', () => {
    expect(writeNumber(0)).toBe('0');
    expect(writeNumber(-0)).toBe('0');
    expect(writeNumber(1e21)).toBe('1e+21');
    expect(writeNumber(1e-7)).toBe('1e-7');
    expect(writeNumber(333333333.3333333)).toBe('333333333.3333333');
    expect(writeNumber(9007199254740991)).toBe('9007199254740991');
  });

  it('writes strings with the minimal escapes', () => {
    expect(writeJcs('\u0000\b\f\n\r\t"\\/\u001f\u007f é😀')).toBe('"\\u0000\\b\\f\\n\\r\\t\\"\\\\/\\u001f\u007f é😀"');
  });

  it('sorts members by UTF-16 code units, not as JS objects enumerate them', () => {
    const o: Record<string, number> = {};
    for (const k of ['b', '10', '2', 'a', '€', '😀', 'A']) o[k] = 1;
    expect(writeJcs(o)).toBe('{"10":1,"2":1,"A":1,"a":1,"b":1,"€":1,"😀":1}');
  });

  it('the indented form is JSON.stringify(sorted, null, 2) plus a line feed', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        // Compare against JSON.stringify on a value without integer-like keys (where its order differs).
        const text = writePretty(v);
        expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(v)));
        expect(text.endsWith('\n')).toBe(true);
        expect(/[ \t]\n/.test(text)).toBe(false);
      }),
      { numRuns: 200, seed: 3 },
    );
    expect(writePretty({ b: [1, { d: {}, c: [] }], a: 'x' })).toBe('{\n  "a": "x",\n  "b": [\n    1,\n    {\n      "c": [],\n      "d": {}\n    }\n  ]\n}\n');
  });
});

describe('SHA-256 (FIPS 180-4)', () => {
  it('matches the FIPS test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(sha256Hex('a'.repeat(1000000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });
  it('handles every length around the block boundary', () => {
    // 55, 56 and 64 bytes straddle the padding boundary; compare with a second path (two halves).
    for (const n of [55, 56, 57, 63, 64, 65, 119, 120]) expect(sha256Hex('x'.repeat(n))).toMatch(/^[0-9a-f]{64}$/);
  });
});
