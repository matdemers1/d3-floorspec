/**
 * The Floorspec Ops conformance suite (FLR-ADR-009: the oracle), vendored from floorspec at the
 * commit in standard/LOCK.json. Each case is a document A (`input.json`), an apply request
 * (`request.json`) and what a conformant applier returns (`expected.json`, and `output.json` — the
 * exact bytes of B — when the batch commits).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { apply } from '../src/index.js';
import { checkCase, listCases, SUITE, type OpsCase } from './suite.js';

const all = listCases();
const results = new Map<string, boolean>();

function load(name: string): OpsCase {
  const dir = join(SUITE, name);
  const output = join(dir, 'output.json');
  return {
    name,
    input: new Uint8Array(readFileSync(join(dir, 'input.json'))),
    request: new Uint8Array(readFileSync(join(dir, 'request.json'))),
    expected: readFileSync(join(dir, 'expected.json'), 'utf8'),
    output: existsSync(output) ? readFileSync(output, 'utf8') : null,
  };
}

describe('conformance suite (Ops 0.1)', () => {
  it.runIf(existsSync(SUITE))('is vendored', () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it.each(all.map((n) => [n]))('%s', (name) => {
    results.set(name, false);
    const c = load(name);
    const problems = checkCase(c, apply(c.input, c.request));
    expect(problems, problems.join('\n')).toEqual([]);
    results.set(name, true);
  });

  afterAll(() => {
    const passed = [...results.values()].filter(Boolean).length;
    process.stderr.write(`\nops conformance: ${passed}/${all.length} cases pass (${all.length ? Math.floor((100 * passed) / all.length) : 0}%)\n`);
  });
});
