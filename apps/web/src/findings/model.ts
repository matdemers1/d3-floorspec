import type { Finding, FindingsReport, MatrixStatus, MeasuredCondition, NotEvaluatedReason, Severity } from './types';

/**
 * The findings report as a person reads it (FLR-T-6.9): grouped by severity, by room or by code,
 * filtered, counted and exported. Nothing here rewords a finding — its message is the standard's
 * template (Rules 9.5) and is shown as it is (9.9.2) — and nothing here says that anything passes.
 */

/** Rules 9.9, exactly: what every findings surface says (FLR-REQ-105). The server sends it too. */
export const NOTICE = 'Floorspec findings are advisory. They are not a plan review, and the authority having jurisdiction decides.';

export const SEVERITIES: readonly { id: Severity; label: string; plural: string; tone: 'danger' | 'warning' | 'neutral' }[] = [
  { id: 'mayNotMeet', label: 'May not meet', plural: 'May not meet', tone: 'danger' },
  { id: 'check', label: 'Check', plural: 'Check', tone: 'warning' },
  { id: 'note', label: 'Note', plural: 'Notes', tone: 'neutral' },
];

export const severityOf = (id: Severity) => SEVERITIES.find((s) => s.id === id) ?? { id, label: id, plural: id, tone: 'neutral' as const };

/** One finding per subject per rule (Rules 3.6): pack, rule and subject name it. */
export function findingKey(f: Pick<Finding, 'pack' | 'rule' | 'subject'>): string {
  const s = f.subject;
  return `${f.pack}/${f.rule}/${s.kind}:${s.id}${s.kind === 'envelope' ? `#${s.envelope}` : ''}`;
}

/** `NEC 2026 · 110.26(A)`: a citation, with the edition it was checked against. */
export const citationText = (c: { code: string; edition: string; section: string }) => `${c.code} ${c.edition} · ${c.section}`;

const OPS: Record<string, string> = { '>=': '≥', '<=': '≤', '>': '>', '<': '<', '=': '=', '!=': '≠', in: 'one of', has: 'includes' };
export const opText = (op: string) => OPS[op] ?? op;

/** What a measured condition needed: `≥ 100.00 sq ft`. */
export const needsText = (m: Pick<MeasuredCondition, 'op' | 'thresholdDisplay'>) => `${opText(m.op)} ${m.thresholdDisplay}`;

/** The measured conditions that did not hold — the reason for the finding. */
export const failing = (f: Finding): MeasuredCondition[] => f.measures.filter((m) => !m.holds);

/** A short line for a label on the plan: `85.00 sq ft — needs ≥ 100.00 sq ft`, or the rule's title. */
export function shortReason(f: Finding): string {
  const m = failing(f)[0];
  if (m === undefined) return f.candidates !== undefined && f.candidates.length === 0 ? `none found — ${f.title}` : f.title;
  return `${m.display} — needs ${needsText(m)}`;
}

export function counts(findings: readonly Finding[]): Record<Severity, number> & { total: number } {
  const out = { mayNotMeet: 0, check: 0, note: 0, total: findings.length };
  for (const f of findings) out[f.severity] += 1;
  return out;
}

export type GroupBy = 'severity' | 'room' | 'code';

export interface Group {
  key: string;
  title: string;
  findings: Finding[];
}

export interface Filter {
  severity: Severity | 'all';
  /** A code and edition (`TEST-CODE 2024`), or 'all'. */
  code: string;
}

export const ALL: Filter = { severity: 'all', code: 'all' };

export const codeOf = (f: Finding) => `${f.citation.code} ${f.citation.edition}`;

export function filterFindings(findings: readonly Finding[], filter: Filter): Finding[] {
  return findings.filter((f) => (filter.severity === 'all' || f.severity === filter.severity) && (filter.code === 'all' || codeOf(f) === filter.code));
}

/** The codes (with editions) the findings cite, for a filter. */
export const codesIn = (findings: readonly Finding[]) => [...new Set(findings.map(codeOf))].sort();

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Findings in groups. By severity: may not meet, then check, then notes. By room: each room by its
 * label, the findings about no room last. By code: by code and edition. Within a group, the
 * report's own order (Rules 9.7) is kept.
 */
export function groupFindings(findings: readonly Finding[], by: GroupBy, room: (f: Finding) => { id: string; label: string } | null): Group[] {
  if (by === 'severity') {
    return SEVERITIES.map((s) => ({ key: s.id, title: s.plural, findings: findings.filter((f) => f.severity === s.id) })).filter((g) => g.findings.length > 0);
  }
  const groups = new Map<string, Group>();
  const order: string[] = [];
  for (const f of findings) {
    let key: string;
    let title: string;
    if (by === 'code') {
      key = codeOf(f);
      title = key;
    } else {
      const r = room(f);
      key = r === null ? '￿' : `room:${r.id}`;
      title = r === null ? 'Not in a room' : r.label;
    }
    let g = groups.get(key);
    if (g === undefined) {
      g = { key, title, findings: [] };
      groups.set(key, g);
      order.push(key);
    }
    g.findings.push(f);
  }
  const list = order.map((k) => groups.get(k) as Group);
  return list.sort((a, b) => (a.key === '￿' ? 1 : b.key === '￿' ? -1 : cmp(a.title, b.title) || cmp(a.key, b.key)));
}

/** Why a rule was not evaluated (Rules 9.1), in words. */
export const REASONS: Record<NotEvaluatedReason, string> = {
  edition: 'Written for an edition this profile does not put in force',
  withdrawn: 'Withdrawn by a local amendment in this profile',
  profile: 'Its pack is not selected by this profile',
  deferred: 'Uses a measure the model cannot give yet',
  extension: 'Reads an extension this server does not evaluate',
  invalid: 'Not well formed, so not evaluated',
};

/** Not-evaluated rules, by reason, most informative first. */
export function notEvaluatedByReason(report: Pick<FindingsReport, 'notEvaluated'>): { reason: NotEvaluatedReason; label: string; rules: { pack: string; rule: string }[] }[] {
  const order: NotEvaluatedReason[] = ['edition', 'withdrawn', 'profile', 'deferred', 'extension', 'invalid'];
  return order
    .map((reason) => ({ reason, label: REASONS[reason], rules: (report.notEvaluated ?? []).filter((r) => r.reason === reason).map((r) => ({ pack: r.pack, rule: r.rule })) }))
    .filter((g) => g.rules.length > 0);
}

/**
 * What the report as a whole says, honestly:
 *   - `none-installed`: no pack, so nothing was checked;
 *   - `none-evaluated`: packs, but no rule is in force under this profile — nothing was checked;
 *   - `no-findings`: rules were evaluated and none gave a finding (not a statement that anything passes);
 *   - `findings`.
 */
export type ReportState = 'none-installed' | 'none-evaluated' | 'no-findings' | 'findings';

export function stateOf(report: FindingsReport): ReportState {
  if (report.rulePacks.length === 0) return 'none-installed';
  if ((report.evaluated ?? []).length === 0) return 'none-evaluated';
  return report.findings.length === 0 ? 'no-findings' : 'findings';
}

/** Coverage statuses as the matrix shows them. */
export const MATRIX_STATUS: Record<MatrixStatus, { label: string; tone: 'neutral' | 'attention' | 'warning' | 'danger' }> = {
  covered: { label: 'Covered', tone: 'attention' },
  partial: { label: 'Partial', tone: 'warning' },
  deferred: { label: 'Needs data', tone: 'neutral' },
  notCovered: { label: 'Not covered', tone: 'danger' },
};

/** The declared status of a coverage entry that applies to a report (Rules 2.4). */
export const DECLARED: Record<'addressed' | 'partial' | 'notAddressed', string> = { addressed: 'Addressed', partial: 'Partial', notAddressed: 'Not addressed' };

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The report as CSV (an export that shows findings: FLR-REQ-105). It opens with the notice, the
 * profile and where the coverage is, then one row per finding with its message as written.
 */
export function findingsCsv(report: FindingsReport, label: (id: string) => string = (id) => id): string {
  const rows: string[][] = [
    ['Notice', report.notice],
    ['Profile', report.profile],
    ['Rule packs', report.rulePacks.map((p) => `${p.name} ${p.version}`).join('; ') || 'none installed'],
    ['Coverage', report.coverageUrl],
    [],
    ['Severity', 'Message', 'Code', 'Edition', 'Section', 'Pack', 'Pack version', 'Rule', 'Subject', 'Elements', 'Measured', 'Needs', 'Section viewer'],
  ];
  for (const f of report.findings) {
    const m = failing(f);
    rows.push([
      severityOf(f.severity).label,
      f.message,
      f.citation.code,
      f.citation.edition,
      f.citation.section,
      f.pack,
      f.version,
      f.rule,
      label(f.subject.id),
      f.elements.map(label).join(' '),
      m.map((x) => `${x.measure}: ${x.display}`).join('; '),
      m.map((x) => needsText(x)).join('; '),
      f.citation.link ?? '',
    ]);
  }
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
