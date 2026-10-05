import { describe, expect, it } from 'vitest';
import {
  adoptionViews,
  caretRange,
  CODES,
  DEFAULT_PROFILE,
  domainOf,
  editionsLine,
  findingsFor,
  inForceSummary,
  isDate,
  isDefaultProfile,
  latestEdition,
  normalizeProfile,
  parseProfile,
  profileOk,
  profileProblems,
  sameProfile,
  serializeProfile,
  startingProfile,
  withdrawals,
  type Pack,
  type Profile,
} from '../src/index.js';

/** FLR-T-6.8: what the profile builder needs beyond the validator (Rules chapter 10). */

const COUNTY: Profile = {
  floorspecRules: '0.1',
  name: 'Example County',
  jurisdiction: 'Example County, Example State',
  asOf: '2025-01-01',
  adopts: [
    { code: 'NEC', edition: '2023', effective: '2024-04-01' },
    { code: 'IRC', edition: '2021', effective: '2024-03-15' },
    { code: 'IRC', edition: '2024', effective: '2026-01-01' },
    { code: 'IRC', edition: '2018' },
  ],
  amendments: [
    { citation: { authority: 'Example County', reference: 'Ord. 2024-7 §3', link: 'https://example.org/ord/2024-7' }, withdraws: [{ pack: 'us-model-latest', rule: 'IRC-R314-1' }], note: 'Smoke alarms are interconnected by the county’s own rule.' },
    { citation: { authority: 'Example County', reference: 'Ord. 2026-1' }, effective: '2026-06-01', withdraws: [{ pack: 'us-model-latest', rule: 'NEC-210-52' }] },
  ],
};

describe('the edition catalogue', () => {
  it('lists the default profile’s codes, at the default profile’s editions as the latest', () => {
    for (const a of DEFAULT_PROFILE.adopts) {
      expect(latestEdition(a.code), a.code).toBe(a.edition);
    }
    expect(CODES.every((c) => c.editions.length > 0 && /^[A-Z]/.test(c.code))).toBe(true);
  });

  it('puts a code in a domain, the synthetic test codes too', () => {
    expect(domainOf('IRC')).toBe('building');
    expect(domainOf('NEC')).toBe('electrical');
    expect(domainOf('IFGC')).toBe('fuelGas');
    expect(domainOf('TEST-ELEC')).toBe('electrical');
    expect(domainOf('TEST-CODE')).toBe('building');
    expect(domainOf('MA-780CMR')).toBe('other');
  });
});

describe('problems, field by field', () => {
  it('finds none in the default profile, or in a county profile with editions, dates and amendments', () => {
    expect(profileProblems(DEFAULT_PROFILE)).toEqual([]);
    expect(profileProblems(COUNTY)).toEqual([]);
  });

  it('names the field of each problem', () => {
    const bad = {
      floorspecRules: '0.1',
      name: '',
      adopts: [
        { code: 'irc', edition: '2024' },
        { code: 'NEC', edition: '2026', effective: '2026-02-30' },
        { code: 'IPC', edition: '2024' },
        { code: 'IPC', edition: '2021' },
      ],
      amendments: [{ citation: { authority: 'Town', reference: 'Ord. 1', link: 'http://example.org' }, withdraws: [] }],
      packs: [{ name: 'us-model-latest', version: 'latest' }],
    };
    const paths = profileProblems(bad).map((p) => p.path);
    expect(paths).toEqual(
      expect.arrayContaining(['name', 'adopts/0/code', 'adopts/1/effective', 'adopts/3/effective', 'amendments/0/citation/link', 'amendments/0/withdraws', 'packs/0/version']),
    );
    expect(profileOk(bad)).toBe(false);
  });

  it('refuses wording that says a design meets a code, as the validator does (10.1.1)', () => {
    const p = { ...COUNTY, jurisdiction: 'Where every house is up to code' };
    expect(profileProblems(p).map((x) => x.path)).toEqual(['jurisdiction']);
    expect(profileOk(p)).toBe(false);
    const note = { ...COUNTY, amendments: [{ ...COUNTY.amendments![0]!, note: 'Makes the design compliant.' }] };
    expect(profileProblems(note).map((x) => x.path)).toEqual(['amendments/0/note']);
  });

  it('agrees with profileOk: no problem exactly when the validator accepts it', () => {
    const cases: unknown[] = [DEFAULT_PROFILE, COUNTY, {}, null, { ...COUNTY, extra: 1 }, { ...COUNTY, asOf: '2025-13-01' }, { ...COUNTY, packs: [{ name: 'a', version: '^1.0.0' }, { name: 'a', version: '^2.0.0' }] }];
    for (const c of cases) expect(profileProblems(c).length === 0, JSON.stringify(c)).toBe(profileOk(c));
  });

  it('knows a calendar date', () => {
    expect(isDate('2024-02-29')).toBe(true);
    expect(isDate('2023-02-29')).toBe(false);
    expect(isDate('2100-02-29')).toBe(false);
    expect(isDate('2026-04-31')).toBe(false);
    expect(isDate('26-04-01')).toBe(false);
  });
});

describe('the canonical form, import and export', () => {
  it('orders adoptions by domain, code and date, and round-trips through a file', () => {
    const n = normalizeProfile(COUNTY);
    expect(n.adopts.map((a) => `${a.code} ${a.edition}`)).toEqual(['IRC 2018', 'IRC 2021', 'IRC 2024', 'NEC 2023']);
    const file = serializeProfile(COUNTY);
    expect(file.endsWith('}\n')).toBe(true);
    const back = parseProfile(file);
    expect(back.ok).toBe(true);
    if (back.ok) expect(sameProfile(back.profile, COUNTY)).toBe(true);
  });

  it('reports why an import is refused', () => {
    expect(parseProfile('{')).toMatchObject({ ok: false, problems: [{ path: '' }] });
    const refused = parseProfile(JSON.stringify({ ...COUNTY, name: 'Up to code' }));
    expect(refused).toMatchObject({ ok: false, problems: [{ path: 'name' }] });
  });

  it('starts a new profile from the default editions', () => {
    const p = startingProfile('Town of Example', 'Town of Example, MA');
    expect(profileProblems(p)).toEqual([]);
    expect(editionsLine(p)).toBe('IRC 2024 · NEC 2026 · IPC 2024 · IMC 2024 · IFGC 2024');
    expect(isDefaultProfile(p)).toBe(false);
    expect(isDefaultProfile(normalizeProfile(DEFAULT_PROFILE))).toBe(true);
    expect(caretRange('0.6.0')).toBe('^0.6.0');
  });
});

describe('what 10.2 and 10.5 make of a profile', () => {
  it('says which edition is in force at asOf, which is superseded and which is not yet in effect', () => {
    const views = adoptionViews(COUNTY);
    expect(views.map((v) => `${v.adoption.code} ${v.adoption.edition} ${v.status}`)).toEqual([
      'NEC 2023 inForce',
      'IRC 2021 inForce',
      'IRC 2024 notYet',
      'IRC 2018 superseded',
    ]);
    expect(inForceSummary(COUNTY)).toEqual([
      { code: 'IRC', edition: '2021', domain: 'building' },
      { code: 'NEC', edition: '2023', domain: 'electrical' },
    ]);
    // Moving asOf past the IRC 2024 date changes which edition is in force.
    expect(inForceSummary({ ...COUNTY, asOf: '2026-02-01' })[0]).toEqual({ code: 'IRC', edition: '2024', domain: 'building' });
  });

  it('lists the rules the amendments withdraw, and whether each amendment applies yet', () => {
    expect(withdrawals(COUNTY)).toEqual([
      { pack: 'us-model-latest', rule: 'IRC-R314-1', amendment: 0, applies: true },
      { pack: 'us-model-latest', rule: 'NEC-210-52', amendment: 1, applies: false },
    ]);
  });

  it('changes the findings when the profile changes (10.7)', () => {
    const pack: Pack = {
      floorspecRules: '0.1',
      name: 'tiny',
      version: '0.1.0',
      title: 'Tiny synthetic pack',
      license: 'CC-BY-4.0',
      rules: {
        LEVELS: {
          title: 'A house has a level',
          citation: { code: 'TEST-CODE', edition: '2024', section: '§9' },
          paraphrase: 'Synthetic: a project has at least one level. It states no requirement of any real code.',
          applies: { to: 'level' },
          requirement: { measure: 'roomCount', op: '>=', value: 1 },
          severity: 'note',
          provenance: { verifiedBy: 'test', verifiedOn: '2026-10-05', edition: '2024' },
        },
      },
    };
    const doc = { floorspec: '0.2', project: { name: 'Empty' }, buildings: { B1: {} }, levels: { L1: { building: 'B1', elevation: 0, height: 3456000 } } };
    const under = (profile: Profile | undefined) => findingsFor(doc, profile, [pack]);
    expect(under(undefined).notEvaluated.map((r) => r.reason)).toEqual(['edition']);
    const test = startingProfile('Test');
    test.adopts.push({ code: 'TEST-CODE', edition: '2024' });
    expect(under(test).findings.map((f) => f.subject.id)).toEqual(['L1']);
    const withdrawn: Profile = { ...test, amendments: [{ citation: { authority: 'Test', reference: 'A1' }, withdraws: [{ pack: 'tiny', rule: 'LEVELS' }] }] };
    expect(under(withdrawn).notEvaluated.map((r) => r.reason)).toEqual(['withdrawn']);
  });
});
