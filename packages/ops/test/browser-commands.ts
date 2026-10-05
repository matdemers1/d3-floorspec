/** Browser-mode commands: functions the browser tests call that run in Node (the vitest server). */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BrowserCommand } from 'vitest/node';
import { apply } from '../src/index.js';
import { fixtures } from './fixtures.js';
import { EXT_SUITES, listCases, SUITES } from './suite.js';

/** Apply every determinism fixture in Node, so the browser can compare its own results byte for byte. */
const applyFixturesInNode: BrowserCommand = () => fixtures().map((f) => ({ name: f.name, result: JSON.stringify(apply(f.doc, f.request)) }));

/** The vendored Ops conformance cases of every suite, each with its draft, input and request bytes in base64. */
const opsConformanceCases: BrowserCommand = () =>
  (['0.1', '0.2', '0.3', '0.4'] as const).flatMap((ops) =>
    listCases(SUITES[ops]).map((name) => {
      const dir = join(SUITES[ops], name);
      const output = join(dir, 'output.json');
      return {
        ops,
        name: `${ops}/${name}`,
        input: readFileSync(join(dir, 'input.json')).toString('base64'),
        request: readFileSync(join(dir, 'request.json')).toString('base64'),
        expected: readFileSync(join(dir, 'expected.json'), 'utf8'),
        output: existsSync(output) ? readFileSync(output, 'utf8') : null,
      };
    }),
  );

/** Whether every suite is vendored at all. */
const opsSuiteVendored: BrowserCommand = () => existsSync(SUITES['0.1']) && existsSync(SUITES['0.2']) && existsSync(SUITES['0.3']) && existsSync(SUITES['0.4']);

/**
 * The official extensions' Ops cases (each suite's `ops` group), with the one extension the
 * applier implements and the case's registry entry, as test/extensions.node.test.ts runs them.
 */
const extensionOpsCases: BrowserCommand = () => {
  const out: { extension: string; name: string; input: string; request: string; registry: string; expected: string; output: string | null }[] = [];
  if (!existsSync(EXT_SUITES)) return out;
  for (const extension of readdirSync(EXT_SUITES).sort())
    for (const version of readdirSync(join(EXT_SUITES, extension)).sort()) {
      const root = join(EXT_SUITES, extension, version);
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir).sort()) {
          const p = join(dir, entry);
          if (statSync(p).isDirectory()) walk(p);
          else if (entry === 'request.json') {
            const output = join(dir, 'output.json');
            out.push({
              extension,
              name: `${extension}/${relative(root, dir)}`,
              input: readFileSync(join(dir, 'input.json')).toString('base64'),
              request: readFileSync(join(dir, 'request.json')).toString('base64'),
              registry: readFileSync(join(dir, 'registry.json')).toString('base64'),
              expected: readFileSync(join(dir, 'expected.json'), 'utf8'),
              output: existsSync(output) ? readFileSync(output, 'utf8') : null,
            });
          }
        }
      };
      walk(root);
    }
  return out;
};

export const nodeCommands = { applyFixturesInNode, opsConformanceCases, opsSuiteVendored, extensionOpsCases };

declare module 'vitest/browser' {
  interface BrowserCommands {
    applyFixturesInNode: () => Promise<{ name: string; result: string }[]>;
    opsConformanceCases: () => Promise<{ ops: '0.1' | '0.2' | '0.3' | '0.4'; name: string; input: string; request: string; expected: string; output: string | null }[]>;
    opsSuiteVendored: () => Promise<boolean>;
    extensionOpsCases: () => Promise<{ extension: string; name: string; input: string; request: string; registry: string; expected: string; output: string | null }[]>;
  }
}
