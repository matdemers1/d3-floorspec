/** Reading the vendored Rules conformance suite from disk (Node only: the runner and the browser commands). */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { RulesCase } from './suite.js';

export const SUITE = join(import.meta.dirname, '..', 'standard', 'conformance', 'rules', '0.1');

/** Every test directory of the suite (one holding test.json), relative to it, sorted. */
export function listCases(root = SUITE): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry === 'test.json') out.push(relative(root, dir));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

const bytes = (p: string): Uint8Array | null => (existsSync(p) ? new Uint8Array(readFileSync(p)) : null);

export function loadCase(name: string, root = SUITE): RulesCase {
  const dir = join(root, name);
  const measures = join(dir, 'measures.json');
  return {
    name,
    input: bytes(join(dir, 'input.json'))!,
    registry: bytes(join(dir, 'registry.json')),
    request: bytes(join(dir, 'request.json')),
    measures: existsSync(measures) ? readFileSync(measures, 'utf8') : null,
    expected: readFileSync(join(dir, 'expected.json'), 'utf8'),
  };
}
