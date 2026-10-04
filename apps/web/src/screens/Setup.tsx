import { type SyntheticEvent, useState } from 'react';
import { Alert, AuthLayout, Button, Card, FormActions, FormField, Input, PasswordInput, Stack } from '@d3cloud/ui';
import { api, messageOf } from '../lib/api';

/**
 * First-run setup: the operator's account. Shown only while the server reports that no account
 * exists; once one does, the server's setup route is a 404 and this screen is never reached.
 */
export function Setup({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setError(null);
    setBusy(true);
    api
      .post('/auth/setup', { email, displayName, password })
      .then(onDone)
      .catch((caught: unknown) => { setError(messageOf(caught)); })
      .finally(() => { setBusy(false); });
  };

  return (
    <AuthLayout
      title="Set up D3 Floorspec"
      description="Create the operator account. Everybody else joins by an invite you send."
    >
      <Card>
        <form onSubmit={submit}>
          <Stack gap="16">
            {error === null ? null : (
              <Alert tone="danger" title="Setup failed" dynamic>
                {error}
              </Alert>
            )}
            <FormField label="Your name">
              <Input name="name" autoComplete="name" autoFocus required value={displayName} onChange={(e) => { setDisplayName(e.target.value); }} />
            </FormField>
            <FormField label="Email">
              <Input name="email" type="email" autoComplete="username" required value={email} onChange={(e) => { setEmail(e.target.value); }} />
            </FormField>
            <FormField label="Password" help="At least 12 characters.">
              <PasswordInput name="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => { setPassword(e.target.value); }} />
            </FormField>
            <FormField label="Password again">
              <PasswordInput name="confirm" autoComplete="new-password" required value={confirm} onChange={(e) => { setConfirm(e.target.value); }} />
            </FormField>
            <FormActions>
              <Button type="submit" variant="primary" loading={busy}>
                Create the operator account
              </Button>
            </FormActions>
          </Stack>
        </form>
      </Card>
    </AuthLayout>
  );
}
