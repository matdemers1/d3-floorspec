import '../components/screens.css';
import './findings.css';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, EmptyState, Page, PageHeader, Skeleton, Stat, StatGroup, Table, TabPanel, Tabs, type TableColumn } from '@d3cloud/ui';
import { ExternalLink, Table as TableIcon } from 'lucide-react';
import { api, messageOf } from '../lib/api';
import { MATRIX_STATUS } from './model';
import { FindingsNotice } from './parts';
import type { MatrixRow, MatrixRule, RulePacks } from './types';

type State = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; data: RulePacks };

/**
 * `/rule-packs` — the installed rule packs and their coverage matrix (FLR-T-6.9, FLR-REQ-096; the
 * board's "12 · Rule packs — coverage matrix"): each pack's version and licence, how many of its
 * rules a professional reviewed, when each was last verified, and every section of every edition it
 * addresses — covered, partial, waiting on data, or not covered. So a reader can tell "no finding"
 * from "not checked". With no pack installed it says so, and why.
 */
export function Coverage() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const load = () => {
    setState({ status: 'loading' });
    api.get<RulePacks>('/api/rule-packs').then(
      (data) => { setState({ status: 'ready', data }); },
      (caught: unknown) => { setState({ status: 'failed', message: messageOf(caught) }); },
    );
  };
  useEffect(load, []);

  if (state.status === 'loading') {
    return (
      <Page className="fs-screen" aria-busy="true" aria-label="Loading the rule packs">
        <Skeleton variant="text" width={320} height={28} />
        <Skeleton variant="block" width="100%" height={96} />
        <Skeleton variant="block" width="100%" height={360} />
      </Page>
    );
  }
  if (state.status === 'failed') {
    return (
      <Page className="fs-screen">
        <EmptyState kind="error" heading="The rule packs did not load" action={<Button variant="secondary" onClick={load}>Try again</Button>}>
          {state.message}
        </EmptyState>
      </Page>
    );
  }
  const { data } = state;
  const m = data.matrix;
  const reviewed = m.rules.filter((r) => r.review === 'reviewed').length;
  const verified = m.rules.map((r) => r.verifiedOn).sort();
  const sections = m.rows.length;
  const covered = m.rows.filter((r) => r.status === 'covered').length;
  const partial = m.rows.filter((r) => r.status === 'partial').length;
  // One tab per pack and domain, as the matrix summarizes them.
  const tabs = m.domains.map((d) => ({ value: `${d.pack}\u0000${d.domain ?? ''}`, label: m.packs.length > 1 ? `${d.pack} · ${d.title}` : d.title, count: m.rows.filter((r) => r.pack === d.pack && r.domain === d.domain).length, domain: d }));

  return (
    <Page className="fs-screen">
      <PageHeader
        title="Rule packs"
        count={data.installed}
        countNoun={{ one: 'pack', other: 'packs' }}
        description="Versioned CC BY 4.0 data: each rule cites a code, an edition and a section, paraphrased in the contributors' own words — never the code's text."
      />
      <div className="fs-report">
        <FindingsNotice notice={data.notice} />
        {data.installed === 0 ? (
          <EmptyState kind="empty" heading="No rule pack is installed on this server">
            Every rule in a pack is verified by a person against the publisher's free viewer before the pack is published; none is installed here yet. Until one is, findings say that nothing was checked — never that anything passed. Projects are evaluated under {data.default.name} by default.
          </EmptyState>
        ) : (
          <>
            <StatGroup role="group" aria-label="The installed packs">
              {data.packs.map((p) => (
                <Stat key={p.name} label={p.name} value={p.version} footnote={`${p.title} · ${p.license}`} />
              ))}
              <Stat label="Rules encoded" value={String(m.rules.length)} footnote={`${String(covered)} of ${String(sections)} sections covered, ${String(partial)} partly`} />
              <Stat label="Professionally reviewed" value={String(reviewed)} unit={reviewed === 1 ? 'rule' : 'rules'} footnote={`of ${String(m.rules.length)}`} />
              <Stat label="Last verified" value={verified.at(-1) ?? '—'} footnote={verified.length === 0 ? 'no rule yet' : `oldest ${verified[0] ?? ''}`} />
            </StatGroup>
            {m.packs.some((p) => p.synthetic) ? (
              <p className="fs-coverage-note">
                {m.packs.filter((p) => p.synthetic).map((p) => p.name).join(', ')}: synthetic — {m.packs.find((p) => p.synthetic)?.jurisdiction ?? 'made-up codes for testing the format'}. Its findings stand for no real code.
              </p>
            ) : null}
            <Card className="fs-section-card">
              <h3>
                <TableIcon aria-hidden="true" />
                Coverage matrix
              </h3>
              {tabs.length === 0 ? (
                <p className="fs-coverage-note">The installed packs declare no coverage entries.</p>
              ) : (
                <Tabs aria-label="Domains" items={tabs.map((t) => ({ value: t.value, label: t.label, count: t.count }))} defaultValue={tabs[0]?.value ?? ''}>
                  {tabs.map((t) => (
                    <TabPanel key={t.value} value={t.value}>
                      <MatrixTable rows={m.rows.filter((r) => r.pack === t.domain.pack && r.domain === t.domain.domain)} />
                    </TabPanel>
                  ))}
                </Tabs>
              )}
              <p className="fs-coverage-note">
                Not covered means not checked: a report with no finding says nothing about a section no rule covers. A pack is never claimed to be complete or always current.
              </p>
            </Card>
            <Card className="fs-section-card">
              <h3>Rules</h3>
              <RulesTable rules={m.rules} />
              {m.packs.map((p) => (p.attribution === null ? null : <p key={p.name} className="fs-coverage-note">{p.attribution}</p>))}
            </Card>
          </>
        )}
      </div>
    </Page>
  );
}

function MatrixTable({ rows }: { rows: MatrixRow[] }) {
  const columns: TableColumn<MatrixRow>[] = [
    { key: 'section', header: 'Section', width: '7rem', cell: (r) => <span className="fs-mono">{r.section}</span> },
    { key: 'code', header: 'Code · edition', width: '9rem', cell: (r) => <span className="fs-mono">{r.code} {r.edition}</span> },
    {
      key: 'status',
      header: 'Coverage',
      width: '8rem',
      cell: (r) => (
        <Badge size="sm" tone={MATRIX_STATUS[r.status].tone}>
          {MATRIX_STATUS[r.status].label}
        </Badge>
      ),
    },
    { key: 'rules', header: 'Rules', cell: (r) => (r.rules.length === 0 ? '—' : <span className="fs-mono">{r.rules.map((x) => x.rule).join(', ')}</span>) },
    { key: 'reviewed', header: 'Reviewed', width: '6rem', cell: (r) => (r.rules.length === 0 ? '—' : `${String(r.reviewed)} of ${String(r.rules.length)}`) },
    { key: 'verified', header: 'Last verified', width: '8rem', cell: (r) => <span className="fs-mono">{r.oldestVerification ?? '—'}</span> },
    { key: 'note', header: 'In the contributors’ words', cell: (r) => [r.note ?? '', r.needs.length > 0 ? `Needs: ${r.needs.join(', ')}` : ''].filter((x) => x !== '').join(' · ') || '—' },
  ];
  return <Table caption="Coverage matrix" captionHidden density="compact" columns={columns} rows={rows} rowKey={(r) => `${r.pack}/${r.code}/${r.edition}/${r.section}`} />;
}

function RulesTable({ rules }: { rules: MatrixRule[] }) {
  const columns: TableColumn<MatrixRule>[] = [
    { key: 'rule', header: 'Rule', cell: (r) => (
      <>
        <span className="fs-mono">{r.pack}/{r.rule}</span> {r.title}
      </>
    ) },
    {
      key: 'section',
      header: 'Section',
      width: '9rem',
      cell: (r) =>
        r.link === undefined ? (
          <span className="fs-mono">{r.section}</span>
        ) : (
          <a className="fs-viewer-link" href={r.link} target="_blank" rel="noopener noreferrer">
            {r.section}
            <ExternalLink aria-hidden="true" />
            <span className="fs-visually-hidden"> (opens in a new tab)</span>
          </a>
        ),
    },
    { key: 'verifiedOn', header: 'Verified', width: '8rem', cell: (r) => <span className="fs-mono">{r.verifiedOn}</span> },
    { key: 'verifiedBy', header: 'Verified by', cell: (r) => r.verifiedBy },
    {
      key: 'review',
      header: 'Review',
      cell: (r) =>
        r.reviewed === undefined ? (
          <Badge size="sm" tone="neutral">Unreviewed</Badge>
        ) : (
          <span>
            <Badge size="sm" tone="attention">Reviewed</Badge> {r.reviewed.by}
            {r.reviewed.credential === undefined ? '' : ` (${r.reviewed.credential})`}, {r.reviewed.on}
          </span>
        ),
    },
  ];
  return <Table caption="Rules" captionHidden density="compact" columns={columns} rows={rules} rowKey={(r) => `${r.pack}/${r.rule}`} />;
}
