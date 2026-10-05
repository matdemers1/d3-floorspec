/** Where the vendored Ops suites are, and their cases (Node only: it reads the file system). */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** conformance/ops/<draft>: each suite is applied as its own draft of Ops. */
export const SUITES = {
  '0.1': join(import.meta.dirname, '..', 'standard', 'conformance', 'ops', '0.1'),
  '0.2': join(import.meta.dirname, '..', 'standard', 'conformance', 'ops', '0.2'),
} as const;
export const SUITE = SUITES['0.1'];

/** Every case directory (one holding request.json), relative to the suite, sorted. */
export function listCases(root = SUITE): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry === 'request.json') out.push(relative(root, dir));
    }
  };
  walk(root);
  return out;
}

export { checkCase, type OpsCase } from './check.js';
