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
  Page,
  PageHeader,
  Section,
  Spinner,
  Stack,
  useToast,
} from '@d3cloud/ui';
import { api, messageOf } from '../lib/api';

interface InviteRow {
  id: string;
  email: string | null;
  createdAt: string;
  expiresAt: string;
  state: 'open' | 'accepted' | 'revoked' | 'expired';
  acceptedAccount: { email: string; displayName: string } | null;
}

interface Created {
  id: string;
  url: string;
  email: string | null;
  expiresAt: string;
}

const date = (iso: string) => new Date(iso).toLocaleString();

/** The operator's invites: the only way anybody else gets an account. */
export function Invites() {
  const toast = useToast();
  const [rows, setRows] = useState<InviteRow[] | null>(null);
  const [email, setEmail] = useState('');
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ invites: InviteRow[] }>('/api/invites')
      .then((body) => { setRows(body.invites); })
      .catch((caught: unknown) => { setError(messageOf(caught)); });
  }, []);
  useEffect(load, [load]);

  const create = (event: SyntheticEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    api
      .post<Created>('/api/invites', email.trim() === '' ? {} : { email })
      .then((invite) => {
        setCreated(invite);
        setEmail('');
        load();
      })
      .catch((caught: unknown) => { setError(messageOf(caught)); })
      .finally(() => { setBusy(false); });
  };

  const revoke = (id: string) => {
    api
      .del(`/api/invites/${id}`)
      .then(() => {
        toast.show({ message: 'Invite revoked.' });
        load();
      })
      .catch((caught: unknown) => { setError(messageOf(caught)); });
  };

  return (
    <Page>
      <Stack gap="24">
        <PageHeader title="Invites" description="A single-use link that creates one account. There is no sign-up page." />
        <Section title="New invite">
          <form onSubmit={create}>
            <Stack gap="16">
              {error === null ? null : (
                <Alert tone="danger" dynamic>
                  {error}
                </Alert>
              )}
              <FormField label="Email" optional help="When set, the account must use this address.">
                <Input type="email" value={email} onChange={(e) => { setEmail(e.target.value); }} />
              </FormField>
              <FormActions align="start">
                <Button type="submit" variant="primary" loading={busy}>
                  Create invite link
                </Button>
              </FormActions>
              {created === null ? null : (
                <Alert
                  tone="success"
                  title="Send this link — it is shown once"
                  dynamic
                  actions={
                    <Button
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard.writeText(created.url).then(() => toast.show({ message: 'Link copied.' }));
                      }}
                    >
                      Copy
                    </Button>
                  }
                >
                  <span className="fs-mono">{created.url}</span>
                  <br />
                  Usable once, until {date(created.expiresAt)}.
                </Alert>
              )}
            </Stack>
          </form>
        </Section>
        <Section title="Sent">
          {rows === null ? (
            <Spinner label="Loading invites" />
          ) : (
            <DataList empty={<EmptyState kind="empty" size="inline" heading="No invites yet" />}>
              {rows.map((row) => (
                <DataListRow
                  key={row.id}
                  title={row.email ?? 'Any address'}
                  description={
                    row.state === 'accepted' && row.acceptedAccount !== null
                      ? `Accepted by ${row.acceptedAccount.displayName}`
                      : `Created ${date(row.createdAt)} · expires ${date(row.expiresAt)}`
                  }
                  meta={<Badge tone={row.state === 'open' ? 'attention' : 'neutral'}>{row.state}</Badge>}
                  actions={
                    row.state === 'open' ? (
                      <Button size="sm" variant="danger-ghost" onClick={() => { revoke(row.id); }}>
                        Revoke
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </DataList>
          )}
        </Section>
      </Stack>
    </Page>
  );
}
