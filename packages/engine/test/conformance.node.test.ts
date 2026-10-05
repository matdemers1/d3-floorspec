/**
 * The conformance suites (FLR-ADR-009: the oracle), vendored from floorspec at the commit in
 * standard/LOCK.json. Every case is run as each conformance class: Validator (diagnostics, compared
 * as conformance/README.md says), Canonicalizer (the bytes of canonical.json), the content hash, and
 * Deriver (deep-equal `derived`).
 *
 * Core 0.4's suite runs against the engine as it ships — a 0.4 reader — with a case's
 * registry.json, when it has one, as the validator's known extensions (12.2). Core 0.3's, 0.2's and
 * 0.1's suites are the published suites, unchanged, and run against the engine configured as a
 * reader of that draft: each holds a document declaring a later draft, which that reader rejects
 * with FS-DOC-001.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { check, Package, type ValidateOptions } from '../src/index.js';
import { diagnosticView, readDesign, readPackage } from './suite-io.js';

interface ExpectedDiagnostic {
  code: string;
  severity: string;
  elements: string[];
  design?: string;
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

for (const core of ['0.1', '0.2', '0.3', '0.4'] as const) {
  const suite = join(import.meta.dirname, '..', 'standard', 'conformance', 'core', core);
  const all = cases(suite);
  const results = new Map<string, boolean>();

  describe(`conformance suite (Core ${core})`, () => {
    it('is vendored', () => {
      expect(all.length).toBeGreaterThan(0);
    });

    it.each(all.map((d) => [relative(suite, d), d]))('%s', (_name, dir) => {
      const name = relative(suite, dir);
      results.set(name, false);
      const input = new Uint8Array(readFileSync(join(dir, 'input.json')));
      const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Expected;
      const registryPath = join(dir, 'registry.json');
      const options: ValidateOptions = {
        core,
        ...(existsSync(registryPath) && { knownExtensions: new Uint8Array(readFileSync(registryPath)) }),
      };
      const pkg = readPackage(dir);
      const design = readDesign(dir);
      if (pkg) Object.assign(options, { package: new Package(pkg) });
      if (design !== undefined) Object.assign(options, { design });
      const r = check(input, options);
      const actual = r.diagnostics.map(diagnosticView);

      // Validator: exact list, except that [FS-SCH-001] matches one or more FS-SCH-001 and nothing else.
      const schemaOnly = expected.diagnostics.length === 1 && expected.diagnostics[0]!.code === 'FS-SCH-001';
      if (schemaOnly) {
        expect(actual.length, JSON.stringify(actual)).toBeGreaterThan(0);
        expect(actual.every((d) => d.code === 'FS-SCH-001' && d.severity === 'error'), JSON.stringify(actual)).toBe(true);
      } else {
        expect(actual).toEqual(expected.diagnostics);
      }
      expect(r.valid).toBe(expected.valid);

      // Hash, canonical form and derived values: present exactly when the document is valid. The
      // derived values are compared as JSON text after sorting members, so a value that is equal
      // but of another type (a string for a number) fails.
      expect(r.hash).toBe(expected.hash);
      const canonicalPath = join(dir, 'canonical.json');
      if (existsSync(canonicalPath)) expect(r.canonical).toBe(readFileSync(canonicalPath, 'utf8'));
      else expect(r.canonical).toBeUndefined();
      expect(r.derived).toEqual(expected.derived);
      expect(sortedJson(r.derived)).toBe(sortedJson(expected.derived));
      results.set(name, true);
    });

    // The pass rate, on stderr so the default reporter shows it; the 100% gate is every case above.
    afterAll(() => {
      const passed = [...results.values()].filter(Boolean).length;
      process.stderr.write(`\nconformance (Core ${core}): ${passed}/${all.length} cases pass (${all.length ? Math.floor((100 * passed) / all.length) : 0}%)\n`);
    });
  });
}

/** JSON text with every object's members sorted, for a byte-for-byte comparison of derived values. */
function sortedJson(v: unknown): string | undefined {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : typeof x === 'object' && x !== null
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
          )
        : x;
  return v === undefined ? undefined : JSON.stringify(sort(v));
}
