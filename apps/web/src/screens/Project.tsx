import '../components/screens.css';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  EmptyState,
  IconButton,
  Link,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Modal,
  Page,
  PageHeader,
  Skeleton,
  Stat,
  StatGroup,
  useToast,
} from '@d3cloud/ui';
import { ChevronRight, Ellipsis, Pencil, Table as TableIcon } from 'lucide-react';
import { ChangesetsSlot } from '../dashboard/ChangesetsSlot';
import { PlanCard } from '../dashboard/PlanCard';
import { BriefCard, ExportsCard, OptionsCard, ShareCard } from '../dashboard/Sections';
import { FindingsCard, useFindingsStat } from '../findings/DashboardCard';
import { VersionsSlot } from '../dashboard/VersionsSlot';
import { api, ApiError, messageOf } from '../lib/api';
import { navigate } from '../lib/router';
import { formatSquareFeet, loadModel, plural, type ModelSummary } from '../projects/model';

export interface ProjectDetail {
  id: string;
  name: string;
  createdAt: string;
  updatedAt?: string;
  head: { name: string; version: string; updatedAt: string } | null;
  ops: number;
}

type State =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; project: ProjectDetail; model: ModelSummary | null | 'failed' };

/**
 * One project's dashboard (screen 04): the plan of its head model and what the engine derived from
 * it, with the sections later phases fill — brief (P4), findings (P6), options (P8), share and the
 * other exports (P9) — and the two regions the lead wires now: changesets and versions.
 */
export function Project({ id, you }: { id: string; you: string }) {
  const toast = useToast();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ status: 'loading' });
    api
      .get<ProjectDetail>(`/api/projects/${id}`)
      .then(async (project) => {
        const model = await loadModel(project.id, project.head?.version ?? null).catch(() => 'failed' as const);
        setState({ status: 'ready', project, model });
      })
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 404) setState({ status: 'missing' });
        else setState({ status: 'failed', message: messageOf(caught) });
      });
  }, [id]);
  useEffect(load, [load]);

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
        <EmptyState
          kind="error"
          heading="This project did not load"
          action={
            <Button variant="secondary" onClick={load}>
              Try again
            </Button>
          }
        >
          {state.message}
        </EmptyState>
      </Page>
    );
  }
  if (state.status === 'loading') return <Loading />;

  const { project } = state;
  const model = state.model === 'failed' ? null : state.model;
  const editor = `/projects/${project.id}/editor`;
  const describe = [
    model?.document?.project.description,
    model?.document === undefined || model.document === null ? null : `Floorspec ${model.document.floorspec} Draft`,
    `created ${new Date(project.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`,
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' · ');

  return (
    <Page className="fs-screen">
      <Breadcrumb name={project.name} />
      <PageHeader
        title={project.name}
        count={project.ops}
        countNoun={{ one: 'version', other: 'versions' }}
        description={describe}
        actions={
          <>
            <Menu>
              <MenuTrigger>
                <IconButton variant="ghost" icon={<Ellipsis />} label="More actions" />
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem
                  disabled={project.head === null}
                  onSelect={() => { window.location.assign(`/api/projects/${project.id}/model.json`); }}
                >
                  Download model.json
                </MenuItem>
                <MenuSeparator />
                <MenuItem tone="danger" onSelect={() => { setConfirmDelete(true); }}>
                  Delete project…
                </MenuItem>
              </MenuContent>
            </Menu>
            <Button variant="secondary" icon={<TableIcon />} disabled={project.head === null} onClick={() => { navigate(`/projects/${project.id}/schedules`); }}>
              Schedules
            </Button>
            <Button variant="primary" icon={<Pencil />} onClick={() => { navigate(editor); }}>
              Open editor
            </Button>
          </>
        }
      />

      {state.model === 'failed' ? (
        <Alert tone="warning" title="The model did not load">
          The project is here, but its head version could not be read. Reload to try again.
        </Alert>
      ) : null}

      <div className="fs-dashboard-wrap">
        <div className="fs-dashboard">
          <div className="fs-dashboard__col fs-dashboard__col--main">
            <PlanCard projectId={project.id} name={project.name} summary={model} />
            <BriefCard projectId={project.id} document={model?.document ?? null} derived={model?.derived ?? null} />
            <OptionsCard />
          </div>
          <div className="fs-dashboard__col">
            {/* StatGroup renders a plain div, where aria-label is prohibited: role="group" gives the label
                an element it may name (an upstream @d3cloud/ui issue). */}
            <StatGroup role="group" aria-label="At a glance" className="fs-dashboard__stats">
              <Stat
                label="Net room area"
                value={model === null || !model.valid ? '—' : formatSquareFeet(model.area2)}
                {...(model === null || !model.valid ? {} : { unit: 'ft²' })}
                footnote={model === null || !model.valid ? 'No rooms derived' : `${plural(model.rooms, 'room')}, derived exactly`}
              />
              <FindingsStat projectId={project.id} />
            </StatGroup>
            <ChangesetsSlot projectId={project.id} onDecided={load} />
            <FindingsCard projectId={project.id} />
            <VersionsSlot projectId={project.id} you={you} />
            <ExportsCard projectId={project.id} hasModel={project.head !== null} />
            <ShareCard />
          </div>
        </div>
      </div>

      <Modal
        open={confirmDelete}
        onOpenChange={(open) => {
          setConfirmDelete(open);
          if (!open) setDeleteError(null);
        }}
        destructive
        title={`Delete ${project.name}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => { setConfirmDelete(false); }}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                api
                  .del(`/api/projects/${project.id}`)
                  .then(() => {
                    toast.show({ message: `${project.name} was deleted.` });
                    navigate('/', { replace: true });
                  })
                  .catch((caught: unknown) => { setDeleteError(messageOf(caught)); });
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        {deleteError === null ? null : (
          <Alert tone="danger" dynamic>
            {deleteError}
          </Alert>
        )}
        It disappears from your projects and can no longer be opened. Its history is kept, append-only.
      </Modal>
    </Page>
  );
}

/** Findings (FLR-T-6.9): the real count under the project's profile, or why there is none. */
function FindingsStat({ projectId }: { projectId: string }) {
  const { value, footnote } = useFindingsStat(projectId);
  return <Stat label="Findings" value={value} footnote={footnote} />;
}

function Breadcrumb({ name }: { name: string }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="fs-breadcrumb">
        <li>
          <Link href="/" variant="muted">
            Projects
          </Link>
        </li>
        <li aria-hidden="true">
          <ChevronRight />
        </li>
        <li aria-current="page">{name}</li>
      </ol>
    </nav>
  );
}

function Loading() {
  return (
    <Page className="fs-screen" aria-busy="true" aria-label="Loading the project">
      <Skeleton variant="text" width={160} />
      <Skeleton variant="text" width={320} height={28} />
      <div className="fs-dashboard-wrap">
        <div className="fs-dashboard">
          <div className="fs-dashboard__col fs-dashboard__col--main">
            <Skeleton variant="block" width="100%" height={532} />
            <Skeleton variant="block" width="100%" height={180} />
          </div>
          <div className="fs-dashboard__col">
            <Skeleton variant="block" width="100%" height={106} />
            <Skeleton variant="block" width="100%" height={208} />
            <Skeleton variant="block" width="100%" height={204} />
          </div>
        </div>
      </div>
    </Page>
  );
}
