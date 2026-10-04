/**
 * The engine in a real browser (FLR-ADR-010). Runs only in the `browser` project: derives every
 * determinism fixture in Chromium and compares the results, byte for byte, with Node's; then runs
 * the whole conformance suite in the browser too.
 */
import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { check } from '../src/index.js';
import { fixtures } from './fixtures.js';

const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

describe('in the browser', () => {
  it('derives exactly what Node derives', async () => {
    const node = await commands.checkFixturesInNode();
    const here = fixtures().map((f) => ({ name: f.name, result: JSON.stringify(check(f.doc)) }));
    expect(here.length).toBeGreaterThan(40);
    expect(here).toEqual(node);
  });

  it('passes the conformance suite', async () => {
    const cases = await commands.conformanceCases();
    expect(cases.length).toBeGreaterThan(0);
    let passed = 0;
    for (const c of cases) {
      const expected = JSON.parse(c.expected) as { valid: boolean; diagnostics: { code: string }[]; hash?: string; derived?: unknown };
      const r = check(fromBase64(c.input));
      const actual = r.diagnostics.map((d) => ({ code: d.code, severity: d.severity, elements: d.elements }));
      const schemaOnly = expected.diagnostics.length === 1 && expected.diagnostics[0]!.code === 'FS-SCH-001';
      const diagOk = schemaOnly ? actual.length > 0 && actual.every((d) => d.code === 'FS-SCH-001') : JSON.stringify(actual) === JSON.stringify(expected.diagnostics);
      expect({ name: c.name, diagOk }).toEqual({ name: c.name, diagOk: true });
      expect(r.valid).toBe(expected.valid);
      expect(r.hash).toBe(expected.hash);
      expect(r.canonical ?? null).toBe(c.canonical);
      expect(r.derived).toEqual(expected.derived);
      passed++;
    }
    expect(passed).toBe(cases.length);
  });
});
