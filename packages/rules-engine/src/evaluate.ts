/**
 * The evaluator of Floorspec Rules 0.1 (Rules 0.2: the evaluator class): a document, the
 * extensions it implements and its known extensions, and an evaluation request in; the report of
 * chapter 9 out. The steps are those of 1.3, in order.
 *
 * Evaluation is pure (1.4): nothing here reads a clock, the environment or anything but its
 * arguments, and the order in which a request lists packs or a pack lists rules changes nothing.
 * It never changes the document (1.5): the engine validates and derives it, and the measures only
 * read what it derived.
 */
import {
  contentHash,
  deriveFrom,
  evaluate as evaluateDocument,
  OFFICIAL_EXTENSION_NAMES,
  parseJson,
  versionSatisfies,
  writePretty,
  type JsonPath,
  type ValidateOptions,
} from '@floorspec/engine';
import { Evaluator, cmpTarget } from './evaluation.js';
import { measureFor } from './measures/library.js';
import { argsOk } from './measures/measure.js';
import { cmpStr, Model } from './model.js';
import { assures, DEFAULT_PROFILE, diag, isPack, isRequest, NOTICE, packText, profileOk } from './structure.js';
import type {
  EvaluatedRule,
  Finding,
  MeasureCall,
  MeasureResult,
  NotEvaluatedRule,
  Pack,
  Profile,
  Report,
  ReportCoverageEntry,
  Request,
  RulesDiagnostic,
  Units,
} from './types.js';
import { typeRule } from './typing.js';

export type Input = string | Uint8Array | object;

export interface EvaluateOptions {
  /**
   * The extensions the evaluator implements (Core 1.6.4). Default: every official extension the
   * engine implements (FS_electrical, FS_plumbing, FS_mechanical, FS_lowvoltage), as the
   * conformance suite's evaluator does.
   */
  readonly extensions?: readonly string[];
  /**
   * The known extensions its validator is configured with (Core 12.2): registry entries, as JSON
   * text, bytes or a parsed array. Absent: none — and then no extension is evaluated for any
   * document (1.2). The engine's `OFFICIAL_EXTENSIONS` are the official entries.
   */
  readonly knownExtensions?: ValidateOptions['knownExtensions'];
}

// ── the request as JSON (1.1) ─────────────────────────────────────────────────

/**
 * A JSON text read as Core 9.1 reads one, with every number written with a fraction or an exponent
 * replaced by NaN: `1.0` is not a JSON integer (Core 2.1.1), so no integer keyword or check
 * accepts it — exactly as the engine's schema tier sees a document.
 */
function readJson(input: string | Uint8Array): { ok: true; value: unknown } | { ok: false } {
  const parsed = parseJson(input);
  if (parsed.diagnostics.length > 0 || !('value' in parsed)) return { ok: false };
  if (parsed.nonIntegerLiterals.length === 0) return { ok: true, value: parsed.value };
  return { ok: true, value: withNaN(parsed.value, parsed.nonIntegerLiterals) };
}

function withNaN(value: unknown, paths: readonly JsonPath[]): unknown {
  if (paths.some((p) => p.length === 0)) return Number.NaN;
  const root = structuredClone(value);
  for (const path of paths) {
    let node = root as Record<string | number, unknown>;
    for (const k of path.slice(0, -1)) node = node[k] as Record<string | number, unknown>;
    Object.defineProperty(node, path[path.length - 1]!, { value: Number.NaN, enumerable: true, writable: true, configurable: true });
  }
  return root;
}

// ── profiles (chapter 10) ───────────────────────────────────────────────────

/** 10.2: the edition of each code in force. */
export function editionsInForce(profile: Profile): Map<string, string> {
  const asOf = profile.asOf;
  const best = new Map<string, { effective: string | undefined; edition: string }>();
  for (const a of profile.adopts) {
    const eff = a.effective;
    if (asOf !== undefined && eff !== undefined && eff > asOf) continue;
    const cur = best.get(a.code);
    if (cur === undefined || (eff !== undefined && (cur.effective === undefined || eff > cur.effective))) best.set(a.code, { effective: eff, edition: a.edition });
  }
  return new Map([...best].map(([k, v]) => [k, v.edition]));
}

/** 10.5: the amendments that apply at the profile's `asOf`. */
export const applyingAmendments = (profile: Profile): NonNullable<Profile['amendments']> =>
  (profile.amendments ?? []).filter((a) => profile.asOf === undefined || a.effective === undefined || a.effective <= profile.asOf);

// ── the report (9.1, 9.7, 9.8) ─────────────────────────────────────────────────

function report(members: Partial<Report>): Report {
  return { floorspecRules: '0.1', notice: NOTICE, diagnostics: [], evaluated: [], notEvaluated: [], coverage: [], findings: [], ...members };
}

/** An absent member sorts first; integers numerically, strings by UTF-16 code units (9.7). */
function cmpOptional(a: string | number | undefined, b: string | number | undefined): number {
  if (a === undefined || b === undefined) return a === undefined ? (b === undefined ? 0 : -1) : 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return cmpStr(String(a), String(b));
}

const cmpDiagnostic = (a: RulesDiagnostic, b: RulesDiagnostic): number =>
  cmpStr(a.code, b.code) || cmpOptional(a.packIndex, b.packIndex) || cmpOptional(a.pack, b.pack) || cmpOptional(a.rule, b.rule);

const cmpRuleEntry = (a: { pack: string; rule: string }, b: { pack: string; rule: string }): number => cmpStr(a.pack, b.pack) || cmpStr(a.rule, b.rule);

const cmpCoverage = (a: ReportCoverageEntry, b: ReportCoverageEntry): number =>
  cmpStr(a.pack, b.pack) ||
  cmpStr(a.code, b.code) ||
  cmpStr(a.edition, b.edition) ||
  cmpStr(a.section, b.section) ||
  cmpStr(a.status, b.status) ||
  cmpOptional(a.note, b.note);

const cmpFinding = (a: Finding, b: Finding): number => cmpStr(a.pack, b.pack) || cmpStr(a.rule, b.rule) || cmpTarget(a.subject, b.subject);

/** 9.8: a report (or a measure test's results) written as Core 9.2 step 2 writes a value. */
export function serialize(value: Report | { results: MeasureResult[] }): string {
  return writePretty(value);
}

// ── the document (1.2) ────────────────────────────────────────────────────────

function readDocument(document: Input, units: Units, options: EvaluateOptions): { model: Model; hash: string } | undefined {
  const ev = evaluateDocument(document, {
    extensions: options.extensions ?? OFFICIAL_EXTENSION_NAMES,
    ...(options.knownExtensions !== undefined && { knownExtensions: options.knownExtensions }),
  });
  if (!ev.valid || ev.document === undefined || ev.analysis === undefined) return undefined;
  const derived = deriveFrom(ev.document, ev.analysis);
  const evaluated = (ev.extensions ?? []).map((run) => run.impl.name);
  return { model: new Model(ev.document, ev.analysis, derived, evaluated, units), hash: contentHash(ev.document) };
}

// ── the pipeline (1.3) ────────────────────────────────────────────────────────

/**
 * Evaluate a request (1.1) against a document: the report of chapter 9. The document and the
 * request may each be a JSON text (a string or UTF-8 bytes) or an already-parsed value.
 */
export function evaluate(document: Input, request: Input, options: EvaluateOptions = {}): Report {
  // 1. The request.
  let req: unknown;
  if (typeof request === 'string' || request instanceof Uint8Array) {
    const r = readJson(request);
    if (!r.ok) return report({ diagnostics: [diag('FS-RULES-001')] });
    req = r.value;
  } else req = request;
  if (!isRequest(req)) return report({ diagnostics: [diag('FS-RULES-001')] });
  const units: Units = req.units ?? 'imperial';

  // 2. The profile — the request's, or the default (10.6).
  const profile: unknown = Object.hasOwn(req, 'profile') ? req.profile : DEFAULT_PROFILE;
  if (!profileOk(profile)) return report({ units, diagnostics: [diag('FS-RULES-002')] });

  // 3. The document.
  const doc = readDocument(document, units, options);
  if (doc === undefined) return report({ units, profile: profile.name, diagnostics: [diag('FS-RULES-003')] });
  return evaluateValid(doc.model, doc.hash, req, profile);
}

function evaluateValid(model: Model, hash: string, req: Request, profile: Profile): Report {
  const ds: RulesDiagnostic[] = [];
  // 4. The packs: the schema, then shared names and wording among those that match it.
  const packs = req.packs;
  const valid: number[] = [];
  packs.forEach((p, i) => {
    if (isPack(p)) valid.push(i);
    else ds.push(diag('FS-RULES-004', { packIndex: i }));
  });
  const usableIdx = new Set(valid);
  for (const i of valid) {
    const p = packs[i] as Pack;
    if (valid.filter((j) => (packs[j] as Pack).name === p.name).length > 1) {
      ds.push(diag('FS-RULES-005', { packIndex: i }));
      usableIdx.delete(i);
    }
    if (packText(p).some(assures)) {
      ds.push(diag('FS-RULES-006', { packIndex: i }));
      usableIdx.delete(i);
    }
  }
  const usable = [...usableIdx].sort((a, b) => a - b).map((i) => packs[i] as Pack);

  // 5. The profile's packs (10.4) and amendments (10.5).
  let selected: Set<Pack>;
  if (profile.packs !== undefined) {
    selected = new Set();
    for (const sel of profile.packs) {
      const hits = usable.filter((p) => p.name === sel.name && versionSatisfies(p.version, sel.version));
      if (hits.length === 0) ds.push(diag('FS-RULES-010', { pack: sel.name }));
      for (const p of hits) selected.add(p);
    }
  } else selected = new Set(usable);
  const withdrawn = new Set<string>();
  for (const am of applyingAmendments(profile))
    for (const w of am.withdraws) {
      withdrawn.add(`${w.pack}\u0000${w.rule}`);
      if (!usable.some((p) => p.name === w.pack && Object.hasOwn(p.rules, w.rule))) ds.push(diag('FS-RULES-011', { pack: w.pack, rule: w.rule }));
    }
  const inForce = editionsInForce(profile);

  // 6. Each rule of each usable pack; 7. its subjects and their findings.
  const ev = new Evaluator(model);
  const evaluated: EvaluatedRule[] = [];
  const notEvaluated: NotEvaluatedRule[] = [];
  const coverage: ReportCoverageEntry[] = [];
  const findings: Finding[] = [];
  for (const p of usable) {
    for (const ruleId of Object.keys(p.rules).sort(cmpStr)) {
      const rule = p.rules[ruleId]!;
      const base = { pack: p.name, version: p.version, rule: ruleId };
      if (!selected.has(p)) {
        notEvaluated.push({ ...base, reason: 'profile' });
        continue;
      }
      const typing = typeRule(rule);
      if (!typing.ok) {
        ds.push(diag('FS-RULES-007', { pack: p.name, rule: ruleId }));
        notEvaluated.push({ ...base, reason: 'invalid' });
        continue;
      }
      if (typing.deferred) {
        ds.push(diag('FS-RULES-008', { pack: p.name, rule: ruleId }));
        notEvaluated.push({ ...base, reason: 'deferred' });
        continue;
      }
      const c = rule.citation;
      if (inForce.get(c.code) !== c.edition) {
        notEvaluated.push({ ...base, reason: 'edition' });
        continue;
      }
      if (withdrawn.has(`${p.name}\u0000${ruleId}`)) {
        notEvaluated.push({ ...base, reason: 'withdrawn' });
        continue;
      }
      if (![...typing.reads].every((x) => model.evaluated.has(x))) {
        ds.push(diag('FS-RULES-009', { pack: p.name, rule: ruleId }));
        notEvaluated.push({ ...base, reason: 'extension' });
        continue;
      }
      const r = ev.evaluateRule(p, ruleId, rule);
      evaluated.push({ ...base, citation: c, subjects: r.subjects, exempt: r.exempt, findings: r.findings.length });
      findings.push(...r.findings);
    }
    if (selected.has(p)) for (const cv of p.coverage ?? []) if (inForce.get(cv.code) === cv.edition) coverage.push({ pack: p.name, ...cv });
  }
  return report({
    units: req.units ?? 'imperial',
    profile: profile.name,
    hash,
    diagnostics: ds.sort(cmpDiagnostic),
    evaluated: evaluated.sort(cmpRuleEntry),
    notEvaluated: notEvaluated.sort(cmpRuleEntry),
    coverage: coverage.sort(cmpCoverage),
    findings: findings.sort(cmpFinding),
  });
}

// ── measure calls (4.7) ───────────────────────────────────────────────────────

/**
 * The measure results (4.7) of a list of measure calls on a valid document — what a measure test
 * of the conformance suite checks. Throws for a document that is not valid, or a call that names no
 * measure of its target's kind or gives it arguments it does not take.
 */
export function callMeasures(document: Input, calls: { units?: Units; calls: readonly MeasureCall[] }, options: EvaluateOptions = {}): { results: MeasureResult[] } {
  const doc = readDocument(document, calls.units ?? 'imperial', options);
  if (doc === undefined) throw new Error('callMeasures: the document is not valid');
  const ev = new Evaluator(doc.model);
  return {
    results: calls.calls.map((c) => {
      const m = measureFor(c.measure, c.target.kind);
      const args = c.args ?? {};
      if (m === undefined || !argsOk(m, args)) throw new Error(`callMeasures: ${c.measure} on a ${c.target.kind} with ${JSON.stringify(args)} is not a measure call`);
      return ev.result(c.measure, c.target, args).result;
    }),
  };
}
