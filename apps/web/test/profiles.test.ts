import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, serializeProfile, startingProfile } from '@floorspec/rules-engine';
import { blankAmendment, editionsFor, fromProfile, nextAdoption, problemsOf, saveable, toProfile } from '../src/profiles/draft';

/** FLR-T-6.8: the profile builder's form state, to a profile and back, with problems on fields. */

describe('the profile builder', () => {
  it('round-trips a profile through the form, empty optional fields absent', () => {
    const draft = fromProfile(startingProfile('Town of Example', 'Town of Example, MA'));
    expect(draft.asOf).toBe('');
    const profile = toProfile(draft);
    expect(profile).not.toHaveProperty('asOf');
    expect(profile).not.toHaveProperty('amendments');
    expect(serializeProfile(profile)).toBe(serializeProfile(startingProfile('Town of Example', 'Town of Example, MA')));
  });

  it('sets editions, effective dates and a cited amendment, and saves them canonical', () => {
    const draft = fromProfile(startingProfile('County'));
    draft.asOf = '2026-03-01';
    draft.adopts.push({ code: 'IRC', edition: '2021', effective: '2024-03-15' });
    const irc = draft.adopts.find((a) => a.code === 'IRC');
    if (irc !== undefined) irc.effective = '2026-01-01';
    draft.amendments.push({ ...blankAmendment(), authority: 'County', reference: 'Ord. 7 §2', link: 'https://example.org/ord-7', note: 'Uses its own alarm rule.', withdraws: [{ pack: 'us-model-latest', rule: 'R314-1' }] });
    const saved = saveable(draft);
    expect(saved).not.toBeNull();
    expect(saved?.adopts.filter((a) => a.code === 'IRC').map((a) => `${a.edition} ${a.effective ?? ''}`)).toEqual(['2021 2024-03-15', '2024 2026-01-01']);
    expect(saved?.amendments?.[0]).toEqual({ citation: { authority: 'County', reference: 'Ord. 7 §2', link: 'https://example.org/ord-7' }, withdraws: [{ pack: 'us-model-latest', rule: 'R314-1' }], note: 'Uses its own alarm rule.' });
  });

  it('puts each problem on the field that caused it, and refuses to save', () => {
    const draft = fromProfile(startingProfile('County'));
    draft.name = ' ';
    draft.adopts.push({ code: 'irc!', edition: '', effective: '2026-02-30' });
    draft.amendments.push(blankAmendment());
    const problems = problemsOf(draft);
    expect([...problems.keys()]).toEqual(expect.arrayContaining(['name', 'adopts/5/code', 'adopts/5/edition', 'adopts/5/effective', 'amendments/0/citation/authority', 'amendments/0/withdraws/0/pack']));
    expect(saveable(draft)).toBeNull();
    draft.name = 'Every house here is up to code';
    expect(problemsOf(draft).get('name')).toMatch(/cannot say a design meets a code/);
  });

  it('offers the next code not adopted yet, at its latest edition', () => {
    const draft = fromProfile({ ...DEFAULT_PROFILE, adopts: [{ code: 'IRC', edition: '2024' }] });
    expect(nextAdoption(draft)).toEqual({ code: 'NEC', edition: '2026', effective: '' });
    expect(editionsFor('IRC')).toContain('2021');
    expect(editionsFor('TEST-CODE')).toEqual([]);
  });
});
