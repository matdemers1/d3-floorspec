import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  DataList,
  DataListRow,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Section,
  Select,
  Spinner,
  Stack,
  useToast,
} from '@d3cloud/ui';
import { api, messageOf } from '../lib/api';

type Kind = 'read' | 'write' | 'agent';

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  kind: Kind;
  project: { id: string; name: string };
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  state: 'active' | 'revoked' | 'expired';
}

interface Created {
  id: string;
  name: string;
  token: string;
  project: { name: string };
}

const KINDS: { value: Kind; label: string; help: string }[] = [
  { value: 'agent', label: 'Agent — proposes changesets', help: 'For Claude: its edits land in a named changeset you accept or reject on the project page, never on the plan itself.' },
  { value: 'write', label: 'Write — commits as you', help: 'Edits go straight onto the plan, recorded as yours. Can also accept or reject changesets.' },
  { value: 'read', label: 'Read only', help: 'Describe, query, validate, render and export. No edits.' },
];

const EXPIRY = [
  { value: 'never', label: 'Never — until revoked' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

const date = (iso: string) => new Date(iso).toLocaleDateString();

/**
 * API tokens for the MCP server and the API (FLR-T-2.5): one project each, the secret shown once.
 * The MCP endpoint is `<this site>/mcp`; the Claude Code plugin takes the token as FLOORSPEC_TOKEN.
 */
export function ApiTokens() {
  const toast = useToast();
  const [rows, setRows] = useState<TokenRow[] | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('Claude');
  const [kind, setKind] = useState<Kind>('agent');
  const [expiry, setExpiry] = useState('never');
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.get<{ tokens: TokenRow[] }>('/api/tokens'), api.get<{ projects: { id: string; name: string }[] }>('/api/projects')])
      .then(([tokens, list]) => {
        setRows(tokens.tokens);
        setProjects(list.projects);
      })
      .catch((caught: unknown) => { setError(messageOf(caught)); });
  }, []);
  useEffect(load, [load]);

  // The chosen project, or the first one until a person picks.
  const project = projects.some((p) => p.id === projectId) ? projectId : (projects[0]?.id ?? '');

  const create = (event: SyntheticEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    api
      .post<Created>('/api/tokens', { projectId: project, name, kind, ...(expiry === 'never' ? {} : { expiresInDays: Number(expiry) }) })
      .then((token) => {
        setCreated(token);
        load();
      })
      .catch((caught: unknown) => { setError(messageOf(caught)); })
      .finally(() => { setBusy(false); });
  };

  const revoke = (row: TokenRow) => {
    api
      .del(`/api/tokens/${row.id}`)
      .then(() => {
        toast.show({ message: `${row.name} is revoked. Anything using it stops working now.` });
        if (created?.id === row.id) setCreated(null);
        load();
      })
      .catch((caught: unknown) => { setError(messageOf(caught)); });
  };

  return (
    <Section
      title="API tokens"
      description={`For Claude and other programs: the MCP server is at ${window.location.origin}/mcp. A token reaches one project.`}
    >
      <Stack gap="16">
        {error === null ? null : (
          <Alert tone="danger" dynamic>
            {error}
          </Alert>
        )}
        {created === null ? null : (
          <Alert
            tone="success"
            title="Copy this token now — it is shown once"
            dynamic
            actions={
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(created.token).then(() => toast.show({ message: 'Token copied.' }));
                }}
              >
                Copy
              </Button>
            }
          >
            <span className="fs-mono">{created.token}</span>
            <br />
            {created.name} · {created.project.name}. Only its hash is kept: lose it and you make a new one.
          </Alert>
        )}
        {projects.length === 0 && rows !== null ? (
          <p className="fs-muted">Create a project first: a token belongs to one project.</p>
        ) : (
          <form onSubmit={create}>
            <Stack gap="16">
              <FormField label="Project">
                <Select options={projects.map((p) => ({ value: p.id, label: p.name }))} value={project} onValueChange={setProjectId} />
              </FormField>
              <FormField label="Name" help="What uses it, so you know what to revoke.">
                <Input value={name} maxLength={80} required onChange={(e) => { setName(e.target.value); }} />
              </FormField>
              <FormField label="Access" help={KINDS.find((k) => k.value === kind)?.help}>
                <Select options={KINDS.map(({ value, label }) => ({ value, label }))} value={kind} onValueChange={(value) => { setKind(value as Kind); }} />
              </FormField>
              <FormField label="Expires">
                <Select options={EXPIRY} value={expiry} onValueChange={setExpiry} />
              </FormField>
              <FormActions align="start">
                <Button type="submit" variant="primary" loading={busy} disabled={project === '' || name.trim() === ''}>
                  Create token
                </Button>
              </FormActions>
            </Stack>
          </form>
        )}
        {rows === null ? (
          <Spinner label="Loading tokens" />
        ) : (
          <DataList empty={<EmptyState kind="empty" size="inline" heading="No tokens yet" />}>
            {rows.map((row) => (
              <DataListRow
                key={row.id}
                title={row.name}
                description={`${row.project.name} · ${row.kind} · created ${date(row.createdAt)}${row.lastUsedAt === null ? ' · never used' : ` · last used ${date(row.lastUsedAt)}`}${row.expiresAt === null ? '' : ` · expires ${date(row.expiresAt)}`}`}
                meta={
                  <>
                    <span className="fs-mono fs-muted">{row.prefix}…</span> <Badge tone={row.state === 'active' ? 'attention' : 'neutral'}>{row.state}</Badge>
                  </>
                }
                actions={
                  row.state === 'active' ? (
                    <Button size="sm" variant="secondary" onClick={() => { revoke(row); }}>
                      Revoke
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </DataList>
        )}
      </Stack>
    </Section>
  );
}
