import { type SyntheticEvent, useEffect, useState } from 'react';
import { Alert, AuthLayout, Button, Card, CodeInput, FormActions, FormField, Input, Link, PasswordInput, Stack } from '@d3cloud/ui';
import { ApiError, login } from '../lib/api';
import { takeParam } from '../lib/router';

/**
 * Two ways in, side by side. The password form is always there; Sign in with D3 Auth appears only
 * when the server says the provider is configured and was reachable — a button that leads to a 503
 * is worse than no button.
 */
export function SignIn({ oidcAvailable, onSignedIn }: { oidcAvailable: boolean; onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A refused D3 Auth sign-in comes back as a redirect carrying its reason.
  useEffect(() => {
    const reason = takeParam('d3auth_error');
    if (reason !== null) setError(reason);
  }, []);

  const submit = (event?: SyntheticEvent) => {
    event?.preventDefault();
    setError(null);
    setBusy(true);
    login(email, password, needsTotp ? totpCode : undefined)
      .then((result) => {
        if (result.status === 'totp_required') {
          setNeedsTotp(true);
          return;
        }
        onSignedIn();
      })
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 429) {
          setError('Too many attempts. Wait a moment and try again.');
          return;
        }
        setError(needsTotp ? 'That code did not match. Try the current one.' : 'Those details did not match.');
        if (needsTotp) setTotpCode('');
      })
      .finally(() => { setBusy(false); });
  };

  return (
    <AuthLayout
      title="Sign in to D3 Floorspec"
      description={needsTotp ? 'One more step: the code from your authenticator app.' : undefined}
    >
      <Card>
        <form onSubmit={submit}>
          <Stack gap="16">
            {error === null ? null : (
              <Alert tone="danger" title="Sign-in failed" dynamic>
                {error}
              </Alert>
            )}
            {needsTotp ? (
              <FormField label="Authentication code">
                <CodeInput length={6} autoFocus value={totpCode} onValueChange={setTotpCode} />
              </FormField>
            ) : (
              <>
                <FormField label="Email">
                  <Input name="email" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => { setEmail(e.target.value); }} />
                </FormField>
                <FormField label="Password">
                  <PasswordInput name="password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); }} />
                </FormField>
              </>
            )}
            <FormActions>
              <Button type="submit" variant="primary" loading={busy}>
                {needsTotp ? 'Verify' : 'Sign in'}
              </Button>
            </FormActions>
            {oidcAvailable && !needsTotp ? (
              // A link, not a button: it is a top-level navigation to the provider.
              <Link href="/auth/oidc/start" variant="standalone">
                Sign in with D3 Auth instead
              </Link>
            ) : null}
            <p className="fs-muted">New here? Accounts are created by invitation — ask the operator for a link.</p>
          </Stack>
        </form>
      </Card>
    </AuthLayout>
  );
}
