/**
 * Comparing an applier's result with a conformance case (isomorphic: Node and the browser both use
 * it). Diagnostics are compared on code, severity and elements, as conformance/README.md says for
 * Core — and an expected `[FS-SCH-001]` matches one or more FS-SCH-001 and nothing else. A commit
 * is compared on the exact bytes of output.json, the hash, and `resolved`, `created`, `removed`
 * and `inverse` as JSON values.
 */
import type { ApplyResult } from '../src/index.js';

export interface OpsCase {
  name: string;
  input: Uint8Array;
  request: Uint8Array;
  expected: string;
  output: string | null;
}

interface Expected {
  status: 'committed' | 'rejected';
  diagnostics?: { code: string; severity: string; elements: string[] }[];
  hash?: string;
  resolved?: unknown;
  created?: string[];
  removed?: string[];
  inverse?: unknown;
}

const json = (v: unknown): string => JSON.stringify(v);

/** Deep equality of JSON values, ignoring member order. */
export function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a !== null && typeof a === 'object') {
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

/** What differs between a result and a case: an empty list when the applier conforms. */
export function checkCase(c: OpsCase, r: ApplyResult): string[] {
  const expected = JSON.parse(c.expected) as Expected;
  const problems: string[] = [];
  if (r.status !== expected.status) {
    problems.push(`status: expected ${expected.status}, got ${r.status}${r.status === 'rejected' ? ` ${json(r.diagnostics.map((d) => [d.code, d.elements, d.message]))}` : ''}`);
    return problems;
  }
  if (r.status === 'rejected') {
    const actual = r.diagnostics.map((d) => ({ code: d.code, severity: d.severity, elements: d.elements }));
    const want = expected.diagnostics ?? [];
    const schemaOnly = want.length === 1 && want[0]!.code === 'FS-SCH-001';
    const ok = schemaOnly ? actual.length > 0 && actual.every((d) => d.code === 'FS-SCH-001' && d.severity === 'error') : same(actual, want);
    if (!ok) problems.push(`diagnostics: expected ${json(want)}, got ${json(actual)} (${r.diagnostics.map((d) => d.message).join(' | ')})`);
    return problems;
  }
  if (c.output !== null && r.document !== c.output) problems.push(`output.json: the canonical form of B differs:\n--- expected\n${c.output}\n--- got\n${r.document}`);
  if (c.output === null) problems.push('output.json is missing for a committed case');
  if (expected.hash !== undefined && r.hash !== expected.hash) problems.push(`hash: expected ${expected.hash}, got ${r.hash}`);
  for (const k of ['resolved', 'created', 'removed', 'inverse'] as const)
    if (expected[k] !== undefined && !same(r[k], expected[k])) problems.push(`${k}: expected ${json(expected[k])}, got ${json(r[k])}`);
  return problems;
}
