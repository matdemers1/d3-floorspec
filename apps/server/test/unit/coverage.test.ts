import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Pack } from '@floorspec/rules-engine';
import { deriveMatrix, isMatrix, mergeMatrices, within, type CoverageMatrix } from '../../src/rules/coverage.js';
import { coverageOf, loadRulePacks, NO_PACKS } from '../../src/rules/packs.js';

/**
 * FLR-T-6.9, FLR-REQ-096: the installed packs' coverage matrix. The fixture
 * `example.coverage.json` is what the standard's `pnpm coverage:matrix` (tools/coverage-matrix.ts,
 * floorspec 441a066) writes for `example.json`; a pack installed without one has its matrix derived
 * from the pack, in the same shape.
 */

const FIXTURES = new URL('../fixtures/rule-packs/', import.meta.url).pathname;
const EXAMPLE = JSON.parse(readFileSync(join(FIXTURES, 'example.json'), 'utf8')) as Pack;
const PUBLISHED = JSON.parse(readFileSync(join(FIXTURES, 'example.coverage.json'), 'utf8')) as CoverageMatrix;

describe('the coverage matrix', () => {
  it('serves the matrix published beside a pack, and skips it as a pack', () => {
    const loaded = loadRulePacks(FIXTURES);
    expect(loaded.packs.map((p) => p.name)).toEqual(['example']);
    expect(loaded.coverageSources).toEqual(['published']);
    expect(coverageOf(loaded)).toEqual(PUBLISHED);
  });

  it('derives one from the pack when none is published: the same sections, rules, reviews and dates', () => {
    const d = mkdtempSync(join(tmpdir(), 'flr-coverage-'));
    copyFileSync(join(FIXTURES, 'example.json'), join(d, 'example.json'));
    const loaded = loadRulePacks(d);
    expect(loaded.coverageSources).toEqual(['derived']);
    const derived = coverageOf(loaded);
    expect(isMatrix(derived)).toBe(true);
    expect(derived.packs).toEqual(PUBLISHED.packs);
    const shape = (m: CoverageMatrix) => m.rows.map((r) => [r.code, r.edition, r.section, r.domain, r.declared, r.rules.map((x) => x.rule), r.reviewed, r.oldestVerification]);
    expect(shape(derived)).toEqual(shape(PUBLISHED));
    // The derivation reads deferral from this build's measure library; everything else matches.
    const strip = (m: CoverageMatrix) => m.rules.map(({ deferred: _deferred, ...rule }) => rule);
    expect(strip(derived)).toEqual(strip(PUBLISHED));
    expect(derived.domains.map((x) => x.title)).toEqual(PUBLISHED.domains.map((x) => x.title));
  });

  it('ignores a published matrix of another version of the pack', () => {
    const d = mkdtempSync(join(tmpdir(), 'flr-coverage-'));
    copyFileSync(join(FIXTURES, 'example.json'), join(d, 'example.json'));
    writeFileSync(join(d, 'example.coverage.json'), JSON.stringify({ ...PUBLISHED, packs: PUBLISHED.packs.map((p) => ({ ...p, version: '9.9.9' })) }));
    expect(loadRulePacks(d).coverageSources).toEqual(['derived']);
  });

  it('is empty with no pack installed, and merges several packs in name order', () => {
    expect(coverageOf(NO_PACKS).rows).toEqual([]);
    const other = deriveMatrix({ ...EXAMPLE, name: 'aardvark' });
    expect(mergeMatrices([deriveMatrix(EXAMPLE), other]).packs.map((p) => p.name)).toEqual(['aardvark', 'example']);
  });

  it('puts a section within an entry only at a separator', () => {
    expect(within('§1.2', '§1')).toBe(true);
    expect(within('§12', '§1')).toBe(false);
    expect(within('R310.2.1', 'R310')).toBe(true);
    expect(within('110.26(A)', '110.26')).toBe(true);
  });
});
