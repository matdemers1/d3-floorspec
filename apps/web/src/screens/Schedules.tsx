import '../components/screens.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, EmptyState, Link, Page, PageHeader, Skeleton, StatusDot, Table, TabPanel, Tabs, type TableColumn } from '@d3cloud/ui';
import { ChevronRight, Download } from 'lucide-react';
import { api, ApiError, messageOf } from '../lib/api';
import { useLiveTick } from '../dashboard/live';
import { readModel, type EditorModel } from '../editor/model';
import { unitsOf } from '../editor/units';
import { schedules, toCsv, type Schedule, type ScheduleRow } from '../schedules/derive';
import type { ProjectDetail } from './Project';

type State =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; project: ProjectDetail; model: EditorModel | null };

/**
 * `/projects/:id/schedules` — the schedules (FLR-T-5.8, FLR-REQ-091; the board's "24 · Schedules"):
 * rooms, doors, windows, receptacles and fixtures as tables derived live from main by the engine.
 * The page follows the project's event stream, so an edit anywhere — the editor, another tab, an
 * accepted changeset — redraws them; each sorts by any column and exports as CSV in the browser.
 */
export function Schedules({ id }: { id: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [tab, setTab] = useState<Schedule['id']>(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    return wanted === 'doors' || wanted === 'windows' || wanted === 'receptacles' || wanted === 'fixtures' || wanted === 'stairs' ? wanted : 'rooms';
  });
  const tick = useLiveTick(id);

  const load = useCallback(
    (quiet: boolean) => {
      if (!quiet) setState({ status: 'loading' });
      api
        .get<ProjectDetail>(`/api/projects/${id}`)
        .then(async (project) => {
          if (project.head === null) return { project, model: null };
          const res = await fetch(`/api/projects/${id}/model.json`, { credentials: 'same-origin' });
          if (!res.ok) throw new ApiError(res.status, 'the model did not load');
          return { project, model: readModel(project.head.version, await res.text()) };
        })
        .then(({ project, model }) => { setState({ status: 'ready', project, model }); })
        .catch((caught: unknown) => {
          if (caught instanceof ApiError && caught.status === 404) setState({ status: 'missing' });
          else setState({ status: 'failed', message: messageOf(caught) });
        });
    },
    [id],
  );
  // Load now, and again — without a flash — whenever something moves on the server.
  useEffect(() => { load(tick > 0); }, [load, tick]);

  const model = state.status === 'ready' ? state.model : null;
  const units = unitsOf(model?.document);
  const tables = useMemo(() => (model === null || !model.valid ? [] : schedules(model, units)), [model, units]);
  const current = tables.find((t) => t.id === tab);

  if (state.status === 'missing') {
    return (
      <Page className="fs-screen">
        <EmptyState kind="no-results" heading="That project does not exist" action={<Link href="/">All projects</Link>}>
          It may have been deleted, or it is not yours.
        </EmptyState>
      </Page>
    );
  }
  if (state.status === 'failed') {
    return (
      <Page className="fs-screen">
        <EmptyState kind="error" heading="The schedules did not load" action={<Button variant="secondary" onClick={() => { load(false); }}>Try again</Button>}>
          {state.message}
        </EmptyState>
      </Page>
    );
  }
  if (state.status === 'loading') {
    return (
      <Page className="fs-screen" aria-busy="true" aria-label="Loading the schedules">
        <Skeleton variant="text" width={200} />
        <Skeleton variant="text" width={320} height={28} />
        <Skeleton variant="block" width="100%" height={360} />
      </Page>
    );
  }

  const { project } = state;
  const exportCsv = () => {
    if (current === undefined) return;
    const blob = new Blob([toCsv(current)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name.replace(/[^\w.-]+/g, '-')}-${current.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Page className="fs-screen">
      <nav aria-label="Breadcrumb">
        <ol className="fs-breadcrumb">
          <li>
            <Link href="/" variant="muted">Projects</Link>
          </li>
          <li aria-hidden="true"><ChevronRight /></li>
          <li>
            <Link href={`/projects/${project.id}`} variant="muted">{project.name}</Link>
          </li>
          <li aria-hidden="true"><ChevronRight /></li>
          <li aria-current="page">Schedules</li>
        </ol>
      </nav>
      <PageHeader
        title="Schedules"
        count={tables.length}
        countNoun={{ one: 'schedule', other: 'schedules' }}
        description="Live tables straight from the model — they change the moment the plan does."
        actions={
          <Button variant="primary" icon={<Download />} disabled={current === undefined || current.rows.length === 0} onClick={exportCsv}>
            Export CSV
          </Button>
        }
      />
      {model === null ? (
        <EmptyState kind="empty" heading="This project has no model yet" action={<Link href={`/projects/${project.id}/editor`}>Open the editor</Link>}>
          Schedules are derived from the plan: draw one first.
        </EmptyState>
      ) : !model.valid ? (
        <EmptyState kind="error" heading="This version of the model does not validate" action={<Link href={`/projects/${project.id}/editor`}>Open the editor</Link>}>
          Schedules are derived from a valid plan. Undo the change that broke it, or fix it in the editor.
        </EmptyState>
      ) : (
        <div className="fs-schedules">
          <div className="fs-schedules__bar">
            <Tabs
              aria-label="Schedules"
              items={tables.map((t) => ({ value: t.id, label: t.label, count: t.rows.length }))}
              value={tab}
              onValueChange={(v) => {
                setTab(v as Schedule['id']);
                const url = new URL(window.location.href);
                url.searchParams.set('tab', v);
                window.history.replaceState({}, '', url);
              }}
            >
              {tables.map((t) => (
                <TabPanel key={t.id} value={t.id}>
                  <ScheduleTable schedule={t} />
                  <p className="fs-schedules__foot">
                    {t.rows.length === 0 ? `No ${t.label.toLowerCase()} in the plan yet` : `${String(t.rows.length)} ${t.rows.length === 1 ? 'row' : 'rows'}`} · {t.footnote}
                  </p>
                </TabPanel>
              ))}
            </Tabs>
            <span className="fs-schedules__live">
              <StatusDot tone="attention" size="sm">Live · v{String(project.ops)}</StatusDot>
            </span>
          </div>
        </div>
      )}
    </Page>
  );
}

function ScheduleTable({ schedule }: { schedule: Schedule }) {
  const columns: TableColumn<ScheduleRow>[] = schedule.columns.map((c) => ({
    key: c.key,
    header: c.header,
    ...(c.numeric === true ? { numeric: true } : {}),
    cell: (row) => row.cells[c.key]?.text ?? '—',
    sortable: (a, b) => {
      const x = a.cells[c.key]?.value ?? '';
      const y = b.cells[c.key]?.value ?? '';
      return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true });
    },
  }));
  return (
    <Table
      caption={`${schedule.label} schedule`}
      captionHidden
      columns={columns}
      rows={schedule.rows}
      rowKey={(r) => r.key}
      density="compact"
      empty={<EmptyState kind="empty" size="inline" heading={`No ${schedule.label.toLowerCase()} yet`}>They appear here as they are added to the plan.</EmptyState>}
    />
  );
}
