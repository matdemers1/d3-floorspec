/** Browser-mode commands: functions the browser tests call that run in Node (the vitest server). */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BrowserCommand } from 'vitest/node';
import { check } from '../src/index.js';
import { fixtures } from './fixtures.js';

/** Check every determinism fixture in Node, so the browser can compare its own results byte for byte. */
const checkFixturesInNode: BrowserCommand = () => fixtures().map((f) => ({ name: f.name, result: JSON.stringify(check(f.doc)) }));

export interface ConformanceCase {
  name: string;
  /** The reader the suite tests: Core 0.1's suite a 0.1 reader, 0.2's a 0.2 reader, Core 0.3's the engine as it ships. */
  core: '0.1' | '0.2' | '0.3';
  input: string;
  /** The case's registry.json (Core 0.2, 12.2), when it has one. */
  registry: string | null;
  /** For an official extension's case: the one extension the reader implements. */
  extensions: string[] | null;
  expected: string;
  canonical: string | null;
}

/** The vendored conformance cases of every suite, with input bytes in base64 (they may be malformed UTF-8 on purpose). */
const conformanceCases: BrowserCommand = () => {
  const out: ConformanceCase[] = [];
  for (const core of ['0.1', '0.2', '0.3'] as const) {
    const root = join(import.meta.dirname, '..', 'standard', 'conformance', 'core', core);
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir).sort()) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (entry === 'test.json') {
          const c = join(dir, 'canonical.json');
          const reg = join(dir, 'registry.json');
          out.push({
            name: `${core}/${relative(root, dir)}`,
            core,
            input: readFileSync(join(dir, 'input.json')).toString('base64'),
            registry: existsSync(reg) ? readFileSync(reg).toString('base64') : null,
            extensions: null,
            expected: readFileSync(join(dir, 'expected.json'), 'utf8'),
            canonical: existsSync(c) ? readFileSync(c, 'utf8') : null,
          });
        }
      }
    };
    if (existsSync(root)) walk(root);
  }
  // The official extensions' suites (conformance/ext/<NAME>/<version>/): their validator and
  // deriver cases, each read by a reader that implements that one extension.
  const ext = join(import.meta.dirname, '..', 'standard', 'conformance', 'ext');
  for (const name of existsSync(ext) ? readdirSync(ext).sort() : [])
    for (const version of readdirSync(join(ext, name)).sort()) {
      const root = join(ext, name, version);
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir).sort()) {
          const p = join(dir, entry);
          if (statSync(p).isDirectory()) walk(p);
          else if (entry === 'test.json' && !existsSync(join(dir, 'request.json'))) {
            const c = join(dir, 'canonical.json');
            const reg = join(dir, 'registry.json');
            out.push({
              name: `${name}/${relative(root, dir)}`,
              core: '0.3',
              input: readFileSync(join(dir, 'input.json')).toString('base64'),
              registry: existsSync(reg) ? readFileSync(reg).toString('base64') : null,
              extensions: [name],
              expected: readFileSync(join(dir, 'expected.json'), 'utf8'),
              canonical: existsSync(c) ? readFileSync(c, 'utf8') : null,
            });
          }
        }
      };
      walk(root);
    }
  return out;
};

export const nodeCommands = { checkFixturesInNode, conformanceCases };

declare module 'vitest/browser' {
  interface BrowserCommands {
    checkFixturesInNode: () => Promise<{ name: string; result: string }[]>;
    conformanceCases: () => Promise<ConformanceCase[]>;
  }
}
