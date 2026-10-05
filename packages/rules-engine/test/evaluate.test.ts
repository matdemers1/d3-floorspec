/**
 * The pipeline (Rules 1.3) and the report (9), beyond the conformance suite: no packs, the order of
 * inputs, advice that never touches the document, wording, and the helper a server calls after a
 * commit.
 */
import { describe, expect, it } from 'vitest';
import { check, OFFICIAL_EXTENSIONS } from '@floorspec/engine';
import { ASSURANCE, DEFAULT_PROFILE, evaluate, findingsFor, NOTICE, serialize, type Pack, type Profile, type Rule } from '../src/index.js';
import { box, doc, FT, IN, thing } from './docs.js';

const W = 12 * FT;
const H = 10 * FT;

/** A bedroom with a window, no smoke alarm, and a panel whose working space a boiler stands in. */
const house = (): Record<string, unknown> =>
  doc(
    box(W, H, {
      rooms: { R1: { anchor: [W / 2, H / 2], function: 'sleeping' } },
      openings: { O1: { wall: 'W2', offset: 4 * FT, fill: 'WIN' } },
      extensionsUsed: { FS_electrical: '0.1.0', EXT_test: '1.0.0' },
      extensions: {
        FS_electrical: {
          collections: {
            panels: {
              X1: {
                ...thing({ min: [0, -256000, -512000], max: [128000, 256000, 512000] }, { mode: 'wallFace', wall: 'W1', side: 'right', offset: 5 * FT, height: 1536000 }),
                volts: [120, 240],
                rating: 100,
                spaces: 20,
                clearances: { working: { purpose: 'workingSpace', shape: 'box', min: [0, -15 * IN, -1536000], max: [3 * FT, 15 * IN, 1024000] } },
              },
            },
          },
        },
        EXT_test: { collections: { boilers: { Y1: thing({ min: [-256000, -256000, 0], max: [256000, 256000, 1280000] }, { mode: 'free', level: 'L1', position: [960000, 5 * FT] }) } } },
      },
    }),
  );

const rule = (over: Partial<Rule>): Rule => ({
  title: 'A synthetic rule',
  citation: { code: 'IRC', edition: '2024', section: 'TEST-1' },
  paraphrase: 'A synthetic rule for the engine’s tests; it states no requirement of any real code.',
  applies: { to: 'room', where: { measure: 'roomFunction', op: '=', value: 'sleeping' } },
  requirement: { measure: 'elementCount', args: { extension: 'FS_electrical', collection: 'alarms' }, op: '>=', value: 1 },
  severity: 'mayNotMeet',
  provenance: { verifiedBy: 'rules-engine tests', verifiedOn: '2026-10-05', edition: '2024' },
  ...over,
});

const pack = (name: string, rules: Record<string, Rule>, over: Partial<Pack> = {}): Pack => ({
  floorspecRules: '0.1',
  name,
  version: '0.1.0',
  title: `Synthetic ${name}`,
  license: 'CC-BY-4.0',
  rules,
  ...over,
});

const PACKS: Pack[] = [
  pack('alpha', {
    ALARM: rule({}),
    ALARM21: rule({ citation: { code: 'IRC', edition: '2021', section: 'TEST-1' }, provenance: { verifiedBy: 't', verifiedOn: '2026-10-05', edition: '2021' } }),
    SPACE: rule({
      title: 'Clear space in front of a panel',
      citation: { code: 'NEC', edition: '2026', section: 'TEST-2' },
      provenance: { verifiedBy: 't', verifiedOn: '2026-10-05', edition: '2026' },
      applies: { to: 'element', extension: 'FS_electrical', collection: 'panels' },
      select: { from: 'envelopes', args: { purpose: 'workingSpace' }, need: 'any' },
      requirement: { measure: 'clearDepthInFront', args: { limit: 3 * FT }, op: '>=', value: 3 * FT },
      severity: 'check',
    }),
  }),
  pack('beta', {
    AREA: rule({ requirement: { measure: 'roomNetArea', op: '>=', value: 70 * 152212340736 }, severity: 'note' }),
    STAIR: rule({ requirement: { measure: 'stairRiserHeight', op: '<=', value: 1 } }),
  }),
];

describe('no packs', () => {
  it('is a report that checked nothing and found nothing — not a clean bill', () => {
    const d = house();
    const r = findingsFor(d, undefined, []);
    expect(r).toEqual({
      floorspecRules: '0.1',
      notice: NOTICE,
      units: 'imperial',
      profile: DEFAULT_PROFILE.name,
      hash: check(d).hash,
      diagnostics: [],
      evaluated: [],
      notEvaluated: [],
      coverage: [],
      findings: [],
    });
  });
});

describe('a report', () => {
  const d = house();
  const r = findingsFor(d, undefined, PACKS);

  it('evaluates the rules in force under the default profile, and lists every other with its reason', () => {
    expect(r.evaluated.map((e) => [e.pack, e.rule, e.subjects, e.exempt, e.findings])).toEqual([
      ['alpha', 'ALARM', 1, 0, 1],
      ['alpha', 'SPACE', 1, 0, 1],
      ['beta', 'AREA', 1, 0, 0],
    ]);
    expect(r.notEvaluated).toEqual([
      { pack: 'alpha', version: '0.1.0', rule: 'ALARM21', reason: 'edition' },
      { pack: 'beta', version: '0.1.0', rule: 'STAIR', reason: 'deferred' },
    ]);
    expect(r.diagnostics).toEqual([{ code: 'FS-RULES-008', severity: 'info', pack: 'beta', rule: 'STAIR' }]);
  });

  it('words each finding as advice naming the edition, with a finding severity, never an error', () => {
    expect(r.findings.map((f) => f.message)).toEqual([
      'R1 may not meet IRC 2024 TEST-1 (A synthetic rule).',
      'X1 may not meet NEC 2026 TEST-2 (Clear space in front of a panel). Check it with a professional or the authority having jurisdiction.',
    ]);
    for (const f of r.findings) expect(['mayNotMeet', 'check', 'note']).toContain(f.severity);
    expect(ASSURANCE.test(serialize(r))).toBe(false);
  });

  it('places the panel finding: the panel, its space and the boiler in it, on its level', () => {
    const f = r.findings[1]!;
    expect(f.elements).toEqual(['X1', 'Y1']);
    expect(f.location.level).toBe('L1');
    expect(f.location.shapes.map((s) => s.kind)).toEqual(['polygon', 'polygon', 'polygon']);
    expect(f.measures).toMatchObject([{ measure: 'clearDepthInFront', value: 640000, involved: ['Y1'], holds: false, thresholdDisplay: "3' 0\"" }]);
  });

  it('is the same, byte for byte, whatever the order of packs and rules', () => {
    const reversed = [...PACKS].reverse().map((p) => ({ ...p, rules: Object.fromEntries(Object.entries(p.rules).reverse()) }));
    expect(serialize(findingsFor(d, undefined, reversed))).toBe(serialize(r));
  });

  it('follows the profile: another edition in force, a withdrawn rule, a pack not selected', () => {
    const profile: Profile = {
      floorspecRules: '0.1',
      name: 'Town of Example',
      adopts: [
        { code: 'IRC', edition: '2021', effective: '2022-01-01' },
        { code: 'IRC', edition: '2024', effective: '2026-07-01' },
        { code: 'NEC', edition: '2026' },
      ],
      asOf: '2026-01-01',
      packs: [{ name: 'alpha', version: '^0.1.0' }],
      amendments: [{ citation: { authority: 'Town of Example', reference: 'Ord. 1' }, withdraws: [{ pack: 'alpha', rule: 'SPACE' }] }],
    };
    const p = findingsFor(d, profile, PACKS);
    expect(p.profile).toBe('Town of Example');
    expect(p.evaluated.map((e) => e.rule)).toEqual(['ALARM21']);
    expect(p.notEvaluated.map((e) => [e.rule, e.reason])).toEqual([
      ['ALARM', 'edition'],
      ['SPACE', 'withdrawn'],
      ['AREA', 'profile'],
      ['STAIR', 'profile'],
    ]);
    expect(p.findings.map((f) => f.message)).toEqual(['R1 may not meet IRC 2021 TEST-1 (A synthetic rule).']);
  });
});

describe('advice, never a gate (1.5)', () => {
  it('evaluating changes nothing about the document: not its value, its validity, its hash or what it derives', () => {
    const d = house();
    const before = JSON.stringify(d);
    const derived = JSON.stringify(check(d, { extensions: ['FS_electrical'], knownExtensions: OFFICIAL_EXTENSIONS }));
    deepFreeze(d);
    const r = findingsFor(d, undefined, PACKS);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(d)).toBe(before);
    expect(JSON.stringify(check(d, { extensions: ['FS_electrical'], knownExtensions: OFFICIAL_EXTENSIONS }))).toBe(derived);
  });

  it('an invalid document gets FS-RULES-003 and no finding — rules never judge a document', () => {
    const d = house() as { rooms: Record<string, { level: string }> };
    d.rooms.R1!.level = 'NOPE';
    const r = findingsFor(d, undefined, PACKS);
    expect(r.diagnostics).toEqual([{ code: 'FS-RULES-003', severity: 'error' }]);
    expect(r.findings).toEqual([]);
    expect(r.hash).toBeUndefined();
  });
});

describe('the request (1.1) and the inputs it carries', () => {
  const d = house();

  it('a request that is not well-formed JSON, or has a duplicate member, is FS-RULES-001 alone', () => {
    for (const text of ['{', '{"floorspecRules":"0.1","packs":[],"packs":[]}', '{"floorspecRules":"0.2","packs":[]}', '[]'])
      expect(evaluate(d, text)).toEqual({ floorspecRules: '0.1', notice: NOTICE, diagnostics: [{ code: 'FS-RULES-001', severity: 'error' }], evaluated: [], notEvaluated: [], coverage: [], findings: [] });
  });

  it('a threshold written 1.0 is not a JSON integer: the pack does not match its schema', () => {
    const p = JSON.stringify(PACKS[1]).replace('"value":1}', '"value":1.0}');
    const r = evaluate(d, `{"floorspecRules":"0.1","packs":[${p}]}`);
    expect(r.diagnostics).toEqual([{ code: 'FS-RULES-004', severity: 'error', packIndex: 0 }]);
  });

  it('a profile of null is not the default: FS-RULES-002', () => {
    expect(evaluate(d, { floorspecRules: '0.1', packs: [], profile: null }).diagnostics).toEqual([{ code: 'FS-RULES-002', severity: 'error' }]);
  });

  it('a pack whose text says a design complies is refused: FS-RULES-006', () => {
    const bad = pack('gamma', { A: rule({ paraphrase: 'Rooms that comply get no finding.' }) });
    const r = findingsFor(d, undefined, [bad]);
    expect(r.diagnostics).toEqual([{ code: 'FS-RULES-006', severity: 'error', packIndex: 0 }]);
    expect(r.evaluated).toEqual([]);
  });

  it('a rule that reads an extension the document does not evaluate is not evaluated: FS-RULES-009', () => {
    const member = pack('delta', {
      AMPS: rule({
        citation: { code: 'NEC', edition: '2026', section: 'T' },
        provenance: { verifiedBy: 't', verifiedOn: '2026-10-05', edition: '2026' },
        applies: { to: 'element', extension: 'FS_electrical', collection: 'panels' },
        requirement: { measure: 'elementMember', args: { name: 'rating', type: 'integer', unit: 'A' }, op: '>=', value: 100 },
      }),
    });
    // With the official extensions known, FS_electrical is evaluated; with none known, it is not.
    expect(findingsFor(d, undefined, [member]).evaluated.map((e) => e.rule)).toEqual(['AMPS']);
    const r = evaluate(d, { floorspecRules: '0.1', packs: [member] });
    expect(r.notEvaluated).toEqual([{ pack: 'delta', version: '0.1.0', rule: 'AMPS', reason: 'extension' }]);
    expect(r.diagnostics).toEqual([{ code: 'FS-RULES-009', severity: 'info', pack: 'delta', rule: 'AMPS' }]);
  });

  it('displays in metric when asked', () => {
    const r = findingsFor(d, undefined, PACKS, { units: 'metric' });
    expect(r.units).toBe('metric');
    expect(r.findings[1]!.measures[0]!.display).toBe('500 mm');
  });
});

function deepFreeze(v: unknown): void {
  if (typeof v !== 'object' || v === null) return;
  Object.freeze(v);
  for (const x of Object.values(v)) deepFreeze(x);
}
