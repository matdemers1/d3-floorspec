/**
 * The property chapter 20 promises (FLR-REQ-150, FLR-REQ-172), over every document of an earlier
 * draft the standard has published: each Core 0.1, 0.2 and 0.3 conformance file that its own draft's schema
 * accepts migrates to 0.4, and the engine - a reader of 0.4 - reads the migration exactly as it reads
 * the original (20.6.1): same validity, same diagnostics, every derived value the same. For a valid
 * original, the migration is valid under 0.4, and every value its own draft's suite says that draft
 * derives (walls, rooms, openings, and from 0.2 the program, fallbacks, placements, clearances and
 * circulation) is preserved — a winder's steps and a roof's surface that 0.3 left underived aside, which a
 * reader of 0.4 derives. And the Ops batch the editor applies (migrationBatch) commits exactly the
 * migration's canonical form.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalize, check, parseJson } from '@floorspec/engine';
import { apply } from '@floorspec/ops';
import { migrate, migrationBatch } from '../src/index.js';
import { cases, CORE_SUITES, diagnosticsView } from './suite.js';

interface Expected {
  valid: boolean;
  derived?: Record<string, unknown>;
}

for (const draft of ['0.1', '0.2', '0.3'] as const) {
  const suite = join(CORE_SUITES, draft);
  // The published suite's own documents, declaring its draft (a 0.2 test may hold a 0.1 document too).
  // A test that derives another design (design.json, Core 0.3, 19.6) states that design's values, not the primary's.
  const dirs = cases(suite).filter((d) => !existsSync(join(d, 'registry.json')) && !existsSync(join(d, 'design.json')));

  describe(`every Core ${draft} conformance document, migrated to 0.4`, () => {
    it('is vendored', () => {
      expect(dirs.length).toBeGreaterThan(200);
    });

    let migrated = 0;
    let valid = 0;
    it.each(dirs.map((d) => [relative(suite, d), d]))('%s', (_name, dir) => {
      const input = new Uint8Array(readFileSync(join(dir, 'input.json')));
      const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Expected;
      const r = migrate(input, '0.4');
      // A document a reader of 0.4 implementing its required extensions rejects before the invariants
      // is refused; every other migrates (20.2) - a 0.1 suite's document declaring "0.2" included.
      const required = (parseJson(input).value as { extensionsRequired?: unknown } | undefined)?.extensionsRequired;
      const extensions = Array.isArray(required) ? required.filter((n): n is string => typeof n === 'string') : [];
      const early = check(input, { extensions }).diagnostics.some((d) => /^FS-(JSON|SCH|DOC)-/.test(d.code));
      expect(r.status).toBe(early ? 'refused' : 'migrated');
      if (r.status !== 'migrated') return;
      migrated++;
      expect(r.document.floorspec).toBe('0.4');

      const before = check(input);
      const after = check(r.text);
      expect({ valid: after.valid, diagnostics: diagnosticsView(after.diagnostics) }).toEqual({ valid: before.valid, diagnostics: diagnosticsView(before.diagnostics) });
      expect(after.derived).toEqual(before.derived);
      if (!expected.valid) return;
      valid++;
      expect(after.valid).toBe(true);
      // Every value the original's own draft derives, as its published suite states it.
      for (const [member, value] of Object.entries(expected.derived ?? {})) {
        const got = after.derived?.[member as keyof typeof after.derived] as unknown;
        // Core 0.4 derives more of a winder or a spiral stair than 0.3 did (17.7): each value 0.3 derived is kept.
        if (member === 'stairs' && draft === '0.3') {
          for (const [id, st] of Object.entries(value as Record<string, Record<string, unknown>>)) {
            const now = (got as Record<string, Record<string, unknown>>)[id]!;
            expect(Object.fromEntries(Object.keys(st).map((k) => [k, now[k]]))).toEqual(st);
          }
        } else if (member === 'roofs' && draft === '0.3') {
          // Core 0.4 derives the surface of more roofs than 0.3 did (16.4.3, the weighted straight
          // skeleton): a surface 0.3 derived is kept exactly, and one 0.3 left underived may now be derived.
          for (const [id, rf] of Object.entries(value as Record<string, Record<string, unknown>>)) {
            const now = (got as Record<string, Record<string, unknown>>)[id]!;
            const kept = rf['surface'] === null ? Object.keys(rf).filter((k) => k !== 'surface') : Object.keys(rf);
            expect(Object.fromEntries(kept.map((k) => [k, now[k]]))).toEqual(Object.fromEntries(kept.map((k) => [k, rf[k]])));
          }
        } else expect([member, got]).toEqual([member, value]);
      }

      // The editor's upgrade: the migration as one Ops batch commits the migration's canonical form.
      const batch = migrationBatch(input);
      const committed = apply(input, { batch });
      expect(committed.status).toBe('committed');
      if (committed.status === 'committed') expect(committed.document).toBe(canonicalize(r.document));
    });

    it('migrated most of the suite, and every valid document', () => {
      expect(migrated).toBeGreaterThan(150);
      expect(valid).toBeGreaterThan(80);
    });
  });
}
