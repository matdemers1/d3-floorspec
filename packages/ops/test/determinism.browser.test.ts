/**
 * The applier in a real browser (FLR-ADR-010). Runs only in the `browser` project: applies every
 * determinism fixture in Chromium and compares the results, byte for byte, with Node's (1.3.2);
 * then runs every Ops conformance suite in the browser too, each as its own draft, and the official
 * extensions' Ops cases.
 */
import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { apply } from '../src/index.js';
import { checkCase } from './check.js';
import { fixtures } from './fixtures.js';

const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

describe('in the browser', () => {
  it('applies exactly what Node applies', async () => {
    const node = await commands.applyFixturesInNode();
    const here = fixtures().map((f) => ({ name: f.name, result: JSON.stringify(apply(f.doc, f.request)) }));
    expect(here.length).toBeGreaterThan(60);
    expect(here).toEqual(node);
    // The fixtures exercise both outcomes.
    expect(here.some((h) => h.result.startsWith('{"status":"committed"'))).toBe(true);
    expect(here.some((h) => h.result.startsWith('{"status":"rejected"'))).toBe(true);
  });

  it('passes every Ops conformance suite, each as its own draft', async () => {
    const cases = await commands.opsConformanceCases();
    if (await commands.opsSuiteVendored()) {
      expect(cases.filter((c) => c.ops === '0.1').length).toBe(230);
      expect(cases.filter((c) => c.ops === '0.2').length).toBe(359);
      expect(cases.filter((c) => c.ops === '0.3').length).toBe(459);
      expect(cases.filter((c) => c.ops === '0.4').length).toBe(468);
    }
    let passed = 0;
    for (const c of cases) {
      const problems = checkCase({ ...c, input: fromBase64(c.input), request: fromBase64(c.request) }, apply(fromBase64(c.input), fromBase64(c.request), { ops: c.ops }));
      expect({ name: c.name, problems }).toEqual({ name: c.name, problems: [] });
      passed++;
    }
    console.log(`ops conformance in the browser: ${passed}/${cases.length} cases pass`);
  }, 120_000);

  it("passes the official extensions' Ops cases, each applied by an applier that implements it", async () => {
    const cases = await commands.extensionOpsCases();
    expect(cases.length).toBe(18);
    for (const c of cases) {
      const result = apply(fromBase64(c.input), fromBase64(c.request), { extensions: [c.extension], knownExtensions: fromBase64(c.registry) });
      const problems = checkCase({ ...c, input: fromBase64(c.input), request: fromBase64(c.request) }, result);
      expect({ name: c.name, problems }).toEqual({ name: c.name, problems: [] });
    }
    console.log(`extension Ops cases in the browser: ${cases.length}/${cases.length} pass`);
  });
});
