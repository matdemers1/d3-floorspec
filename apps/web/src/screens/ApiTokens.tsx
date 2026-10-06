import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  DataList,
  DataListRow,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Section,
  Select,
  Spinner,
  Stack,
  TabPanel,
  Tabs,
  useToast,
} from '@d3cloud/ui';
import { api, messageOf } from '../lib/api';

type Kind = 'read' | 'write' | 'agent';

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  kind: Kind;
  /** Null: every project the account owns. */
  project: { id: string; name: string } | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  state: 'active' | 'revoked' | 'expired';
}

interface Mcp {
  url: string;
  /** The D3 Auth client Claude's connector signs in as; null when D3 Auth is not configured. */
  connector: { issuer: string; clientId: string } | null;
}

interface Created {
  id: string;
  name: string;
  token: string;
  project: { name: string } | null;
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

/** The project picker's value for a token that reaches every project. */
const ALL = 'all';

const date = (iso: string) => new Date(iso).toLocaleDateString();

/**
 * Connecting Claude (FLR-T-2.5, FLR-T-2.11): the values the Claude app's custom connector asks for,
 * the Claude Code command, and the API tokens behind it. A token reaches every project by default,
 * so one connection serves every house; a per-project token is still there for anything narrower.
 */
export function ApiTokens({ d3authLinked }: { d3authLinked: boolean }) {
  const toast = useToast();
  const [rows, setRows] = useState<TokenRow[] | null>(null);
  const [mcp, setMcp] = useState<Mcp | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState(ALL);
  const [name, setName] = useState('Claude');
  const [kind, setKind] = useState<Kind>('agent');
  const [expiry, setExpiry] = useState('never');
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const copy = (value: string, what: string) => {
    void navigator.clipboard.writeText(value).then(() => toast.show({ message: `${what} copied.` }));
  };

  const load = useCallback(() => {
    Promise.all([api.get<{ tokens: TokenRow[]; mcp: Mcp }>('/api/tokens'), api.get<{ projects: { id: string; name: string }[] }>('/api/projects')])
      .then(([tokens, list]) => {
        setRows(tokens.tokens);
        setMcp(tokens.mcp);
        setProjects(list.projects);
      })
      .catch((caught: unknown) => { setError(messageOf(caught)); });
  }, []);
  useEffect(load, [load]);

  // A project that has since gone falls back to every project.
  const reach = projectId === ALL || projects.some((p) => p.id === projectId) ? projectId : ALL;

  const create = (event: SyntheticEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    api
      .post<Created>('/api/tokens', {
        projectId: reach === ALL ? null : reach,
        name,
        kind,
        ...(expiry === 'never' ? {} : { expiresInDays: Number(expiry) }),
      })
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

  const mcpUrl = mcp?.url ?? `${window.location.origin}/mcp`;
  const command = `claude mcp add --transport http floorspec ${mcpUrl} --header "Authorization: Bearer ${created?.token ?? 'fls_…'}"`;

  return (
    <>
      <Section
        title="Connect Claude"
        description="One connection reaches every project you own. Claude asks which house you mean, or you name it. Its edits arrive as changesets you accept or reject."
      >
        <Tabs aria-label="Where you use Claude" items={[{ value: 'app', label: 'Claude app' }, { value: 'code', label: 'Claude Code' }]} defaultValue="app">
          <TabPanel value="app">
            {mcp === null ? (
              <Spinner label="Loading connection details" />
            ) : mcp.connector === null ? (
              <Alert tone="info" title="The Claude app needs D3 Auth">
                The Claude app (claude.ai, desktop and mobile) signs in through D3 Auth, and this server has no D3 Auth configured. Use Claude Code with an API token instead.
              </Alert>
            ) : (
              <Stack gap="16">
                <p>
                  In Claude, open <strong>Settings › Connectors › Add custom connector</strong> and fill it in with these. The client ID is under <strong>Advanced settings</strong>.
                </p>
                <DescriptionList>
                  <DescriptionItem term="Name">D3 Floorspec</DescriptionItem>
                  <DescriptionItem term="Remote MCP server URL">
                    <CopyValue value={mcp.url} onCopy={() => { copy(mcp.url, 'Server URL'); }} />
                  </DescriptionItem>
                  <DescriptionItem term="OAuth Client ID">
                    <CopyValue value={mcp.connector.clientId} onCopy={() => { copy(mcp.connector?.clientId ?? '', 'Client ID'); }} />
                  </DescriptionItem>
                  <DescriptionItem term="OAuth Client Secret">Leave it empty. The connector is a public client and has no secret.</DescriptionItem>
                </DescriptionList>
                <p className="fs-muted">
                  Then choose <strong>Connect</strong> and sign in with D3 Auth. No API token is needed: the connector reaches every project of the D3 Floorspec account your D3 Auth account is linked to.
                </p>
                {d3authLinked ? null : (
                  <Alert tone="warning" title="Link D3 Auth first">
                    This account is not linked to D3 Auth, so the connector would sign in and then be refused. Link it under Sign in with D3 Auth above.
                  </Alert>
                )}
              </Stack>
            )}
          </TabPanel>
          <TabPanel value="code">
            <Stack gap="12">
              <p>
                {created === null
                  ? 'Create a token below — it reaches every project by default — then run this once with fls_… replaced by the token.'
                  : `Run this once. It carries the token you just made, which reaches ${created.project?.name ?? 'all your projects'}.`}
              </p>
              <pre className="fs-command fs-mono">{command}</pre>
              <FormActions align="start">
                <Button size="sm" onClick={() => { copy(command, 'Command'); }}>
                  Copy command
                </Button>
              </FormActions>
            </Stack>
          </TabPanel>
        </Tabs>
      </Section>

      <Section title="API tokens" description="For Claude Code and other programs. Each token is shown once, when you create it.">
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
                <Button size="sm" onClick={() => { copy(created.token, 'Token'); }}>
                  Copy
                </Button>
              }
            >
              <span className="fs-mono">{created.token}</span>
              <br />
              {created.name} · {created.project?.name ?? 'all your projects'}. Only its hash is kept: lose it and you make a new one.
            </Alert>
          )}
          <form onSubmit={create}>
            <Stack gap="16">
              <FormField label="Name" help="What uses it, so you know what to revoke.">
                <Input value={name} maxLength={80} required onChange={(e) => { setName(e.target.value); }} />
              </FormField>
              <FormField
                label="Projects"
                help={reach === ALL ? 'Every project you own, including ones you create later.' : 'This project only. Every other project answers as if it did not exist.'}
              >
                <Select
                  options={[{ value: ALL, label: 'All my projects' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
                  value={reach}
                  onValueChange={setProjectId}
                />
              </FormField>
              <FormField label="Access" help={KINDS.find((k) => k.value === kind)?.help}>
                <Select options={KINDS.map(({ value, label }) => ({ value, label }))} value={kind} onValueChange={(value) => { setKind(value as Kind); }} />
              </FormField>
              <FormField label="Expires">
                <Select options={EXPIRY} value={expiry} onValueChange={setExpiry} />
              </FormField>
              <FormActions align="start">
                <Button type="submit" variant="primary" loading={busy} disabled={name.trim() === ''}>
                  Create token
                </Button>
              </FormActions>
            </Stack>
          </form>
          {rows === null ? (
            <Spinner label="Loading tokens" />
          ) : (
            <DataList empty={<EmptyState kind="empty" size="inline" heading="No tokens yet" />}>
              {rows.map((row) => (
                <DataListRow
                  key={row.id}
                  title={row.name}
                  description={`${row.project?.name ?? 'All projects'} · ${row.kind} · created ${date(row.createdAt)}${row.lastUsedAt === null ? ' · never used' : ` · last used ${date(row.lastUsedAt)}`}${row.expiresAt === null ? '' : ` · expires ${date(row.expiresAt)}`}`}
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
    </>
  );
}

/** A value to paste somewhere else, with its copy button beside it. */
function CopyValue({ value, onCopy }: { value: string; onCopy: () => void }) {
  return (
    <span className="fs-copy-value">
      <span className="fs-mono">{value}</span>
      <Button size="sm" variant="secondary" onClick={onCopy} aria-label={`Copy ${value}`}>
        Copy
      </Button>
    </span>
  );
}
