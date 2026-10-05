/**
 * What a jurisdiction-profile builder needs beyond the profile validator (FLR-T-6.8, FLR-REQ-100,
 * Rules chapter 10): problems named field by field, so a form can say which field is wrong rather
 * than that the profile is; a canonical form, so two profiles that mean the same are the same bytes
 * and an export round-trips; and the profile read back the way the evaluator reads it — which
 * edition of each code is in force at `asOf`, which adoptions are superseded or not yet in effect,
 * and which rules the applying amendments withdraw.
 *
 * Nothing here decides whether a design meets a code. A profile says which editions are in force
 * where a house is built; the authority having jurisdiction decides everything else.
 */
import { applyingAmendments, editionsInForce } from '../evaluate.js';
import { assures, DEFAULT_PROFILE, profileOk } from '../structure.js';
import type { Adoption, Amendment, Profile } from '../types.js';
import { codeInfo, domainOf, domainRank, type Domain } from './catalogue.js';

/** One thing wrong with a profile, at a JSON-pointer-like path a form can map to its field. */
export interface ProfileProblem {
  /** `name`, `adopts/2/edition`, `amendments/0/withdraws/1/rule`, or `` for the profile as a whole. */
  readonly path: string;
  readonly message: string;
}

// The schema's patterns (schema/rules/0.1/defs.schema.json), so each field can be checked alone.
const CODE = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$/;
const EDITION = /^[0-9A-Za-z][0-9A-Za-z.-]{0,15}$/;
const DATE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const PACK = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RULE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HTTPS = /^https:\/\/(?:[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]|%[0-9A-Fa-f]{2})+$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/;
const RANGE = /^(>=|>|<=|<|=|\^|~)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?( +(>=|>|<=|<|=|\^|~)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?)*( +\|\| +(>=|>|<=|<|=|\^|~)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?( +(>=|>|<=|<|=|\^|~)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?)*)*$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A calendar date that exists: the schema's pattern accepts 2026-02-31, which no calendar has. */
export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  return d <= days;
}

function text(problems: ProfileProblem[], path: string, value: unknown, max: number, required: boolean, label: string): void {
  if (value === undefined) {
    if (required) problems.push({ path, message: `${label} is required` });
    return;
  }
  if (typeof value !== 'string' || value.length === 0) problems.push({ path, message: `${label} cannot be empty` });
  else if (value.length > max) problems.push({ path, message: `${label} is at most ${String(max)} characters` });
  else if (assures(value)) problems.push({ path, message: `${label} cannot say a design meets a code: findings are advice, and the authority having jurisdiction decides` });
}

function date(problems: ProfileProblem[], path: string, value: unknown, label: string): void {
  if (value !== undefined && !isDate(value)) problems.push({ path, message: `${label} is a date, YYYY-MM-DD` });
}

/**
 * Every problem with a profile, field by field (Rules 10.1): the schema's members and patterns, one
 * adoption per code and date, one entry per pack, real calendar dates, and no wording that says a
 * design meets a code. An empty list means `profileOk` accepts it — the last check is that one, so
 * the two can never disagree.
 */
export function profileProblems(value: unknown): ProfileProblem[] {
  const problems: ProfileProblem[] = [];
  if (!isObject(value)) return [{ path: '', message: 'a profile is a JSON object' }];
  const known = new Set(['floorspecRules', 'name', 'jurisdiction', 'adopts', 'asOf', 'packs', 'amendments', 'extras']);
  for (const key of Object.keys(value)) if (!known.has(key)) problems.push({ path: key, message: `${key} is not a member of a profile` });
  if (value['floorspecRules'] !== '0.1') problems.push({ path: 'floorspecRules', message: 'floorspecRules is "0.1"' });
  text(problems, 'name', value['name'], 200, true, 'The name');
  text(problems, 'jurisdiction', value['jurisdiction'], 200, false, 'The jurisdiction');
  date(problems, 'asOf', value['asOf'], 'The evaluation date');
  if (value['extras'] !== undefined && !isObject(value['extras'])) problems.push({ path: 'extras', message: 'extras is an object' });

  const adopts = value['adopts'];
  if (!Array.isArray(adopts)) problems.push({ path: 'adopts', message: 'adopts is a list of adoptions' });
  else {
    const seen = new Map<string, number>();
    adopts.forEach((a: unknown, i) => {
      const at = `adopts/${String(i)}`;
      if (!isObject(a)) {
        problems.push({ path: at, message: 'an adoption is an object' });
        return;
      }
      for (const key of Object.keys(a)) if (key !== 'code' && key !== 'edition' && key !== 'effective') problems.push({ path: `${at}/${key}`, message: `${key} is not a member of an adoption` });
      if (typeof a['code'] !== 'string' || a['code'].length > 32 || !CODE.test(a['code'])) problems.push({ path: `${at}/code`, message: 'a code is its short name in capitals: IRC, NEC, TEST-CODE' });
      if (typeof a['edition'] !== 'string' || !EDITION.test(a['edition'])) problems.push({ path: `${at}/edition`, message: 'an edition is a year or a short name: 2024' });
      date(problems, `${at}/effective`, a['effective'], 'The effective date');
      const key = `${String(a['code'])}\u0000${typeof a['effective'] === 'string' ? a['effective'] : '\u0000none'}`;
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        problems.push({
          path: `${at}/effective`,
          message: `${String(a['code'])} is adopted twice ${typeof a['effective'] === 'string' ? `effective ${a['effective']}` : 'with no effective date'}: give each adoption its own date`,
        });
      } else seen.set(key, i);
    });
  }

  const packs = value['packs'];
  if (packs !== undefined) {
    if (!Array.isArray(packs)) problems.push({ path: 'packs', message: 'packs is a list of pack selections' });
    else {
      const names = new Set<string>();
      packs.forEach((p: unknown, i) => {
        const at = `packs/${String(i)}`;
        if (!isObject(p)) {
          problems.push({ path: at, message: 'a pack selection is an object' });
          return;
        }
        if (typeof p['name'] !== 'string' || p['name'].length > 64 || !PACK.test(p['name'])) problems.push({ path: `${at}/name`, message: 'a pack name is lowercase words joined by hyphens' });
        else if (names.has(p['name'])) problems.push({ path: `${at}/name`, message: `${p['name']} is selected twice` });
        else names.add(p['name']);
        if (typeof p['version'] !== 'string' || !RANGE.test(p['version'])) problems.push({ path: `${at}/version`, message: 'a version range: ^0.6.0, >=1.0.0' });
      });
    }
  }

  const amendments = value['amendments'];
  if (amendments !== undefined) {
    if (!Array.isArray(amendments)) problems.push({ path: 'amendments', message: 'amendments is a list' });
    else {
      amendments.forEach((m: unknown, i) => {
        const at = `amendments/${String(i)}`;
        if (!isObject(m)) {
          problems.push({ path: at, message: 'an amendment is an object' });
          return;
        }
        for (const key of Object.keys(m)) if (!['citation', 'effective', 'withdraws', 'note'].includes(key)) problems.push({ path: `${at}/${key}`, message: `${key} is not a member of an amendment` });
        const citation = m['citation'];
        if (!isObject(citation)) problems.push({ path: `${at}/citation`, message: 'an amendment cites who made it and where' });
        else {
          text(problems, `${at}/citation/authority`, citation['authority'], 200, true, 'The authority');
          text(problems, `${at}/citation/reference`, citation['reference'], 200, true, 'The reference');
          if (citation['link'] !== undefined && (typeof citation['link'] !== 'string' || !HTTPS.test(citation['link']))) problems.push({ path: `${at}/citation/link`, message: 'a link is an https address' });
          for (const key of Object.keys(citation)) if (!['authority', 'reference', 'link'].includes(key)) problems.push({ path: `${at}/citation/${key}`, message: `${key} is not a member of a citation` });
        }
        date(problems, `${at}/effective`, m['effective'], 'The effective date');
        text(problems, `${at}/note`, m['note'], 2000, false, 'The note');
        const withdraws = m['withdraws'];
        if (!Array.isArray(withdraws) || withdraws.length === 0) problems.push({ path: `${at}/withdraws`, message: 'an amendment withdraws at least one rule' });
        else {
          withdraws.forEach((w: unknown, j) => {
            const wat = `${at}/withdraws/${String(j)}`;
            if (!isObject(w)) {
              problems.push({ path: wat, message: 'a rule is named by its pack and its ID' });
              return;
            }
            if (typeof w['pack'] !== 'string' || w['pack'].length > 64 || !PACK.test(w['pack'])) problems.push({ path: `${wat}/pack`, message: 'a pack name is lowercase words joined by hyphens' });
            if (typeof w['rule'] !== 'string' || !RULE.test(w['rule'])) problems.push({ path: `${wat}/rule`, message: 'a rule ID: letters, digits, dots, hyphens and underscores' });
          });
        }
      });
    }
  }

  // The schema and the rules-engine's own check have the last word.
  if (problems.length === 0 && !profileOk(value)) problems.push({ path: '', message: 'this is not a Floorspec Rules 0.1 profile (schema/rules/0.1/profile.schema.json)' });
  return problems;
}

/** A version range is a `^`/`~`/comparator range of semantic versions; the builder offers `^x.y.z`. */
export const caretRange = (version: string): string => (SEMVER.test(version) ? `^${version}` : version);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The canonical form of a profile: adoptions by domain, then code, then effective date (none first);
 * pack selections by name; empty optional members dropped. The meaning is unchanged — Rules 10.2
 * decides editions by date, not by position — so a saved profile reads in a stable order and two
 * profiles that mean the same serialize the same.
 */
export function normalizeProfile(profile: Profile): Profile {
  const adopts = [...profile.adopts].sort(
    (a, b) => domainRank(domainOf(a.code)) - domainRank(domainOf(b.code)) || cmp(a.code, b.code) || cmp(a.effective ?? '', b.effective ?? '') || cmp(a.edition, b.edition),
  ).map((a) => ({ code: a.code, edition: a.edition, ...(a.effective === undefined ? {} : { effective: a.effective }) }));
  const out: Profile = { floorspecRules: '0.1', name: profile.name, adopts };
  if (profile.jurisdiction !== undefined && profile.jurisdiction !== '') out.jurisdiction = profile.jurisdiction;
  if (profile.asOf !== undefined && profile.asOf !== '') out.asOf = profile.asOf;
  if (profile.packs !== undefined && profile.packs.length > 0) out.packs = [...profile.packs].sort((a, b) => cmp(a.name, b.name));
  if (profile.amendments !== undefined && profile.amendments.length > 0) out.amendments = profile.amendments;
  if (profile.extras !== undefined && Object.keys(profile.extras).length > 0) out.extras = profile.extras;
  return out;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort(cmp).map((k) => [k, sorted(value[k])]));
}

/** A profile as a file: canonical, members sorted, two spaces, one line feed — as a report is written (9.8). */
export const serializeProfile = (profile: Profile): string => `${JSON.stringify(sorted(normalizeProfile(profile)), null, 2)}\n`;

/** Whether two profiles mean the same. */
export const sameProfile = (a: Profile, b: Profile): boolean => serializeProfile(a) === serializeProfile(b);

export type ParsedProfile = { readonly ok: true; readonly profile: Profile } | { readonly ok: false; readonly problems: readonly ProfileProblem[] };

/** Read a profile file — an import: JSON, then every problem by field. */
export function parseProfile(source: string): ParsedProfile {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return { ok: false, problems: [{ path: '', message: `not JSON: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const problems = profileProblems(value);
  return problems.length === 0 ? { ok: true, profile: normalizeProfile(value as Profile) } : { ok: false, problems };
}

/** A new profile: the default profile's editions (10.6) under a name, ready to be changed. */
export function startingProfile(name: string, jurisdiction?: string): Profile {
  return normalizeProfile({
    floorspecRules: '0.1',
    name,
    ...(jurisdiction === undefined || jurisdiction === '' ? {} : { jurisdiction }),
    adopts: DEFAULT_PROFILE.adopts.map((a) => ({ ...a })),
  });
}

export type AdoptionStatus = 'inForce' | 'superseded' | 'notYet';

export interface AdoptionView {
  readonly index: number;
  readonly adoption: Adoption;
  readonly domain: Domain;
  readonly title: string | undefined;
  /**
   * `inForce`: the edition of its code in force (10.2). `superseded`: it applies, but a later
   * adoption of the same code is in force. `notYet`: its effective date is after `asOf`.
   */
  readonly status: AdoptionStatus;
}

/** Each adoption with what 10.2 makes of it at the profile's `asOf`. */
export function adoptionViews(profile: Profile): AdoptionView[] {
  const inForce = editionsInForce(profile);
  const latest = new Map<string, number>();
  profile.adopts.forEach((a, i) => {
    if (profile.asOf !== undefined && a.effective !== undefined && a.effective > profile.asOf) return;
    const current = latest.get(a.code);
    const prev = current === undefined ? undefined : profile.adopts[current];
    if (prev === undefined || (a.effective !== undefined && (prev.effective === undefined || a.effective > prev.effective))) latest.set(a.code, i);
  });
  return profile.adopts.map((adoption, index) => {
    const notYet = profile.asOf !== undefined && adoption.effective !== undefined && adoption.effective > profile.asOf;
    const status: AdoptionStatus = notYet ? 'notYet' : latest.get(adoption.code) === index && inForce.get(adoption.code) === adoption.edition ? 'inForce' : 'superseded';
    return { index, adoption, domain: domainOf(adoption.code), title: codeInfo(adoption.code)?.title, status };
  });
}

/** The edition in force of each code (10.2), by domain then code: what a profile card summarizes. */
export function inForceSummary(profile: Profile): { code: string; edition: string; domain: Domain }[] {
  return [...editionsInForce(profile)]
    .map(([code, edition]) => ({ code, edition, domain: domainOf(code) }))
    .sort((a, b) => domainRank(a.domain) - domainRank(b.domain) || cmp(a.code, b.code));
}

/** `IRC 2024 · NEC 2026 · IPC 2024`: the editions in force, for a profile's one-line summary. */
export const editionsLine = (profile: Profile): string => inForceSummary(profile).map((e) => `${e.code} ${e.edition}`).join(' · ');

export interface Withdrawal {
  readonly pack: string;
  readonly rule: string;
  /** The amendment's index in the profile. */
  readonly amendment: number;
  /** Whether the amendment applies at `asOf` (10.5): only then is the rule withdrawn. */
  readonly applies: boolean;
}

/** Every rule the profile's amendments withdraw, and whether each amendment applies yet. */
export function withdrawals(profile: Profile): Withdrawal[] {
  const applying = new Set<Amendment>(applyingAmendments(profile));
  return (profile.amendments ?? []).flatMap((m, amendment) => m.withdraws.map((w) => ({ pack: w.pack, rule: w.rule, amendment, applies: applying.has(m) })));
}

/** Whether the profile is the default profile (10.6), whatever its order. */
export const isDefaultProfile = (profile: Profile): boolean => sameProfile(profile, DEFAULT_PROFILE);
