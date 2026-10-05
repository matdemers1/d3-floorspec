/** Browser-mode commands: functions the browser tests call that run in Node (the vitest server). */
import type { BrowserCommand } from 'vitest/node';
import { serialize, evaluate, callMeasures, type MeasureCall, type Units } from '../src/index.js';
import { listCases, loadCase, SUITES } from './cases.node.js';

type Draft = keyof typeof SUITES;

const b64 = (b: Uint8Array | null): string | null => (b === null ? null : Buffer.from(b).toString('base64'));

export interface WireCase {
  name: string;
  input: string;
  registry: string | null;
  request: string | null;
  measures: string | null;
  expected: string;
}

/** The vendored Rules conformance cases of one draft, with their input bytes in base64. */
const rulesConformanceCases: BrowserCommand<[rules: Draft]> = (_, rules) =>
  listCases(SUITES[rules]).map((name): WireCase => {
    const c = loadCase(name, SUITES[rules], rules);
    return { name, input: b64(c.input)!, registry: b64(c.registry), request: b64(c.request), measures: c.measures, expected: c.expected };
  });

/** What Node's evaluator returns for every case of one draft, so the browser can compare its own bytes with it. */
const rulesInNode: BrowserCommand<[rules: Draft]> = (_, rules) =>
  listCases(SUITES[rules]).map((name) => {
    const c = loadCase(name, SUITES[rules], rules);
    const options = { rules, ...(c.registry === null ? {} : { knownExtensions: c.registry }) };
    const out =
      c.measures !== null
        ? serialize(callMeasures(c.input, JSON.parse(c.measures) as { units?: Units; calls: MeasureCall[] }, options))
        : serialize(evaluate(c.input, c.request!, options));
    return { name, out };
  });

export const nodeCommands = { rulesConformanceCases, rulesInNode };

declare module 'vitest/browser' {
  interface BrowserCommands {
    rulesConformanceCases: (rules: '0.1' | '0.2') => Promise<WireCase[]>;
    rulesInNode: (rules: '0.1' | '0.2') => Promise<{ name: string; out: string }[]>;
  }
}
