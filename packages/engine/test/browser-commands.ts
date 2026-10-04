/** Browser-mode commands: functions the browser tests call that run in Node (the vitest server). */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BrowserCommand } from 'vitest/node';
import { check } from '../src/index.js';
import { fixtures } from './fixtures.js';

/** Check every determinism fixture in Node, so the browser can compare its own results byte for byte. */
const checkFixturesInNode: BrowserCommand = () => fixtures().map((f) => ({ name: f.name, result: JSON.stringify(check(f.doc)) }));

/** The vendored conformance cases, with input bytes in base64 (they may be malformed UTF-8 on purpose). */
const conformanceCases: BrowserCommand = () => {
  const root = join(import.meta.dirname, '..', 'standard', 'conformance', 'core', '0.1');
  const out: { name: string; input: string; expected: string; canonical: string | null }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry === 'test.json') {
        const c = join(dir, 'canonical.json');
        out.push({
          name: relative(root, dir),
          input: readFileSync(join(dir, 'input.json')).toString('base64'),
          expected: readFileSync(join(dir, 'expected.json'), 'utf8'),
          canonical: existsSync(c) ? readFileSync(c, 'utf8') : null,
        });
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
};

export const nodeCommands = { checkFixturesInNode, conformanceCases };

declare module 'vitest/browser' {
  interface BrowserCommands {
    checkFixturesInNode: () => Promise<{ name: string; result: string }[]>;
    conformanceCases: () => Promise<{ name: string; input: string; expected: string; canonical: string | null }[]>;
  }
}
