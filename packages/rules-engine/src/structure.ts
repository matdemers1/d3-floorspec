/**
 * The shapes of the inputs — the request (1.1), a pack (2.1), a profile (10.1) — checked by the
 * generated validators of schema/rules/0.1; the assurance pattern (2.5); the diagnostic catalogue
 * (11.1); the notice (9.9) and the default profile (10.6).
 */
import { validate as requestSchema } from './generated/validate-request.js';
import { validate as packSchema } from './generated/validate-pack.js';
import { validate as profileSchema } from './generated/validate-profile.js';
import type { Pack, Profile, Request, RulesDiagnostic } from './types.js';

type SchemaFn = (data: unknown) => boolean;

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

/**
 * 2.5: the assurance pattern — the words that say a design meets a code. ECMAScript with the flag
 * `i` only: without `u`, `\b` and case-insensitive matching are ASCII's.
 */
export const ASSURANCE = /\b(non-?)?compl(y|ies|ied|ying|iant|iance)\b|\b(meets?|pass(es|ed)?) (the )?codes?\b|\bup to codes?\b|\bcode[- ]approved\b/i;

export const assures = (text: string): boolean => ASSURANCE.test(text);

export const isRequest = (v: unknown): v is Request => (requestSchema as unknown as SchemaFn)(v);
export const isPack = (v: unknown): v is Pack => (packSchema as unknown as SchemaFn)(v);
export const isProfile = (v: unknown): v is Profile => (profileSchema as unknown as SchemaFn)(v);

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
export function profileOk(v: unknown): v is Profile {
  if (!isProfile(v)) return false;
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
