import { CODES, codeInfo, normalizeProfile, profileProblems, type Profile } from '@floorspec/rules-engine';

/**
 * The profile builder's form state (FLR-T-6.8, FLR-REQ-100): a profile as strings a person types,
 * and back. An empty optional field is absent from the profile, never an empty string, so what is
 * saved is exactly what the standard's validator checks (Rules 10.1). The problems the rules
 * engine finds are mapped back onto the fields that caused them.
 */

export interface AdoptionDraft {
  code: string;
  edition: string;
  effective: string;
}

export interface AmendmentDraft {
  authority: string;
  reference: string;
  link: string;
  effective: string;
  note: string;
  withdraws: { pack: string; rule: string }[];
}

export interface Draft {
  name: string;
  jurisdiction: string;
  asOf: string;
  adopts: AdoptionDraft[];
  amendments: AmendmentDraft[];
  /** Kept as they are: the builder does not edit pack selections or extras (Rules 10.4, Core 1.7). */
  packs?: Profile['packs'];
  extras?: Profile['extras'];
}

export function fromProfile(p: Profile): Draft {
  return {
    name: p.name,
    jurisdiction: p.jurisdiction ?? '',
    asOf: p.asOf ?? '',
    adopts: p.adopts.map((a) => ({ code: a.code, edition: a.edition, effective: a.effective ?? '' })),
    amendments: (p.amendments ?? []).map((m) => ({
      authority: m.citation.authority,
      reference: m.citation.reference,
      link: m.citation.link ?? '',
      effective: m.effective ?? '',
      note: m.note ?? '',
      withdraws: m.withdraws.map((w) => ({ pack: w.pack, rule: w.rule })),
    })),
    ...(p.packs === undefined ? {} : { packs: p.packs }),
    ...(p.extras === undefined ? {} : { extras: p.extras }),
  };
}

const opt = <K extends string>(key: K, value: string): Partial<Record<K, string>> => (value.trim() === '' ? {} : ({ [key]: value.trim() } as Record<K, string>));

/** The profile a draft means. Not yet checked: `problemsOf` says what is wrong with it. */
export function toProfile(d: Draft): Profile {
  const amendments = d.amendments.map((m) => ({
    citation: { authority: m.authority.trim(), reference: m.reference.trim(), ...opt('link', m.link) },
    ...opt('effective', m.effective),
    withdraws: m.withdraws.map((w) => ({ pack: w.pack.trim(), rule: w.rule.trim() })) as [{ pack: string; rule: string }, ...{ pack: string; rule: string }[]],
    ...opt('note', m.note),
  }));
  return {
    floorspecRules: '0.1',
    name: d.name.trim(),
    ...opt('jurisdiction', d.jurisdiction),
    ...opt('asOf', d.asOf),
    adopts: d.adopts.map((a) => ({ code: a.code.trim().toUpperCase(), edition: a.edition.trim(), ...opt('effective', a.effective) })),
    ...(amendments.length === 0 ? {} : { amendments }),
    ...(d.packs === undefined ? {} : { packs: d.packs }),
    ...(d.extras === undefined ? {} : { extras: d.extras }),
  };
}

/** Problems by field path (`adopts/2/edition`), from the rules engine's checker. */
export function problemsOf(d: Draft): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of profileProblems(toProfile(d))) if (!out.has(p.path)) out.set(p.path, p.message);
  return out;
}

/** Whether a draft can be saved, and the profile it saves, canonical. */
export function saveable(d: Draft): Profile | null {
  return problemsOf(d).size === 0 ? normalizeProfile(toProfile(d)) : null;
}

/** A new adoption row: the next catalogue code not adopted yet, at its latest edition. */
export function nextAdoption(d: Draft): AdoptionDraft {
  const used = new Set(d.adopts.map((a) => a.code));
  const next = CODES.find((c) => !used.has(c.code)) ?? CODES[0];
  return { code: next?.code ?? 'IRC', edition: next?.editions.at(-1) ?? '', effective: '' };
}

export const blankAmendment = (): AmendmentDraft => ({ authority: '', reference: '', link: '', effective: '', note: '', withdraws: [{ pack: '', rule: '' }] });

/** The editions the catalogue offers for a code; empty for a code it does not list. */
export const editionsFor = (code: string): readonly string[] => codeInfo(code)?.editions ?? [];
