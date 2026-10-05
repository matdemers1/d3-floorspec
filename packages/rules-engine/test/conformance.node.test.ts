/**
 * The Floorspec Rules conformance suites (FLR-ADR-009: the oracle), vendored from floorspec at the
 * commit in standard/LOCK.json: every report and every measure result, byte for byte — Rules 0.1's
 * evaluated as Rules 0.1, as published, and Rules 0.2's as the evaluator ships.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { firstDifference, runCase } from './suite.js';
import { listCases, loadCase, SUITES } from './cases.node.js';

for (const [rules, count] of [['0.1', 103], ['0.2', 112]] as const) {
  const all = listCases(SUITES[rules]);
  const results = new Map<string, boolean>();
  const started = performance.now();

  describe(`Rules ${rules} conformance suite`, () => {
    it('is vendored', () => {
      expect(all.length).toBe(count);
    });

    it.each(all.map((n) => [n]))('%s', (name) => {
      results.set(name, false);
      const c = loadCase(name, SUITES[rules], rules);
      const { actual, problems } = runCase(c);
      expect(problems).toEqual([]);
      expect(actual === c.expected, firstDifference(c.expected, actual)).toBe(true);
      results.set(name, true);
    });

    afterAll(() => {
      const passed = [...results.values()].filter(Boolean).length;
      process.stderr.write(`\nrules ${rules} conformance (node): ${passed}/${all.length} cases pass, ${(performance.now() - started).toFixed(0)} ms\n`);
    });
  });
}
