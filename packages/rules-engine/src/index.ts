/**
 * @floorspec/rules-engine — the reference evaluator of Floorspec Rules 0.1 (FLR-T-6.2): rule packs
 * evaluated against a Core document under a jurisdiction profile, giving advisory findings that name
 * the edition they were checked against.
 *
 * Rules advise; they never block (FLR-ADR-011, FLR-REQ-098). Evaluation runs on a committed,
 * valid document — after an Ops batch commits, never as a step of it — and never changes the
 * document, its validity, its hash or anything it derives. Nothing here ever says that a design
 * meets a code: a report says what was checked, what may not meet it, and what was not checked.
 *
 * Like the engine it is built on, the package is isomorphic (FLR-ADR-010): no Node built-ins, no
 * clock, no randomness; every measure is exact and rounded once (Rules 4.3).
 */
import { OFFICIAL_EXTENSIONS } from '@floorspec/engine';
import { evaluate, type EvaluateOptions, type Input } from './evaluate.js';
import type { Pack, Profile, Report, Units } from './types.js';

export { evaluate, callMeasures, serialize, editionsInForce, applyingAmendments, type EvaluateOptions, type Input } from './evaluate.js';
export { NOTICE, DEFAULT_PROFILE, ASSURANCE, assures, CATALOGUE, isPack, isProfile, isRequest, profileOk, packText } from './structure.js';
export { MEASURES, DEFERRED, measureFor } from './measures/library.js';
export { argsOk, typeOf, type Measure, type Value } from './measures/measure.js';
export { typeRule, valueOk, CANDIDATE_SETS, type Typing } from './typing.js';
export { displayValue, displayThreshold, displayLength, displayArea } from './display.js';
export { wallLine, stretches, receptacleMeasures } from './measures/walllines.js';
export type * from './types.js';
export * from './profiles/index.js';

export const RULES_VERSION = '0.1';

export interface FindingsOptions extends EvaluateOptions {
  /** How the report displays lengths and areas (9.6). Default: imperial. */
  readonly units?: Units;
}

/**
 * The helper a server calls **after a commit** (1.5, FLR-REQ-098): evaluate `packs` against the
 * committed `document` under `profile` (the default profile, 10.6, when absent) and return the
 * report. It never throws for a bad pack or profile — those are diagnostics in the report — and
 * with no packs it returns a report with no findings, whose `evaluated` is empty: nothing was
 * checked, which is not the same as nothing was found.
 *
 * The evaluator implements every official extension, and by default knows them at the versions the
 * engine implements (`OFFICIAL_EXTENSIONS`), so a project's electrical data is evaluated; pass
 * `knownExtensions` to configure it as a project's validator is configured instead.
 */
export function findingsFor(document: Input, profile: Profile | undefined, packs: readonly Pack[], options: FindingsOptions = {}): Report {
  const request = {
    floorspecRules: '0.1' as const,
    packs: [...packs],
    ...(profile !== undefined && { profile }),
    ...(options.units !== undefined && { units: options.units }),
  };
  return evaluate(document, request, { ...options, knownExtensions: options.knownExtensions ?? OFFICIAL_EXTENSIONS });
}
