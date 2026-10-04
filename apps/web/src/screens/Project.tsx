import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  DataList,
  DataListRow,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  Link,
  Modal,
  Page,
  PageHeader,
  Section,
  Spinner,
  Stack,
  useToast,
} from '@d3cloud/ui';
import { Download } from 'lucide-react';
import { api, ApiError, messageOf } from '../lib/api';
import { navigate } from '../lib/router';

interface ProjectDetail {
  id: string;
  name: string;
  createdAt: string;
  head: { name: string; version: string; updatedAt: string } | null;
  ops: number;
}

interface OpRow {
  seq: number;
  authorKind: 'account' | 'agent';
  ops: { op: string }[];
  afterHash: string;
  createdAt: string;
}

/** One project: its current version, its history, and the model as a file. */
export function Project({ id }: { id: string }) {
  const toast = useToast();
  const [project, setProject] = useState<ProjectDetail | null | 'missing'>(null);
  const [ops, setOps] = useState<OpRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    Promise.all([api.get<ProjectDetail>(`/api/projects/${id}`), api.get<{ ops: OpRow[] }>(`/api/projects/${id}/ops`)])
      .then(([detail, log]) => {
        setProject(detail);
        setOps(log.ops);
      })
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 404) setProject('missing');
        else setError(messageOf(caught));
      });
  }, [id]);

  if (project === 'missing') {
    return (
      <Page>
        <EmptyState kind="no-results" heading="That project does not exist" action={<Link href="/">All projects</Link>}>
          It may have been deleted, or it is not yours.
        </EmptyState>
      </Page>
    );
  }
  if (project === null) return error === null ? <Spinner label="Loading the project" /> : <Alert tone="danger">{error}</Alert>;

  return (
    <Page>
      <Stack gap="24">
        <PageHeader
          title={project.name}
          back={<Link href="/" variant="muted">Projects</Link>}
          actions={
            // A navigation, not a fetch: the API answers with Content-Disposition: attachment, so the
            // browser saves the file under the name the API gives it and the page stays put.
            <Button variant="primary" icon={<Download />} onClick={() => { window.location.assign(`/api/projects/${id}/model.json`); }}>
              Download model.json
            </Button>
          }
        />
        <Section title="Model">
          <DescriptionList>
            <DescriptionItem term="Version">
              <span className="fs-mono">{project.head?.version ?? '—'}</span>
            </DescriptionItem>
            <DescriptionItem term="Head">{project.head?.name ?? '—'}</DescriptionItem>
            <DescriptionItem term="Created">{new Date(project.createdAt).toLocaleString()}</DescriptionItem>
          </DescriptionList>
        </Section>
        <Section title="History" description="Every change is a Floorspec Op, recorded in order and never rewritten.">
          <DataList>
            {ops.map((op) => (
              <DataListRow
                key={op.seq}
                title={`#${String(op.seq)} ${op.ops.map((o) => o.op).join(', ')}`}
                description={`${op.authorKind === 'agent' ? 'An agent' : 'You'} · ${new Date(op.createdAt).toLocaleString()}`}
                meta={<span className="fs-mono fs-muted">{op.afterHash.slice(0, 12)}</span>}
              />
            ))}
          </DataList>
        </Section>
        <Section title="Delete this project">
          <Stack gap="12" align="start">
            <p className="fs-muted">It disappears from your projects. Its history is kept, append-only.</p>
            <Button variant="danger" onClick={() => { setConfirmDelete(true); }}>
              Delete project
            </Button>
          </Stack>
        </Section>
      </Stack>
      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
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
                  .del(`/api/projects/${id}`)
                  .then(() => {
                    toast.show({ message: `${project.name} was deleted.` });
                    navigate('/', { replace: true });
                  })
                  .catch((caught: unknown) => { setError(messageOf(caught)); });
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        It will no longer be listed or reachable.
      </Modal>
    </Page>
  );
}
