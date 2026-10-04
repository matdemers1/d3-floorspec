import { type SyntheticEvent, useEffect, useState } from 'react';
import { Alert, AuthLayout, Button, Card, EmptyState, FormActions, FormField, Input, PasswordInput, Spinner, Stack } from '@d3cloud/ui';
import { api, messageOf } from '../lib/api';

interface InvitePeek {
  email: string | null;
  expiresAt: string;
}

/** Spend an invite link: choose a name and password, and you are signed in. */
export function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
  const [invite, setInvite] = useState<InvitePeek | null | 'loading'>('loading');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<InvitePeek>(`/auth/invites/${encodeURIComponent(token)}`)
      .then((peek) => {
        setInvite(peek);
        if (peek.email !== null) setEmail(peek.email);
      })
      .catch(() => { setInvite(null); });
  }, [token]);

  if (invite === 'loading') return <Spinner label="Checking the invite" />;
  if (invite === null) {
    return (
      <AuthLayout title="This invite cannot be used">
        <EmptyState kind="error" heading="The link is used, revoked or expired">
          Ask the operator for a new one.
        </EmptyState>
      </AuthLayout>
    );
  }

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    api
      .post(`/auth/invites/${encodeURIComponent(token)}/accept`, { email, displayName, password })
      .then(() => {
        window.history.replaceState({}, '', '/');
        onDone();
      })
      .catch((caught: unknown) => { setError(messageOf(caught)); })
      .finally(() => { setBusy(false); });
  };

  return (
    <AuthLayout title="Join D3 Floorspec" description="You were invited. Choose how you will sign in.">
      <Card>
        <form onSubmit={submit}>
          <Stack gap="16">
            {error === null ? null : (
              <Alert tone="danger" title="Could not create the account" dynamic>
                {error}
              </Alert>
            )}
            <FormField label="Email" help={invite.email === null ? undefined : 'This invite is for this address.'}>
              <Input name="email" type="email" autoComplete="username" required readOnly={invite.email !== null} value={email} onChange={(e) => { setEmail(e.target.value); }} />
            </FormField>
            <FormField label="Your name">
              <Input name="name" autoComplete="name" required value={displayName} onChange={(e) => { setDisplayName(e.target.value); }} />
            </FormField>
            <FormField label="Password" help="At least 12 characters.">
              <PasswordInput name="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => { setPassword(e.target.value); }} />
            </FormField>
            <FormActions>
              <Button type="submit" variant="primary" loading={busy}>
                Create my account
              </Button>
            </FormActions>
          </Stack>
        </form>
      </Card>
    </AuthLayout>
  );
}
