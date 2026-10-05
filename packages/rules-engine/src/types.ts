/**
 * The Rules 0.1 objects. The inputs — request, pack, rule, profile, test — are the types generated
 * from schema/rules/0.1 (FLR-ADR-006), under readable names; the report and its parts are written
 * out here, because what the schema calls "any JSON" (a measured value, a threshold) the engine
 * knows exactly.
 */
import type * as G from './generated/types.js';

export type Request = G.FloorspecRules01EvaluationRequest;
export type Pack = G.FloorspecRules01RulePack;
export type Rule = G.FloorspecRules01RuleRecord;
export type Profile = G.FloorspecRules01JurisdictionProfile;
export type Test = G.Test;
export type Condition = G.Condition;
export type Citation = G.Citation;
export type CoverageEntry = G.CoverageEntry;
export type Applicability = G.Applicability;
export type Selection = G.Selection;
export type Amendment = G.Amendment;
export type Adoption = G.Adoption;

export type Units = 'imperial' | 'metric';
export type Severity = 'mayNotMeet' | 'check' | 'note';
export type Op = Condition['op'];

/** 4.1: what a measure is computed on, and how a report names it. */
export type Target =
  | { kind: 'room' | 'opening' | 'element' | 'level'; id: string }
  | { kind: 'envelope'; id: string; envelope: string };
export type TargetKind = Target['kind'];

/** 4.2: the types of measures. */
export type MeasureType = 'length' | 'area' | 'count' | 'integer' | 'boolean' | 'term' | 'terms';

/** 4.7: a measure result as a report holds it. */
export interface MeasureResult {
  type: MeasureType;
  /** A JSON integer, an area's decimal string, a boolean, a term, sorted terms — or null (no value). */
  value: number | string | boolean | string[] | null;
  display: string;
  /** For a measure whose definition names what it found: those IDs, sorted. */
  involved?: string[];
}

/** 9.3: one condition of a requirement, as measured on one target. */
export interface MeasuredCondition extends MeasureResult {
  target: Target;
  measure: string;
  args?: Record<string, unknown>;
  op: Op;
  threshold: Condition['value'];
  thresholdDisplay: string;
  holds: boolean;
}

export type Ring = [number, number][];

/** 9.4: where a plan draws a finding. */
export type Shape = { kind: 'polygon'; outer: Ring; holes: Ring[] } | { kind: 'segment'; points: [[number, number], [number, number]] };

/** 9.2: one subject that may not meet one rule. */
export interface Finding {
  pack: string;
  version: string;
  rule: string;
  title: string;
  citation: Citation;
  severity: Severity;
  subject: Target;
  /** Present when the rule selects (3.5). */
  candidates?: Target[];
  measures: MeasuredCondition[];
  elements: string[];
  location: { level: string; shapes: Shape[] };
  message: string;
}

/** Chapter 11: a diagnostic about the inputs of an evaluation, never about the design. */
export interface RulesDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  packIndex?: number;
  pack?: string;
  rule?: string;
}

export type NotEvaluatedReason = 'profile' | 'invalid' | 'deferred' | 'edition' | 'withdrawn' | 'extension';

export interface EvaluatedRule {
  pack: string;
  version: string;
  rule: string;
  citation: Citation;
  subjects: number;
  exempt: number;
  findings: number;
}

export interface NotEvaluatedRule {
  pack: string;
  version: string;
  rule: string;
  reason: NotEvaluatedReason;
}

export type ReportCoverageEntry = CoverageEntry & { pack: string };

/** 9.1: what an evaluation returns. */
export interface Report {
  floorspecRules: '0.1';
  notice: string;
  /** When step 1 of 1.3 passed. */
  units?: Units;
  /** When step 2 passed: the profile's name. */
  profile?: string;
  /** When step 3 passed: the document's content hash. */
  hash?: string;
  diagnostics: RulesDiagnostic[];
  evaluated: EvaluatedRule[];
  notEvaluated: NotEvaluatedRule[];
  coverage: ReportCoverageEntry[];
  findings: Finding[];
}

/** A measure test's call (conformance/README.md): a target, a measure and its arguments. */
export interface MeasureCall {
  target: Target;
  measure: string;
  args?: Record<string, unknown>;
}
