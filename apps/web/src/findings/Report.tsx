import '../components/screens.css';
import './findings.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, EmptyState, Link, Page, PageHeader, SegmentedControl, Select, Skeleton, Stat, StatGroup, useToast } from '@d3cloud/ui';
import { ChevronRight, Download, Map as MapIcon, Printer } from 'lucide-react';
import { api, ApiError, messageOf } from '../lib/api';
import { navigate } from '../lib/router';
import { readModel, type EditorModel } from '../editor/model';
import type { ProjectDetail } from '../screens/Project';
import { chooseProfile, listProfiles, type Profiles } from '../profiles/api';
import { ALL, codesIn, counts, DECLARED, filterFindings, findingKey, findingsCsv, groupFindings, notEvaluatedByReason, SEVERITIES, stateOf, type Filter, type GroupBy } from './model';
import { COVERAGE_PATH, FindingCard, FindingsNotice } from './parts';
import { labelIn, roomOfFinding } from './rooms';
import { useFindings } from './source';
import type { FindingsReport } from './types';

type Loaded = { status: 'loading' } | { status: 'missing' } | { status: 'failed'; message: string } | { status: 'ready'; project: ProjectDetail; model: EditorModel | null };

const DEFAULT = '__default';

/**
 * `/projects/:id/findings` — the findings report (FLR-T-6.9; the board's "11 · Findings"): every
 * advisory finding of main under the project's jurisdiction profile, by severity, by room or by
 * code, filtered; each with its citation and edition, what was measured against what was needed,
 * its elements (opening the plan at them), and the cited section in the publisher's viewer. The
 * notice and the coverage link head the page (FLR-REQ-105, 096), and every state — no pack, no rule
 * in force, no finding — says honestly what was and was not checked. Exports as CSV and prints.
 */
export function FindingsReportScreen({ id }: { id: string }) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [findings, source] = useFindings(id);
  const [profiles, setProfiles] = useState<Profiles | null>(null);
  const [by, setBy] = useState<GroupBy>('severity');
  const [filter, setFilter] = useState<Filter>(ALL);
  const [choosing, setChoosing] = useState(false);

  const load = useCallback(() => {
    api
      .get<ProjectDetail>(`/api/projects/${id}`)
      .then(async (project) => {
        if (project.head === null) return { project, model: null };
        const res = await fetch(`/api/projects/${id}/model.json`, { credentials: 'same-origin' });
        if (!res.ok) throw new ApiError(res.status, 'the model did not load');
        return { project, model: readModel(project.head.version, await res.text()) };
      })
      .then(({ project, model }) => { setLoaded({ status: 'ready', project, model }); })
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 404) setLoaded({ status: 'missing' });
        else setLoaded({ status: 'failed', message: messageOf(caught) });
      });
    listProfiles().then(setProfiles, () => { setProfiles(null); });
  }, [id]);
  useEffect(load, [load]);

  // The model follows the findings: a new head, a new picture of the rooms the findings are in.
  const hash = findings.report?.hash;
  useEffect(() => {
    if (loaded.status !== 'ready' || hash === undefined || loaded.model?.hash === hash) return;
    fetch(`/api/projects/${id}/versions/${hash}`, { credentials: 'same-origin' })
      .then(async (res) => (res.ok ? readModel(hash, await res.text()) : null))
      .then((model) => { if (model !== null) setLoaded({ ...loaded, model }); })
      .catch(() => undefined);
  }, [hash, id, loaded]);

  if (loaded.status === 'missing') {
    return (
      <Page className="fs-screen">
        <EmptyState kind="no-results" heading="That project does not exist" action={<Link href="/">All projects</Link>}>
          It may have been deleted, or it is not yours.
        </EmptyState>
      </Page>
    );
  }
  if (loaded.status === 'failed' || (findings.status === 'failed' && findings.report === null)) {
    return (
      <Page className="fs-screen">
        <EmptyState kind="error" heading="The findings did not load" action={<Button variant="secondary" onClick={() => { load(); source.load(); }}>Try again</Button>}>
          {loaded.status === 'failed' ? loaded.message : (findings.error ?? '')}
        </EmptyState>
      </Page>
    );
  }
  if (loaded.status === 'loading' || findings.report === null) {
    return (
      <Page className="fs-screen" aria-busy="true" aria-label="Loading the findings">
        <Skeleton variant="text" width={200} />
        <Skeleton variant="text" width={320} height={28} />
        <Skeleton variant="block" width="100%" height={88} />
        <Skeleton variant="block" width="100%" height={360} />
      </Page>
    );
  }

  const { project, model } = loaded;
  const report = findings.report;

  const choose = (value: string) => {
    setChoosing(true);
    chooseProfile(id, value === DEFAULT ? null : value)
      .then((chosen) => {
        toast.show({ message: `Findings are now evaluated under ${chosen.profile.name}.` });
        source.load();
        listProfiles().then(setProfiles, () => undefined);
      })
      .catch((caught: unknown) => { toast.show({ message: `The profile was not changed: ${messageOf(caught)}` }); })
      .finally(() => { setChoosing(false); });
  };

  return (
    <Page className="fs-screen">
      <nav aria-label="Breadcrumb" className="fs-no-print">
        <ol className="fs-breadcrumb">
          <li>
            <Link href="/" variant="muted">Projects</Link>
          </li>
          <li aria-hidden="true"><ChevronRight /></li>
          <li>
            <Link href={`/projects/${project.id}`} variant="muted">{project.name}</Link>
          </li>
          <li aria-hidden="true"><ChevronRight /></li>
          <li aria-current="page">Findings</li>
        </ol>
      </nav>
      <PageHeader
        title="Findings"
        count={report.findings.length}
        countNoun={{ one: 'finding', other: 'findings' }}
        description={`Advisory code findings for ${project.name}, version ${String(project.ops)}, evaluated under ${report.profile}.`}
        actions={
          <>
            <Button className="fs-no-print" variant="secondary" icon={<Printer />} onClick={() => { window.print(); }}>
              Print
            </Button>
            <Button className="fs-no-print" variant="secondary" icon={<Download />} onClick={() => { downloadCsv(report, project.name, labelIn(model)); }}>
              Export CSV
            </Button>
            <Button className="fs-no-print" variant="primary" icon={<MapIcon />} onClick={() => { navigate(`/projects/${project.id}/editor?findings=open`); }}>
              Show on the plan
            </Button>
          </>
        }
      />
      <div className="fs-report">
        <FindingsNotice notice={report.notice} />
        <div className="fs-report__bar">
          <div className="fs-report__profile fs-report__filter--wide">
            <span className="fs-caption" id="fs-profile-label">Jurisdiction profile</span>
            <Select
              aria-label="Jurisdiction profile"
              disabled={choosing || profiles === null}
              value={report.profileId ?? DEFAULT}
              options={[
                { value: DEFAULT, label: `${profiles?.default.profile.name ?? report.profile} (default)` },
                ...(profiles?.profiles ?? []).map((p) => ({ value: p.id, label: p.profile.name })),
              ]}
              onValueChange={choose}
            />
          </div>
          <Link href={`/jurisdictions?project=${project.id}`}>Build or edit profiles</Link>
          <span className="fs-spacer" />
          {report.findings.length > 0 ? (
            <>
              <SegmentedControl
                aria-label="Group by"
                value={by}
                onValueChange={(v) => { setBy(v as GroupBy); }}
                items={[
                  { value: 'severity', label: 'Severity' },
                  { value: 'room', label: 'Room' },
                  { value: 'code', label: 'Code' },
                ]}
              />
              <div className="fs-report__filter">
              <Select
                aria-label="Severity"
                value={filter.severity}
                onValueChange={(v) => { setFilter({ ...filter, severity: v as Filter['severity'] }); }}
                options={[{ value: 'all', label: 'Every severity' }, ...SEVERITIES.map((s) => ({ value: s.id, label: s.label }))]}
              />
              </div>
              <div className="fs-report__filter">
              <Select
                aria-label="Code"
                value={filter.code}
                onValueChange={(v) => { setFilter({ ...filter, code: v }); }}
                options={[{ value: 'all', label: 'Every code' }, ...codesIn(report.findings).map((c) => ({ value: c, label: c }))]}
              />
              </div>
            </>
          ) : null}
        </div>
        <div className="fs-report__columns">
          <div className="fs-report">
            <Body report={report} model={model} projectId={project.id} by={by} filter={filter} onClear={() => { setFilter(ALL); }} />
          </div>
          <Aside report={report} />
        </div>
      </div>
    </Page>
  );
}

function Body({ report, model, projectId, by, filter, onClear }: { report: FindingsReport; model: EditorModel | null; projectId: string; by: GroupBy; filter: Filter; onClear: () => void }) {
  const label = useMemo(() => labelIn(model), [model]);
  const state = stateOf(report);
  if (state === 'none-installed') {
    return (
      <EmptyState kind="empty" heading="No rule pack is installed" action={<Link href={COVERAGE_PATH}>About rule packs</Link>}>
        {report.note} Nothing here means the design meets or misses any code.
      </EmptyState>
    );
  }
  if (state === 'none-evaluated') {
    return (
      <EmptyState kind="empty" heading={`No installed rule is in force under ${report.profile}`} action={<Link href={`/jurisdictions?project=${projectId}`}>Choose or build a profile</Link>}>
        The installed packs cite editions this profile does not adopt, so nothing was checked. A profile that adopts their editions puts their rules in force.
      </EmptyState>
    );
  }
  if (state === 'no-findings') {
    const n = report.evaluated?.length ?? 0;
    return (
      <EmptyState kind="empty" heading={`No findings from the ${String(n)} ${n === 1 ? 'rule' : 'rules'} evaluated`} action={<Link href={COVERAGE_PATH}>What the packs check</Link>}>
        These rules found nothing to flag. Sections they do not cover were not checked, and the authority having jurisdiction decides.
      </EmptyState>
    );
  }
  const shown = filterFindings(report.findings, filter);
  if (shown.length === 0) {
    return (
      <EmptyState kind="no-results" heading="No finding matches these filters" action={<Button variant="secondary" size="sm" onClick={onClear}>Clear the filters</Button>}>
        {String(report.findings.length)} {report.findings.length === 1 ? 'finding is' : 'findings are'} hidden by the severity or code chosen.
      </EmptyState>
    );
  }
  const index = new Map(report.findings.map((f, i) => [findingKey(f), i + 1]));
  const open = (key: string) => { navigate(`/projects/${projectId}/editor?finding=${encodeURIComponent(key)}`); };
  return (
    <>
      {groupFindings(shown, by, (f) => roomOfFinding(model, f)).map((g) => (
        <section key={g.key} className="fs-report__group" aria-label={g.title}>
          <h2>
            {g.title} · {g.findings.length}
          </h2>
          <ul className="fs-report__list">
            {g.findings.map((f) => {
              const key = findingKey(f);
              return (
                <li key={key}>
                  <FindingCard
                    finding={f}
                    label={label}
                    index={index.get(key)}
                    onElement={() => { open(key); }}
                    actions={
                      <Button size="sm" variant="secondary" icon={<MapIcon />} className="fs-no-print" onClick={() => { open(key); }}>
                        Show on the plan
                      </Button>
                    }
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

/** What was evaluated, what was not and why, and the coverage that applies (Rules 9.1). */
function Aside({ report }: { report: FindingsReport }) {
  const c = counts(report.findings);
  if (report.rulePacks.length === 0) return null;
  const notEvaluated = notEvaluatedByReason(report);
  return (
    <aside className="fs-report__side" aria-label="What was checked">
      <StatGroup role="group" aria-label="Findings by severity">
        <Stat label="May not meet" value={String(c.mayNotMeet)} />
        <Stat label="Check" value={String(c.check)} />
        <Stat label="Notes" value={String(c.note)} />
      </StatGroup>
      <Card className="fs-section-card">
        <h2>Checked</h2>
        <p className="fs-coverage-note">
          {String(report.evaluated?.length ?? 0)} {report.evaluated?.length === 1 ? 'rule' : 'rules'} evaluated from {report.rulePacks.map((p) => `${p.name} ${p.version}`).join(', ')}, under {report.profile}.
        </p>
        {notEvaluated.length === 0 ? null : (
          <>
            <h2>Not evaluated</h2>
            {notEvaluated.map((g) => (
              <div key={g.reason}>
                <p className="fs-coverage-note">{g.label}:</p>
                <ul>
                  {g.rules.map((r) => (
                    <li key={`${r.pack}/${r.rule}`} className="fs-mono">
                      {r.pack}/{r.rule}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
        {(report.coverage ?? []).length === 0 ? null : (
          <>
            <h2>Coverage of the editions in force</h2>
            <ul>
              {(report.coverage ?? []).map((e, i) => (
                <li key={i}>
                  <span className="fs-mono">
                    {e.code} {e.edition} {e.section}
                  </span>{' '}
                  — {DECLARED[e.status]}
                  {e.note === undefined ? '' : `: ${e.note}`}
                </li>
              ))}
            </ul>
          </>
        )}
        <Link href={COVERAGE_PATH}>The full coverage matrix</Link>
      </Card>
    </aside>
  );
}

function downloadCsv(report: FindingsReport, name: string, label: (id: string) => string) {
  const blob = new Blob([findingsCsv(report, label)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^\w.-]+/g, '-')}-findings.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
