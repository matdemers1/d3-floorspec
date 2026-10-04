/**
 * The conformance suite (FLR-ADR-009: the oracle), vendored from floorspec at the commit in
 * standard/LOCK.json. Every case is run as each conformance class: Validator (diagnostics, compared
 * as conformance/README.md says), Canonicalizer (the bytes of canonical.json), the content hash, and
 * Deriver (deep-equal `derived`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { check } from '../src/index.js';

const suite = join(import.meta.dirname, '..', 'standard', 'conformance', 'core', '0.1');

interface ExpectedDiagnostic {
  code: string;
  severity: string;
  elements: string[];
}
interface Expected {
  valid: boolean;
  diagnostics: ExpectedDiagnostic[];
  hash?: string;
  derived?: unknown;
}

function cases(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...cases(p));
    else if (entry === 'test.json') out.push(dir);
  }
  return out;
}

const all = cases(suite);
const results = new Map<string, boolean>();

describe('conformance suite (Core 0.1)', () => {
  it('is vendored', () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it.each(all.map((d) => [relative(suite, d), d]))('%s', (_name, dir) => {
    const name = relative(suite, dir);
    results.set(name, false);
    const input = new Uint8Array(readFileSync(join(dir, 'input.json')));
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Expected;
    const r = check(input);
    const actual = r.diagnostics.map((d) => ({ code: d.code, severity: d.severity, elements: d.elements }));

    // Validator: exact list, except that [FS-SCH-001] matches one or more FS-SCH-001 and nothing else.
    const schemaOnly = expected.diagnostics.length === 1 && expected.diagnostics[0]!.code === 'FS-SCH-001';
    if (schemaOnly) {
      expect(actual.length, JSON.stringify(actual)).toBeGreaterThan(0);
      expect(actual.every((d) => d.code === 'FS-SCH-001' && d.severity === 'error'), JSON.stringify(actual)).toBe(true);
    } else {
      expect(actual).toEqual(expected.diagnostics);
    }
    expect(r.valid).toBe(expected.valid);

    // Hash, canonical form and derived values: present exactly when the document is valid.
    expect(r.hash).toBe(expected.hash);
    const canonicalPath = join(dir, 'canonical.json');
    if (existsSync(canonicalPath)) expect(r.canonical).toBe(readFileSync(canonicalPath, 'utf8'));
    else expect(r.canonical).toBeUndefined();
    expect(r.derived).toEqual(expected.derived);
    results.set(name, true);
  });

  // The pass rate, on stderr so the default reporter shows it; the 100% gate is every case above.
  afterAll(() => {
    const passed = [...results.values()].filter(Boolean).length;
    process.stderr.write(`\nconformance: ${passed}/${all.length} cases pass (${all.length ? Math.floor((100 * passed) / all.length) : 0}%)\n`);
  });
});
