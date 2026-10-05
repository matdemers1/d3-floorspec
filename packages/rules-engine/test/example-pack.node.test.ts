/**
 * The standard's synthetic example pack (rules/example, vendored), every fixture evaluated by this
 * evaluator exactly as the standard's build evaluates it with the oracle (rules/README.md, Fixtures):
 * the built pack (generated/pack.json) under a profile that adopts the rule's cited edition, every
 * official extension known unless the fixture says otherwise. Its winder and spiral rules read the
 * stair measures of Rules 0.2 on Core 0.4 documents (FLR-T-11.3); like every rule of the pack they
 * cite the synthetic code TEST-CODE, never a real one.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_EXTENSIONS } from '@floorspec/engine';
import { evaluate, findingsFor, type Pack } from '../src/index.js';

const ROOT = join(import.meta.dirname, '..', 'standard', 'rules', 'example');
const pack = JSON.parse(readFileSync(join(ROOT, 'generated', 'pack.json'), 'utf8')) as Pack;

interface Expect {
  description: string;
  outcome: 'pass' | 'fail' | 'deferred';
  document?: string;
  subjects?: number;
  findings?: string[];
  extensions?: string[];
}

const fixtures = Object.keys(pack.rules)
  .sort()
  .flatMap((rule) => {
    const dir = join(ROOT, 'rules', rule, 'fixtures');
    return (existsSync(dir) ? readdirSync(dir).sort() : []).map((slug) => ({ rule, slug, dir: join(dir, slug) }));
  });

describe('the example pack (synthetic codes)', () => {
  it('is vendored, with its winder and spiral rules', () => {
    expect(Object.keys(pack.rules)).toEqual(expect.arrayContaining(['WINDER-WALKLINE', 'WINDER-NARROW', 'SPIRAL-WIDTH', 'SPIRAL-GOING', 'SPIRAL-RISER', 'SPIRAL-HEADROOM']));
    expect(pack.floorspecRules).toBe('0.2');
    expect(fixtures.length).toBe(18);
  });

  it.each(fixtures.map((f) => [`${f.rule}/${f.slug}`, f]))('%s', (_name, f) => {
    const exp = JSON.parse(readFileSync(join(f.dir, 'expect.json'), 'utf8')) as Expect;
    const doc = readFileSync(exp.document ? join(ROOT, 'documents', `${exp.document}.json`) : join(f.dir, 'document.json'), 'utf8');
    const rule = pack.rules[f.rule]!;
    const known = OFFICIAL_EXTENSIONS.filter((e) => exp.extensions === undefined || exp.extensions.includes(e.name));
    const report = evaluate(
      doc,
      {
        floorspecRules: '0.2',
        packs: [pack],
        profile: { floorspecRules: '0.2', name: `Fixture profile: ${rule.citation.code} ${rule.citation.edition}`, adopts: [{ code: rule.citation.code, edition: rule.citation.edition }] },
      },
      { knownExtensions: [...known] },
    );
    expect(report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const evaluated = report.evaluated.find((e) => e.rule === f.rule);
    const found = report.findings.filter((x) => x.rule === f.rule).map((x) => x.subject.id).sort();
    if (exp.outcome === 'pass') {
      expect(evaluated, `${f.rule} was not evaluated`).toBeDefined();
      if (exp.subjects !== undefined) expect(evaluated!.subjects).toBe(exp.subjects);
      else expect(evaluated!.subjects).toBeGreaterThan(0);
      expect(found).toEqual([]);
    } else if (exp.outcome === 'fail') {
      expect(evaluated, `${f.rule} was not evaluated`).toBeDefined();
      expect(found).toEqual([...(exp.findings ?? [])].sort());
    } else {
      expect(report.notEvaluated.find((e) => e.rule === f.rule)?.reason).toBe('deferred');
    }
  });
});

describe('findingsFor on a Core 0.4 plan', () => {
  const winder = readFileSync(join(ROOT, 'documents', 'winder-stair.json'), 'utf8');
  it('evaluates as Rules 0.2: a pack and a profile written for 0.1 are read as 0.2', () => {
    const old = { ...pack, floorspecRules: '0.1' as const, rules: { 'WINDER-NARROW': pack.rules['WINDER-NARROW']! } };
    const r = findingsFor(winder, { floorspecRules: '0.1', name: 'Synthetic', adopts: [{ code: 'TEST-CODE', edition: '2024' }] }, [old]);
    expect(r.floorspecRules).toBe('0.2');
    expect(r.diagnostics).toEqual([]);
    expect(r.evaluated.map((e) => [e.rule, e.subjects])).toEqual([['WINDER-NARROW', 1]]);
  });
  it('a Rules 0.1 evaluator knows no stairNarrowGoing, and reads no Core 0.4 document', () => {
    const r = evaluate(winder, { floorspecRules: '0.1', packs: [] }, { rules: '0.1' });
    expect(r.diagnostics.map((d) => d.code)).toEqual(['FS-RULES-003']);
  });
});
