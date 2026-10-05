import './findings.css';
import type { ReactNode } from 'react';
import { Link, StatusDot } from '@d3cloud/ui';
import { ExternalLink, Info } from 'lucide-react';
import { citationText, failing, findingKey, needsText, NOTICE, severityOf } from './model';
import type { Finding, Severity } from './types';

/**
 * The pieces every findings surface shares (FLR-T-6.9): the notice, which every one of them shows
 * (Rules 9.9, FLR-REQ-105) with the link to what the installed packs check and do not (FLR-REQ-096),
 * and a finding as a card — its severity, its citation with the edition it was checked against, its
 * message exactly as written (9.9.2), what was measured against what was needed, the elements, and
 * the cited section in the publisher's free viewer.
 */

/** Where the coverage matrix lives in the app. */
export const COVERAGE_PATH = '/rule-packs';

export function FindingsNotice({
  notice = NOTICE,
  compact = false,
  children,
  coverageLink,
}: {
  notice?: string;
  compact?: boolean;
  children?: ReactNode;
  /** In place of the link to the coverage screen: a shared viewer's own, for a reader with no account (FLR-T-9.6). */
  coverageLink?: ReactNode;
}) {
  return (
    <div className={compact ? 'fs-notice fs-notice--compact' : 'fs-notice'} role="note" aria-label="About these findings" data-testid="findings-notice">
      <Info aria-hidden="true" />
      <div>
        <p className="fs-notice__text">{notice}</p>
        {children}
        <p className="fs-notice__link">
          {coverageLink ?? <Link href={COVERAGE_PATH}>What the installed rule packs check, and what they do not</Link>}
        </p>
      </div>
    </div>
  );
}

export function SeverityDot({ severity, size = 'sm' }: { severity: Severity; size?: 'sm' | 'md' }) {
  const s = severityOf(severity);
  return (
    <StatusDot tone={s.tone} size={size}>
      {s.label}
    </StatusDot>
  );
}

/** The cited section, in the publisher's free public viewer: an external link (Rules 3.2). */
export function ViewerLink({ finding }: { finding: Pick<Finding, 'citation'> }) {
  const { citation } = finding;
  if (citation.link === undefined) return null;
  return (
    <a className="fs-viewer-link" href={citation.link} target="_blank" rel="noopener noreferrer">
      Read {citation.code} {citation.edition} {citation.section} at its source
      <ExternalLink aria-hidden="true" />
      <span className="fs-visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

/** What was measured against what was needed, every condition, the ones that did not hold marked. */
export function Measures({ finding }: { finding: Finding }) {
  if (finding.measures.length === 0) {
    return <p className="fs-finding__none">{finding.candidates !== undefined && finding.candidates.length === 0 ? 'Nothing that could meet it was found.' : 'No condition was measured.'}</p>;
  }
  const bad = new Set(failing(finding));
  return (
    <table className="fs-measures">
      <caption className="fs-visually-hidden">What was measured</caption>
      <thead>
        <tr>
          <th scope="col">Measure</th>
          <th scope="col">Measured</th>
          <th scope="col">Needs</th>
        </tr>
      </thead>
      <tbody>
        {finding.measures.map((m, i) => (
          <tr key={i} className={bad.has(m) ? 'is-off' : undefined}>
            <th scope="row" className="fs-mono">
              {m.measure}
              {m.target.id === finding.subject.id ? '' : ` · ${m.target.id}`}
            </th>
            <td className="fs-mono">{m.display}</td>
            <td className="fs-mono">
              {needsText(m)}
              {bad.has(m) ? <span className="fs-visually-hidden"> — not met</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FindingCard({
  finding,
  label = (id) => id,
  onElement,
  actions,
  focused = false,
  headingLevel = 3,
  index,
}: {
  finding: Finding;
  label?: (id: string) => string;
  /** Selecting an element: on the plan, or opening the editor at it. */
  onElement?: (id: string) => void;
  actions?: ReactNode;
  focused?: boolean;
  headingLevel?: 3 | 4;
  /** The number it carries on the plan. */
  index?: number | undefined;
}) {
  const H = headingLevel === 3 ? 'h3' : 'h4';
  return (
    <article className={focused ? 'fs-finding is-focused' : 'fs-finding'} data-severity={finding.severity} data-rule={finding.rule} data-finding={findingKey(finding)} aria-label={finding.message}>
      <div className="fs-finding__head">
        {index === undefined ? null : <span className="fs-finding__index" aria-hidden="true">{index}</span>}
        <SeverityDot severity={finding.severity} />
        <span className="fs-spacer" />
        <span className="fs-mono fs-finding__cite">{citationText(finding.citation)}</span>
      </div>
      <H className="fs-finding__title">{finding.title}</H>
      <p className="fs-finding__message">{finding.message}</p>
      <Measures finding={finding} />
      {finding.elements.length > 0 ? (
        <p className="fs-finding__elements">
          <span className="fs-finding__label">Elements</span>
          {finding.elements.map((id) =>
            onElement === undefined ? (
              <span key={id} className="fs-chip-static">{label(id)}</span>
            ) : (
              <button key={id} type="button" className="fs-chip-link" onClick={() => { onElement(id); }}>
                {label(id)}
              </button>
            ),
          )}
        </p>
      ) : null}
      <p className="fs-finding__source">
        <span className="fs-mono">
          {finding.pack}/{finding.rule} · {finding.pack} {finding.version}
        </span>
        <ViewerLink finding={finding} />
      </p>
      {actions === undefined ? null : <div className="fs-finding__actions">{actions}</div>}
    </article>
  );
}
