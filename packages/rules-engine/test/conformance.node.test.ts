/**
 * The Floorspec Rules 0.1 conformance suite (FLR-ADR-009: the oracle), vendored from floorspec at
 * the commit in standard/LOCK.json: every report and every measure result, byte for byte.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { firstDifference, runCase } from './suite.js';
import { listCases, loadCase } from './cases.node.js';

const all = listCases();
const results = new Map<string, boolean>();
const started = performance.now();

describe('Rules 0.1 conformance suite', () => {
  it('is vendored', () => {
    expect(all.length).toBe(85);
  });

  it.each(all.map((n) => [n]))('%s', (name) => {
    results.set(name, false);
    const c = loadCase(name);
    const { actual, problems } = runCase(c);
    expect(problems).toEqual([]);
    expect(actual === c.expected, firstDifference(c.expected, actual)).toBe(true);
    results.set(name, true);
  });

  afterAll(() => {
    const passed = [...results.values()].filter(Boolean).length;
    process.stderr.write(`\nrules 0.1 conformance (node): ${passed}/${all.length} cases pass, ${(performance.now() - started).toFixed(0)} ms\n`);
  });
});
