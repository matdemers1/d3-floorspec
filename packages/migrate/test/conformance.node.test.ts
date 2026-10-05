/**
 * The migration suites (Core 0.3 and 0.4, chapter 20) - 0.3's run by a migrator of 0.3, as published,
 * and 0.4's by the migrator as it ships - vendored from floorspec at the commit in
 * standard/LOCK.json (FLR-ADR-009): every test's status and diagnostics, the migration byte for byte
 * and its hash, and what a reader of the target - the engine, implementing no extension and knowing
 * none - reports for the document and for its migration alike, deriving exactly the same values
 * (20.6.1).
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '@floorspec/engine';
import { migrate } from '../src/index.js';
import { cases, diagnosticsView, STANDARD } from './suite.js';

interface Expected {
  status: 'migrated' | 'refused';
  diagnostics: { code: string; severity: string; elements: string[] }[];
  hash?: string;
  validation?: { valid: boolean; diagnostics: { code: string; severity: string; elements: string[] }[] };
}

for (const migrator of ['0.3', '0.4'] as const) {
  const suite = join(STANDARD, 'conformance', 'migration', migrator);
  const all = cases(suite);

  describe(`migration suite (Core ${migrator}, chapter 20)`, () => {
    it('is vendored', () => {
      expect(all.length).toBeGreaterThan(20);
    });

    it.each(all.map((d) => [relative(suite, d), d]))('%s', (_name, dir) => {
      const input = new Uint8Array(readFileSync(join(dir, 'input.json')));
      const { to } = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')) as { to: unknown };
      const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Expected;
      const r = migrate(input, to, { migrator });
      expect(r.status).toBe(expected.status);
      expect(diagnosticsView(r.diagnostics)).toEqual(expected.diagnostics);
      if (r.status !== 'migrated') return;
      expect(r.text).toBe(readFileSync(join(dir, 'output.json'), 'utf8'));
      expect(r.hash).toBe(expected.hash);
      const core = to as '0.1' | '0.2' | '0.3' | '0.4';
      const before = check(input, { core });
      const after = check(r.text, { core });
      for (const c of [before, after]) expect({ valid: c.valid, diagnostics: diagnosticsView(c.diagnostics) }).toEqual(expected.validation);
      expect(after.derived).toEqual(before.derived);
    });
  });
}
