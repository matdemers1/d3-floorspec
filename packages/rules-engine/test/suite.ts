/**
 * Running one case of the Floorspec Rules 0.1 conformance suite (conformance/rules/0.1, vendored
 * in standard/): a report test (input.json, registry.json?, request.json → expected.json) or a
 * measure test (input.json, registry.json?, measures.json → expected.json), compared byte for byte
 * (Rules 9.8). Isomorphic: the Node runner reads the files, the browser runner is handed them.
 */
import { check } from '@floorspec/engine';
import { assures, callMeasures, evaluate, NOTICE, serialize, type MeasureCall, type Report, type Units } from '../src/index.js';
import { validate as reportSchema01 } from '../src/generated/validate-report.js';
import { validate as reportSchema02 } from '../src/generated/validate-report-0.2.js';

export interface RulesCase {
  name: string;
  /** The draft whose suite it is, and which the evaluator runs as. */
  rules?: '0.1' | '0.2';
  input: Uint8Array;
  registry: Uint8Array | null;
  /** A report test's request.json. */
  request: Uint8Array | null;
  /** A measure test's measures.json. */
  measures: string | null;
  expected: string;
}

export interface CaseResult {
  actual: string;
  /** Problems beyond a byte difference: what the specification promises of any report. */
  problems: string[];
}

export function runCase(c: RulesCase): CaseResult {
  const options = { rules: c.rules ?? '0.1', ...(c.registry === null ? {} : { knownExtensions: c.registry }) };
  if (c.measures !== null) {
    const calls = JSON.parse(c.measures) as { units?: Units; calls: MeasureCall[] };
    return { actual: serialize(callMeasures(c.input, calls, options)), problems: [] };
  }
  const report: Report = evaluate(c.input, c.request!, options);
  const actual = serialize(report);
  const problems: string[] = [];
  const reportSchema = options.rules === '0.1' ? reportSchema01 : reportSchema02;
  if (!(reportSchema as unknown as (v: unknown) => boolean)(JSON.parse(actual))) problems.push('the report does not match the report schema');
  if (assures(actual)) problems.push('the report matches the assurance pattern (9.5.2)');
  if (report.notice !== NOTICE) problems.push('the report has no notice (9.9)');
  if (report.hash !== undefined) {
    // 1.5.1: evaluating rules changed nothing about the document.
    const r = check(c.input, { extensions: ['FS_electrical', 'FS_plumbing', 'FS_mechanical', 'FS_lowvoltage'], core: options.rules === '0.1' ? '0.3' : '0.4', ...(c.registry === null ? {} : { knownExtensions: c.registry }) });
    if (!r.valid || r.hash !== report.hash) problems.push('the evaluated document is not the valid document it was given (1.5.1)');
  }
  return { actual, problems };
}

/** A unified-ish first difference, for a failure message. */
export function firstDifference(expected: string, actual: string): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  for (let i = 0; i < Math.max(e.length, a.length); i++)
    if (e[i] !== a[i]) return `line ${i + 1}:\n  expected: ${e[i] ?? '<end>'}\n  actual:   ${a[i] ?? '<end>'}`;
  return 'identical';
}
