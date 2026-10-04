/** Browser-mode commands: functions the browser tests call that run in Node (the vitest server). */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserCommand } from 'vitest/node';
import { apply } from '../src/index.js';
import { fixtures } from './fixtures.js';
import { listCases, SUITE } from './suite.js';

/** Apply every determinism fixture in Node, so the browser can compare its own results byte for byte. */
const applyFixturesInNode: BrowserCommand = () => fixtures().map((f) => ({ name: f.name, result: JSON.stringify(apply(f.doc, f.request)) }));

/** The vendored Ops conformance cases, with input and request bytes in base64. */
const opsConformanceCases: BrowserCommand = () =>
  listCases().map((name) => {
    const dir = join(SUITE, name);
    const output = join(dir, 'output.json');
    return {
      name,
      input: readFileSync(join(dir, 'input.json')).toString('base64'),
      request: readFileSync(join(dir, 'request.json')).toString('base64'),
      expected: readFileSync(join(dir, 'expected.json'), 'utf8'),
      output: existsSync(output) ? readFileSync(output, 'utf8') : null,
    };
  });

/** Whether the suite is vendored at all. */
const opsSuiteVendored: BrowserCommand = () => existsSync(SUITE);

export const nodeCommands = { applyFixturesInNode, opsConformanceCases, opsSuiteVendored };

declare module 'vitest/browser' {
  interface BrowserCommands {
    applyFixturesInNode: () => Promise<{ name: string; result: string }[]>;
    opsConformanceCases: () => Promise<{ name: string; input: string; request: string; expected: string; output: string | null }[]>;
    opsSuiteVendored: () => Promise<boolean>;
  }
}
