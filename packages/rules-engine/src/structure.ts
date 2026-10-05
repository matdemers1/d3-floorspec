/**
 * The shapes of the inputs — the request (1.1), a pack (2.1), a profile (10.1) — checked by the
 * generated validators of schema/rules/0.1 and 0.2; the assurance pattern (2.5); the diagnostic
 * catalogue (11.1); the notice (9.9) and the default profile (10.6).
 *
 * Each check takes the draft whose schema applies: an evaluator of a draft checks every input
 * against its own (1.1, 2.1, 10.1), so a 0.1 pack is no 0.2 pack. Without one, an input is checked
 * against the schema of the draft it declares — what the app does when it installs a pack or a
 * profile of either draft.
 */
import { validate as requestSchema } from './generated/validate-request.js';
import { validate as packSchema } from './generated/validate-pack.js';
import { validate as profileSchema } from './generated/validate-profile.js';
import { validate as requestSchema02 } from './generated/validate-request-0.2.js';
import { validate as packSchema02 } from './generated/validate-pack-0.2.js';
import { validate as profileSchema02 } from './generated/validate-profile-0.2.js';
import type { Pack, Profile, Request, RulesDiagnostic, RulesDraft } from './types.js';

type SchemaFn = (data: unknown) => boolean;

/** The drafts of Floorspec Rules this evaluator implements, oldest first, and the current one. */
export const RULES_DRAFTS: readonly RulesDraft[] = ['0.1', '0.2'];
export const CURRENT_RULES: RulesDraft = '0.2';

const SCHEMAS: Record<RulesDraft, { request: SchemaFn; pack: SchemaFn; profile: SchemaFn }> = {
  '0.1': { request: requestSchema, pack: packSchema, profile: profileSchema },
  '0.2': { request: requestSchema02, pack: packSchema02, profile: profileSchema02 },
};

/** The draft an input declares, when it is one this evaluator implements. */
export const declaredDraft = (v: unknown): RulesDraft | undefined => {
  const d = typeof v === 'object' && v !== null ? (v as { floorspecRules?: unknown }).floorspecRules : undefined;
  return d === '0.1' || d === '0.2' ? d : undefined;
};
const schemaOf = (kind: 'request' | 'pack' | 'profile', v: unknown, draft: RulesDraft | undefined): boolean => {
  const d = draft ?? declaredDraft(v);
  return d !== undefined && SCHEMAS[d][kind](v);
};

/** 9.9: the notice every report carries, exactly. */
export const NOTICE = 'Floorspec findings are advisory. They are not a plan review, and the authority having jurisdiction decides.';

/** 10.6: the default profile, "Model Codes (latest)" (FLR-ADR-011, FLR-REQ-099). */
export const DEFAULT_PROFILE: Readonly<Profile> = Object.freeze({
  adopts: [
    { code: 'IFGC', edition: '2024' },
    { code: 'IMC', edition: '2024' },
    { code: 'IPC', edition: '2024' },
    { code: 'IRC', edition: '2024' },
    { code: 'NEC', edition: '2026' },
  ],
  floorspecRules: '0.1',
  name: 'Model Codes (latest)',
});

/** 10.6: the default profile of a draft — the same editions, declaring that draft. */
export const defaultProfileOf = (draft: RulesDraft): Profile => ({ ...DEFAULT_PROFILE, adopts: DEFAULT_PROFILE.adopts.map((a) => ({ ...a })), floorspecRules: draft });

/**
 * 2.5: the assurance pattern — the words that say a design meets a code. ECMAScript with the flag
 * `i` only: without `u`, `\b` and case-insensitive matching are ASCII's.
 */
export const ASSURANCE = /\b(non-?)?compl(y|ies|ied|ying|iant|iance)\b|\b(meets?|pass(es|ed)?) (the )?codes?\b|\bup to codes?\b|\bcode[- ]approved\b/i;

export const assures = (text: string): boolean => ASSURANCE.test(text);

export const isRequest = (v: unknown, draft?: RulesDraft): v is Request => schemaOf('request', v, draft);
export const isPack = (v: unknown, draft?: RulesDraft): v is Pack => schemaOf('pack', v, draft);
export const isProfile = (v: unknown, draft?: RulesDraft): v is Profile => schemaOf('profile', v, draft);

/** 2.5: the text of a pack. */
export function packText(p: Pack): string[] {
  const out = [p.title, ...(p.description === undefined ? [] : [p.description])];
  for (const r of Object.values(p.rules)) {
    if (r === undefined) continue;
    out.push(r.title, r.paraphrase, ...(r.exceptions ?? []).map((e) => e.note));
    if (r.provenance.note !== undefined) out.push(r.provenance.note);
  }
  for (const c of p.coverage ?? []) if (c.note !== undefined) out.push(c.note);
  return out;
}

/** 10.1.1: the schema, one date per code, one entry per pack, and no assurance in its text. */
export function profileOk(v: unknown, draft?: RulesDraft): v is Profile {
  if (!isProfile(v, draft)) return false;
  const seen = new Set<string>();
  for (const a of v.adopts) {
    const key = `${a.code}\u0000${a.effective ?? '\u0000none'}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  const names = (v.packs ?? []).map((p) => p.name);
  if (new Set(names).size !== names.length) return false;
  const text = [v.name, ...(v.jurisdiction === undefined ? [] : [v.jurisdiction]), ...(v.amendments ?? []).flatMap((a) => (a.note === undefined ? [] : [a.note]))];
  return !text.some(assures);
}

/** 11.1: the catalogue — each code and its severity. */
export const CATALOGUE: Readonly<Record<string, RulesDiagnostic['severity']>> = {
  'FS-RULES-001': 'error',
  'FS-RULES-002': 'error',
  'FS-RULES-003': 'error',
  'FS-RULES-004': 'error',
  'FS-RULES-005': 'error',
  'FS-RULES-006': 'error',
  'FS-RULES-007': 'error',
  'FS-RULES-008': 'info',
  'FS-RULES-009': 'info',
  'FS-RULES-010': 'warning',
  'FS-RULES-011': 'warning',
};

export function diag(code: string, members: { packIndex?: number; pack?: string; rule?: string } = {}): RulesDiagnostic {
  return { code, severity: CATALOGUE[code]!, ...members };
}
