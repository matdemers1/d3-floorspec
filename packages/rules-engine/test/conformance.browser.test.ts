/**
 * The evaluator in a real browser (FLR-ADR-010). Runs only in the `browser` project: the whole
 * Rules 0.1 and 0.2 conformance suites, byte for byte, in Chromium — and every result compared with
 * what Node produced for the same inputs, as the same draft.
 */
import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { firstDifference, runCase } from './suite.js';

const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

describe('in the browser', () => {
  it.each([
    ['0.1', 103],
    ['0.2', 112],
  ] as const)('passes the Rules %s conformance suite, and agrees with Node byte for byte', async (rules, count) => {
    const cases = await commands.rulesConformanceCases(rules);
    const node = new Map((await commands.rulesInNode(rules)).map((r) => [r.name, r.out]));
    expect(cases.length).toBe(count);
    let passed = 0;
    for (const w of cases) {
      const c = {
        name: w.name,
        rules,
        input: fromBase64(w.input),
        registry: w.registry === null ? null : fromBase64(w.registry),
        request: w.request === null ? null : fromBase64(w.request),
        measures: w.measures,
        expected: w.expected,
      };
      const { actual, problems } = runCase(c);
      expect({ name: w.name, problems }).toEqual({ name: w.name, problems: [] });
      expect(actual === c.expected, `${w.name}: ${firstDifference(c.expected, actual)}`).toBe(true);
      expect(actual).toBe(node.get(w.name));
      passed++;
    }
    console.log(`rules ${rules} conformance (browser): ${passed}/${cases.length} cases pass`);
    expect(passed).toBe(cases.length);
  });
});
