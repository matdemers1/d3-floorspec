import { useCallback, useEffect, useState } from 'react';
import {
  AccountMenu,
  AppShell,
  AppShellBrand,
  EmptyState,
  MenuItem,
  MenuSeparator,
  SideNav,
  SideNavItem,
  Spinner,
  ThemeProvider,
  ThemeSwitch,
  ToastRegion,
} from '@d3cloud/ui';
import { FolderOpen, MailPlus, UserRound } from 'lucide-react';
import { fetchSession, logout, type Anonymous, type SignedIn } from './lib/api';
import { navigate, useLocation } from './lib/router';
import { AcceptInvite } from './screens/AcceptInvite';
import { Account } from './screens/Account';
import { Project } from './screens/Project';
import { Projects } from './screens/Projects';
import { Invites } from './screens/Invites';
import { EditorPlaceholder } from './projects/EditorPlaceholder';
import { Setup } from './screens/Setup';
import { SignIn } from './screens/SignIn';

/**
 * The editor shell. One question decides what renders — is there a session? — and the answer comes
 * from the server, never from anything held in the browser.
 */

type State =
  | { status: 'loading' }
  | { status: 'anonymous'; session: Anonymous }
  | { status: 'signed-in'; session: SignedIn }
  | { status: 'unreachable' };

export function App() {
  return (
    <ThemeProvider storageKey="floorspec.theme">
      <ToastRegion>
        <Root />
      </ToastRegion>
    </ThemeProvider>
  );
}

function Root() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const { path } = useLocation();

  const load = useCallback(() => {
    fetchSession()
      .then((session) => {
        setState(session.authenticated ? { status: 'signed-in', session } : { status: 'anonymous', session });
      })
      .catch(() => { setState({ status: 'unreachable' }); });
  }, []);
  useEffect(load, [load]);

  if (state.status === 'loading') return <Spinner label="Loading D3 Floorspec" />;
  if (state.status === 'unreachable') {
    return (
      <EmptyState kind="error" heading="D3 Floorspec is not answering">
        The API did not respond. Check the server and reload.
      </EmptyState>
    );
  }

  const invite = /^\/invite\/([A-Za-z0-9_-]+)$/.exec(path)?.[1];

  if (state.status === 'anonymous') {
    // An invite link is followed by somebody with no account yet: that is the point of it.
    if (invite !== undefined) return <AcceptInvite token={invite} onDone={load} />;
    if (state.session.setupRequired) return <Setup tokenRequired={state.session.setupTokenRequired} onDone={load} />;
    return <SignIn oidcAvailable={state.session.oidcAvailable} onSignedIn={load} />;
  }

  // Signed in: the anonymous-only screens are not places to be.
  if (path === '/setup' || path === '/signin' || invite !== undefined) {
    navigate('/', { replace: true });
    return null;
  }

  const { session } = state;
  const operator = session.account.role === 'operator';

  return (
    <AppShell
      storageKey="floorspec.nav"
      brand={<AppShellBrand name="D3 Floorspec" href="/" />}
      nav={
        <SideNav>
          <SideNavItem href="/" icon={<FolderOpen />} label="Projects" current={path === '/' || path.startsWith('/projects')} />
          {operator ? (
            <SideNavItem href="/invites" icon={<MailPlus />} label="Invites" current={path === '/invites'} />
          ) : null}
          <SideNavItem href="/account" icon={<UserRound />} label="Account" current={path === '/account'} />
        </SideNav>
      }
      footer={
        <AccountMenu name={session.account.displayName} detail={session.account.email}>
          <ThemeSwitch />
          <MenuSeparator />
          <MenuItem onSelect={() => { navigate('/account'); }}>Account settings</MenuItem>
          <MenuItem
            tone="danger"
            onSelect={() => {
              void logout().finally(() => {
                navigate('/', { replace: true });
                load();
              });
            }}
          >
            Sign out
          </MenuItem>
        </AccountMenu>
      }
    >
      <Screen path={path} session={session} reload={load} />
    </AppShell>
  );
}

function Screen({ path, session, reload }: { path: string; session: SignedIn; reload: () => void }) {
  if (path === '/' || path === '/projects') return <Projects />;
  const project = /^\/projects\/([0-9a-f-]{36})$/.exec(path)?.[1];
  if (project !== undefined) return <Project key={project} id={project} you={session.account.displayName} />;
  const editor = /^\/projects\/([0-9a-f-]{36})\/editor$/.exec(path)?.[1];
  if (editor !== undefined) return <EditorPlaceholder key={editor} id={editor} />;
  if (path === '/account') return <Account session={session} onChanged={reload} />;
  if (path === '/invites' && session.account.role === 'operator') return <Invites />;
  return (
    <EmptyState kind="no-results" heading="That page does not exist">
      Nothing is served at {path}.
    </EmptyState>
  );
}
