import { randomBytes } from 'node:crypto';
import { createAuthClient, type AuthClient } from '@d3cloudio/auth-client';
import type { Config } from '../config.js';
import type { Tx } from '../db.js';
import { logger } from '../logger.js';

/**
 * Sign in with D3 Auth — the second of the two login paths (FLR-REQ-004), on the shared relying-
 * party SDK exactly as Foreman uses it: authorization code with PKCE, state and nonce, issuer
 * checks, all inside `@d3cloudio/auth-client`.
 *
 * **It links to an existing account and never creates one** (FLR-T-0.5, FLR-REQ-009: accounts
 * come from first-run setup and invites only). See `resolveIdentity` for the two ways a D3 Auth
 * identity reaches an account; everything else is refused.
 *
 * Nothing here is load-bearing for the password path. Discovery happens once at boot and is
 * allowed to fail: with D3 Auth unset or unreachable, the sign-in screen shows one button.
 */

/** The scopes requested. `d3:roles` is what makes the roles claim appear at all. */
export const OIDC_SCOPE = 'openid profile email d3:roles';
/** The redirect URI to register on the D3 Auth client: `<PUBLIC_URL>/auth/oidc/callback`. */
export const CALLBACK_PATH = '/auth/oidc/callback';

/** A sign-in in flight. Ten minutes is longer than any real sign-in takes. */
const TRANSACTION_TTL_MS = 10 * 60 * 1000;
export const TX_COOKIE = 'floorspec_oidc_tx';

export interface CompletedSignIn {
  readonly iss: string;
  readonly sub: string;
  readonly email?: string;
  /** Only `true` when the issuer said so in so many words. */
  readonly emailVerified: boolean;
  readonly name?: string;
  /** Set when this sign-in was started from Account settings, to link the signed-in account. */
  readonly linkToAccountId?: string;
}

export interface OidcClient {
  readonly issuer: string;
  beginSignIn(linkToAccountId?: string): Promise<{ url: string; tx: string }>;
  completeSignIn(callbackUrl: URL, tx: string, state: string): Promise<CompletedSignIn>;
}

export class OidcError extends Error {}

/** The identity is real, but no account here is linked to it — and none will be made for it. */
export class NotLinked extends OidcError {}

interface PendingSignIn {
  readonly verifier: string;
  readonly state: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly linkToAccountId?: string;
}

/**
 * Discover the provider and build a client, or return `null` when it is not configured or not
 * reachable. Never throws.
 */
export async function createOidcClient(
  config: Config,
  options: { fetch?: typeof fetch } = {},
): Promise<OidcClient | null> {
  if (!config.oidcConfigured) return null;
  const issuer = config.D3AUTH_ISSUER ?? '';

  let client: AuthClient;
  try {
    client = await createAuthClient({
      issuer,
      clientId: config.D3AUTH_CLIENT_ID ?? '',
      clientSecret: config.D3AUTH_CLIENT_SECRET ?? '',
      redirectUri: new URL(CALLBACK_PATH, config.PUBLIC_URL).toString(),
      scope: OIDC_SCOPE,
      // Optional, never required: the password path must keep working without D3 Auth.
      ssoMode: 'optional',
      ...(issuer.startsWith('http://') ? { allowInsecureHttp: true } : {}),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  } catch (error) {
    logger.warn(
      { issuer, err: error instanceof Error ? error.message : String(error) },
      'D3 Auth discovery failed; the password path is unaffected',
    );
    return null;
  }

  const pending = new Map<string, PendingSignIn>();
  const sweep = (): void => {
    const now = Date.now();
    for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
  };

  return {
    issuer,

    async beginSignIn(linkToAccountId) {
      sweep();
      const start = await client.beginSignIn();
      const tx = randomBytes(32).toString('base64url');
      pending.set(tx, {
        verifier: start.verifier,
        state: start.state,
        nonce: start.nonce,
        expiresAt: Date.now() + TRANSACTION_TTL_MS,
        ...(linkToAccountId === undefined ? {} : { linkToAccountId }),
      });
      return { url: start.url, tx };
    },

    async completeSignIn(callbackUrl, tx, state) {
      const started = pending.get(tx);
      pending.delete(tx);
      // This browser started it, and it is the sign-in it started: a pasted callback URL is
      // useless. The SDK checks state, nonce, PKCE and the issuer.
      if (started === undefined) throw new OidcError('No sign-in is in progress for this browser.');
      if (started.expiresAt <= Date.now()) throw new OidcError('The sign-in took too long. Try again.');
      if (started.state !== state) throw new OidcError('The sign-in did not match. Try again.');

      let session;
      try {
        session = await client.completeSignIn(callbackUrl, {
          verifier: started.verifier,
          state: started.state,
          nonce: started.nonce,
        });
      } catch (error) {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'D3 Auth refused the code exchange');
        throw new OidcError('D3 Auth could not complete the sign-in. Try again.');
      }

      const { claims } = session.identity;
      const email = typeof claims['email'] === 'string' ? claims['email'] : undefined;
      const name = typeof claims['name'] === 'string' ? claims['name'] : undefined;
      return {
        iss: session.identity.iss,
        sub: session.identity.sub,
        ...(email === undefined ? {} : { email }),
        emailVerified: claims['email_verified'] === true,
        ...(name === undefined ? {} : { name }),
        ...(started.linkToAccountId === undefined ? {} : { linkToAccountId: started.linkToAccountId }),
      };
    },
  };
}

export type Resolution =
  | { readonly outcome: 'signed_in'; readonly accountId: string }
  | { readonly outcome: 'linked'; readonly accountId: string; readonly by: 'settings' };

/**
 * Resolve a completed D3 Auth sign-in to an existing account, or refuse. In order:
 *
 *   1. **An explicit link** — an identity row for this `(iss, sub)` — signs that account in.
 *   2. **Linking from Account settings**: a signed-in person started this sign-in to attach their
 *      D3 Auth identity, so it is attached to *that* account.
 *   3. Anything else is refused with a message saying how to link. **No account is ever created**,
 *      which is what keeps invites the only way in (FLR-REQ-009).
 *
 * Email is never used to find an account, verified or not — the ecosystem rule (FRM-ADR-004,
 * PST-ADR-015, and the SDK's own contract: claims are for display, never for identity). Someone
 * who controls an address at the issuer does not thereby own the account here that uses it.
 */
export async function resolveIdentity(tx: Tx, completed: CompletedSignIn): Promise<Resolution> {
  const linked = await tx.identity.findUnique({
    where: { iss_sub: { iss: completed.iss, sub: completed.sub } },
    include: { account: { select: { disabledAt: true } } },
  });

  if (linked !== null) {
    if (completed.linkToAccountId !== undefined && completed.linkToAccountId !== linked.accountId) {
      throw new OidcError('That D3 Auth account is already linked to a different D3 Floorspec account.');
    }
    if (linked.account.disabledAt !== null) throw new OidcError('This account is disabled.');
    await tx.identity.update({ where: { id: linked.id }, data: { lastLoginAt: new Date() } });
    return { outcome: 'signed_in', accountId: linked.accountId };
  }

  if (completed.linkToAccountId !== undefined) {
    await link(tx, completed.linkToAccountId, completed);
    return { outcome: 'linked', accountId: completed.linkToAccountId, by: 'settings' };
  }

  throw new NotLinked(
    'No D3 Floorspec account is linked to that D3 Auth sign-in. Sign in with your password, then ' +
      'link D3 Auth from Account settings. Accounts are created by invitation only.',
  );
}

async function link(tx: Tx, accountId: string, completed: CompletedSignIn): Promise<void> {
  const existing = await tx.identity.findUnique({
    where: { accountId_iss: { accountId, iss: completed.iss } },
  });
  if (existing !== null) {
    throw new OidcError('This account is already linked to a different D3 Auth account. Unlink it first.');
  }
  await tx.identity.create({
    data: {
      accountId,
      iss: completed.iss,
      sub: completed.sub,
      email: completed.email ?? null,
      lastLoginAt: new Date(),
    },
  });
}
