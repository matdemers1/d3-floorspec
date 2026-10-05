/**
 * What the API answers about findings (FLR-T-6.9), as Floorspec Rules 0.1 shapes them (chapter 9):
 * `GET /api/projects/:id/findings`, `GET /api/rule-packs`. Mirrored here rather than imported from
 * the rules engine, which the editor does not bundle: the engine runs on the server, after a commit.
 */

export type Severity = 'mayNotMeet' | 'check' | 'note';

export type Target = { kind: 'room' | 'opening' | 'element' | 'level'; id: string } | { kind: 'envelope'; id: string; envelope: string };

export interface Citation {
  code: string;
  edition: string;
  section: string;
  /** The section in the publisher's free public viewer. */
  link?: string;
}

export interface MeasuredCondition {
  target: Target;
  measure: string;
  args?: Record<string, unknown>;
  type: string;
  value: unknown;
  display: string;
  involved?: string[];
  op: string;
  threshold: unknown;
  thresholdDisplay: string;
  holds: boolean;
}

export type Shape = { kind: 'polygon'; outer: [number, number][]; holes: [number, number][][] } | { kind: 'segment'; points: [[number, number], [number, number]] };

export interface Finding {
  pack: string;
  version: string;
  rule: string;
  title: string;
  citation: Citation;
  severity: Severity;
  subject: Target;
  candidates?: Target[];
  measures: MeasuredCondition[];
  elements: string[];
  location: { level: string; shapes: Shape[] };
  /** Written from the standard's template (9.5): shown as it is, never reworded (9.9.2). */
  message: string;
}

export type NotEvaluatedReason = 'profile' | 'invalid' | 'deferred' | 'edition' | 'withdrawn' | 'extension';

export interface FindingsReport {
  head: string;
  hash: string;
  findings: Finding[];
  rulePacks: { name: string; version: string; title: string }[];
  /** With no pack installed: why there is nothing. Otherwise the notice. */
  note: string;
  /** Floorspec Rules 9.9: on every findings surface (FLR-REQ-105). */
  notice: string;
  /** The jurisdiction profile the findings were evaluated under, and its ID (null: the default). */
  profile: string;
  profileId: string | null;
  /** Where the installed packs' coverage matrix is shown (FLR-REQ-096). */
  coverageUrl: string;
  units?: 'imperial' | 'metric';
  diagnostics?: { code: string; severity: string; pack?: string; rule?: string }[];
  evaluated?: { pack: string; version: string; rule: string; citation: Citation; subjects: number; exempt: number; findings: number }[];
  notEvaluated?: { pack: string; version: string; rule: string; reason: NotEvaluatedReason }[];
  coverage?: { pack: string; code: string; edition: string; section: string; status: 'addressed' | 'partial' | 'notAddressed'; note?: string }[];
}

export type MatrixStatus = 'covered' | 'partial' | 'deferred' | 'notCovered';

export interface MatrixRule {
  pack: string;
  rule: string;
  title: string;
  section: string;
  severity: string;
  link?: string;
  verifiedBy: string;
  verifiedOn: string;
  review: 'reviewed' | 'unreviewed';
  reviewed?: { by: string; on: string; credential?: string };
  deferred: string[];
}

export interface MatrixRow {
  pack: string;
  version: string;
  code: string;
  edition: string;
  section: string;
  domain: string | null;
  declared: 'addressed' | 'partial' | 'notAddressed' | 'undeclared';
  status: MatrixStatus;
  note?: string;
  needs: string[];
  rules: MatrixRule[];
  reviewed: number;
  oldestVerification: string | null;
  newestVerification: string | null;
}

export interface CoverageMatrix {
  packs: { name: string; version: string; title: string; license: string; attribution: string | null; jurisdiction: string | null; synthetic: boolean; rules: number; reviewed: number }[];
  domains: { pack: string; domain: string | null; title: string; sections: Record<MatrixStatus, number>; rules: number; reviewed: number; oldestVerification: string | null; newestVerification: string | null }[];
  rows: MatrixRow[];
  rules: MatrixRule[];
}

export interface RulePacks {
  notice: string;
  installed: number;
  packs: { name: string; version: string; title: string; license: string; description?: string; rules: number; coverage: 'published' | 'derived' }[];
  matrix: CoverageMatrix;
  default: { name: string; source: 'standard' | 'instance' };
}
