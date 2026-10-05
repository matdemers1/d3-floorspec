import './findings.css';
import { Badge, Button, EmptyState, Skeleton } from '@d3cloud/ui';
import { ClipboardList, Map as MapIcon, TriangleAlert } from 'lucide-react';
import { DashCard } from '../dashboard/DashCard';
import { navigate } from '../lib/router';
import { citationText, counts, findingKey, SEVERITIES, stateOf } from './model';
import { FindingsNotice, SeverityDot } from './parts';
import { useFindings } from './source';
import type { Severity } from './types';

/**
 * The dashboard's Findings card (FLR-T-6.9): the real state of main's findings under the project's
 * profile — counts by severity and the first few, each with its citation — or, honestly, that no
 * pack is installed or no rule is in force. The notice and the coverage link are on it, as on every
 * findings surface (FLR-REQ-105). Live: an edit or a change of profile updates it.
 */
export function FindingsCard({ projectId }: { projectId: string }) {
  const [state] = useFindings(projectId);
  const report = state.report;
  const open = () => { navigate(`/projects/${projectId}/findings`); };
  const c = report === null ? null : counts(report.findings);
  const aside =
    report === null || c === null ? null : (
      <Badge size="sm" tone="neutral">
        {report.profile}
      </Badge>
    );
  return (
    <DashCard region="findings" icon={<TriangleAlert aria-hidden="true" />} title="Findings" aside={aside}>
      {report === null ? (
        state.status === 'failed' ? (
          <EmptyState kind="error" size="row" heading="The findings did not load">
            {state.error ?? ''}
          </EmptyState>
        ) : (
          <Skeleton variant="block" width="100%" height={96} />
        )
      ) : (
        <>
          {body()}
          <FindingsNotice notice={report.notice} compact />
          <div className="fs-findings-card__actions">
            <Button size="sm" variant="secondary" icon={<ClipboardList />} onClick={open}>
              Open the report
            </Button>
            {report.findings.length > 0 ? (
              <Button size="sm" variant="ghost" icon={<MapIcon />} onClick={() => { navigate(`/projects/${projectId}/editor?findings=open`); }}>
                Show on the plan
              </Button>
            ) : null}
          </div>
        </>
      )}
    </DashCard>
  );

  function body() {
    if (report === null || c === null) return null;
    const s = stateOf(report);
    if (s === 'none-installed') {
      return (
        <EmptyState kind="empty" size="row" heading="No rule pack is installed">
          Nothing was checked. Findings appear here once a verified pack is installed, each with its code citation; they advise and never block a change.
        </EmptyState>
      );
    }
    if (s === 'none-evaluated') {
      return (
        <EmptyState kind="empty" size="row" heading={`No installed rule is in force under ${report.profile}`}>
          Nothing was checked: choose a jurisdiction profile that adopts the installed packs’ editions.
        </EmptyState>
      );
    }
    if (s === 'no-findings') {
      const n = report.evaluated?.length ?? 0;
      return (
        <EmptyState kind="empty" size="row" heading={`No findings from ${String(n)} ${n === 1 ? 'rule' : 'rules'}`}>
          The rules evaluated found nothing to flag. Sections no rule covers were not checked.
        </EmptyState>
      );
    }
    return (
      <>
        <p className="fs-findings-card__summary" aria-label="Findings by severity">
          {SEVERITIES.filter((x) => c[x.id] > 0).map((x) => (
            <span key={x.id}>
              <SeverityDot severity={x.id} /> {c[x.id]}
            </span>
          ))}
        </p>
        <ul className="fs-findings-card__list">
          {[...report.findings].sort((a, b) => rank(a.severity) - rank(b.severity)).slice(0, 3).map((f) => (
            <li key={findingKey(f)}>
              <span>{f.title}</span>
              <span className="fs-mono fs-findings-card__cite">
                {f.subject.id} · {citationText(f.citation)}
              </span>
            </li>
          ))}
        </ul>
        {report.findings.length > 3 ? <p className="fs-coverage-note">and {report.findings.length - 3} more</p> : null}
      </>
    );
  }
}

const rank = (s: Severity) => SEVERITIES.findIndex((x) => x.id === s);

/** The dashboard's "Findings" stat: the count, or a dash with why. */
export function useFindingsStat(projectId: string): { value: string; footnote: string } {
  const [state] = useFindings(projectId);
  const report = state.report;
  if (report === null) return { value: '—', footnote: 'Loading' };
  const s = stateOf(report);
  if (s === 'none-installed') return { value: '—', footnote: 'No rule pack installed' };
  if (s === 'none-evaluated') return { value: '—', footnote: `No rule in force under ${report.profile}` };
  const c = counts(report.findings);
  return { value: String(c.total), footnote: c.total === 0 ? `None from ${String(report.evaluated?.length ?? 0)} rules` : `${String(c.mayNotMeet)} may not meet · ${report.profile}` };
}
