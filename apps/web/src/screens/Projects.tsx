import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  DataList,
  DataListRow,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Modal,
  Page,
  PageHeader,
  Spinner,
  Stack,
} from '@d3cloud/ui';
import { Plus } from 'lucide-react';
import { api, messageOf } from '../lib/api';
import { navigate } from '../lib/router';

export interface ProjectRow {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  head: string | null;
}

/** Your projects. Only yours: another account's projects are not listed, or reachable. */
export function Projects() {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ projects: ProjectRow[] }>('/api/projects')
      .then((body) => { setRows(body.projects); })
      .catch((caught: unknown) => { setError(messageOf(caught)); });
  }, []);
  useEffect(load, [load]);

  const newProject = (
    <Button variant="primary" icon={<Plus />} onClick={() => { setCreating(true); }}>
      New project
    </Button>
  );

  return (
    <Page>
      <Stack gap="24">
        <PageHeader
          title="Projects"
          {...(rows === null ? {} : { count: rows.length, countNoun: { one: 'project', other: 'projects' } })}
          actions={newProject}
        />
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        {rows === null ? (
          <Spinner label="Loading projects" />
        ) : (
          <DataList
            empty={
              <EmptyState kind="empty" heading="No projects yet" action={newProject}>
                A project holds one house, described as a Floorspec document.
              </EmptyState>
            }
          >
            {rows.map((row) => (
              <DataListRow
                key={row.id}
                href={`/projects/${row.id}`}
                title={row.name}
                description={`Created ${new Date(row.createdAt).toLocaleDateString()}`}
                meta={row.head === null ? undefined : <span className="fs-mono fs-muted">{row.head.slice(0, 12)}</span>}
              />
            ))}
          </DataList>
        )}
      </Stack>
      <CreateProject open={creating} onOpenChange={setCreating} />
    </Page>
  );
}

function CreateProject({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    api
      .post<{ id: string }>('/api/projects', { name })
      .then(({ id }) => {
        onOpenChange(false);
        setName('');
        navigate(`/projects/${id}`);
      })
      .catch((caught: unknown) => { setError(messageOf(caught)); })
      .finally(() => { setBusy(false); });
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="New project" description="It starts as an empty Floorspec document.">
      <form onSubmit={submit}>
        <Stack gap="16">
          {error === null ? null : (
            <Alert tone="danger" dynamic>
              {error}
            </Alert>
          )}
          <FormField label="Name">
            <Input name="name" autoFocus required maxLength={200} value={name} onChange={(e) => { setName(e.target.value); }} />
          </FormField>
          <FormActions>
            <Button type="button" variant="secondary" onClick={() => { onOpenChange(false); }}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Create project
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Modal>
  );
}
