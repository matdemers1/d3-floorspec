import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  CodeInput,
  FormActions,
  FormField,
  Link,
  Page,
  PageHeader,
  Section,
  SettingsRow,
  Stack,
  useToast,
} from '@d3cloud/ui';
import { api, messageOf, type SignedIn } from '../lib/api';
import { takeParam } from '../lib/router';
import { TotpQr } from '../components/TotpQr';

/** The signed-in account's settings: two-factor, and the D3 Auth link. */
export function Account({ session, onChanged }: { session: SignedIn; onChanged: () => void }) {
  const toast = useToast();
  const [d3authError, setD3authError] = useState<string | null>(null);

  useEffect(() => {
    if (takeParam('d3auth') === 'linked') toast.show({ message: 'D3 Auth is linked to this account.' });
    setD3authError(takeParam('d3auth_error'));
  }, [toast]);

  return (
    <Page width="form">
      <Stack gap="24">
        <PageHeader title="Account" description={`${session.account.displayName} · ${session.account.email}`} />
        <TwoFactor session={session} onChanged={onChanged} />
        <Section title="Sign in with D3 Auth" description="Use your D3 Auth account to sign in here. It never creates an account — it links to this one.">
          <Stack gap="16">
            {d3authError === null ? null : (
              <Alert tone="danger" title="D3 Auth was not linked" dynamic>
                {d3authError}
              </Alert>
            )}
            <D3AuthLink session={session} onChanged={onChanged} />
          </Stack>
        </Section>
      </Stack>
    </Page>
  );
}

function TwoFactor({ session, onChanged }: { session: SignedIn; onChanged: () => void }) {
  const toast = useToast();
  const [enrolment, setEnrolment] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (work: Promise<unknown>, done: () => void) => {
    setError(null);
    setBusy(true);
    work
      .then(done)
      .catch((caught: unknown) => {
        setError(messageOf(caught));
        setCode('');
      })
      .finally(() => { setBusy(false); });
  };

  if (!session.hasPassword) {
    return (
      <Section title="Two-factor authentication">
        <p className="fs-muted">This account signs in with D3 Auth only; two-factor is managed there.</p>
      </Section>
    );
  }

  return (
    <Section title="Two-factor authentication" description="A code from an authenticator app, asked for after your password.">
      <Stack gap="16">
        {error === null ? null : (
          <Alert tone="danger" dynamic>
            {error}
          </Alert>
        )}
        {session.totpEnrolled ? (
          <>
            <SettingsRow title="Authenticator app" description="On. Enter a current code to turn it off." control={<Badge tone="attention">On</Badge>} />
            <FormField label="Current code">
              <CodeInput length={6} value={code} onValueChange={setCode} />
            </FormField>
            <FormActions align="start">
              <Button
                variant="danger"
                loading={busy}
                disabled={code.length !== 6}
                onClick={() => {
                  run(api.post('/auth/totp/disable', { code }), () => {
                    setCode('');
                    toast.show({ message: 'Two-factor authentication is off.' });
                    onChanged();
                  });
                }}
              >
                Turn off two-factor
              </Button>
            </FormActions>
          </>
        ) : enrolment === null ? (
          <SettingsRow
            title="Authenticator app"
            description="Off."
            control={
              <Button
                loading={busy}
                onClick={() => {
                  run(api.post<{ secret: string; uri: string }>('/auth/totp/enrol').then(setEnrolment), () => undefined);
                }}
              >
                Turn on
              </Button>
            }
          />
        ) : (
          <>
            <p>Scan this with your authenticator app, or type the key, then enter the code it shows.</p>
            <TotpQr uri={enrolment.uri} />
            <p className="fs-mono">{enrolment.secret}</p>
            <FormField label="Code from the app">
              <CodeInput length={6} autoFocus value={code} onValueChange={setCode} />
            </FormField>
            <FormActions align="start">
              <Button
                variant="primary"
                loading={busy}
                disabled={code.length !== 6}
                onClick={() => {
                  run(api.post('/auth/totp/confirm', { code }), () => {
                    setEnrolment(null);
                    setCode('');
                    toast.show({ message: 'Two-factor authentication is on.' });
                    onChanged();
                  });
                }}
              >
                Confirm and turn on
              </Button>
            </FormActions>
          </>
        )}
      </Stack>
    </Section>
  );
}

function D3AuthLink({ session, onChanged }: { session: SignedIn; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.d3auth !== null) {
    return (
      <Stack gap="12">
        <SettingsRow
          title="Linked"
          description={session.d3auth.email ?? session.d3auth.iss}
          control={
            <Button
              variant="secondary"
              loading={busy}
              disabled={!session.hasPassword}
              onClick={() => {
                setBusy(true);
                api
                  .del('/api/account/d3auth')
                  .then(() => {
                    toast.show({ message: 'D3 Auth is unlinked.' });
                    onChanged();
                  })
                  .catch((caught: unknown) => { setError(messageOf(caught)); })
                  .finally(() => { setBusy(false); });
              }}
            >
              Unlink
            </Button>
          }
        />
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
      </Stack>
    );
  }

  if (!session.oidcAvailable) {
    return <p className="fs-muted">Sign in with D3 Auth is not configured on this server.</p>;
  }

  return (
    <SettingsRow
      title="Not linked"
      description="You will be sent to D3 Auth and back."
      control={
        <Link href="/auth/oidc/start?link=1" variant="standalone">
          Link D3 Auth
        </Link>
      }
    />
  );
}
