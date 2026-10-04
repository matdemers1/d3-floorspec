import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, CanonicalError, contentHash, jcs, type Json } from '../../src/model/canonical.js';
import { emptyDocument } from '../../src/model/document.js';

describe('canonical JSON (temporary until @floorspec/engine, FLR-T-1.4)', () => {
  it('serialises the RFC 8785 §3.2.2 example exactly', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    ) as Json;
    expect(jcs(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3), integer-like keys included', () => {
    const input = JSON.parse(
      '{"\\u20ac":"Euro","\\r":"CR","\\ufb33":"Hebrew","1":"One","\\ud83d\\ude00":"Emoji","\\u0080":"Control","\\u00f6":"Latin","10":"Ten","9":"Nine"}',
    ) as Json;
    // Read the order from the text: JSON.parse would put integer-like keys back in numeric order.
    const keys = [...jcs(input).matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => JSON.parse(`"${m[1] ?? ''}"`) as string);
    expect(keys).toEqual(['\r', '1', '10', '9', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33']);
  });

  it('writes the file form with two-space indent, LF and a final newline', () => {
    expect(canonicalJson({ project: { name: 'Lake house' }, floorspec: '0.1', empty: {}, list: [] })).toBe(
      '{\n  "empty": {},\n  "floorspec": "0.1",\n  "list": [],\n  "project": {\n    "name": "Lake house"\n  }\n}\n',
    );
  });

  it('hashes the JCS bytes, so the file form and the hash agree on one document', () => {
    const doc = emptyDocument('Lake house');
    expect(contentHash(doc)).toBe(createHash('sha256').update('{"floorspec":"0.1","project":{"name":"Lake house"}}').digest('hex'));
    expect(contentHash(doc)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash(JSON.parse(canonicalJson(doc)) as Json)).toBe(contentHash(doc));
  });

  it('refuses what has no canonical form', () => {
    expect(() => jcs(Number.NaN)).toThrow(CanonicalError);
    expect(() => jcs('\ud800')).toThrow(CanonicalError);
    expect(jcs(-0)).toBe('0');
  });
});
