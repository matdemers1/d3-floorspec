import type { AccountRole, AuthMethod } from '../generated/prisma/enums.js';
import type { Project } from '../generated/prisma/client.js';

/** Who is asking. Set by `attachAuth` from the session cookie; absent for an anonymous request. */
export interface AuthContext {
  readonly accountId: string;
  readonly email: string;
  readonly role: AccountRole;
  readonly sessionId: string;
  readonly method: AuthMethod;
}

export type TokenScopeName = 'read' | 'write' | 'agent';

/**
 * A caller that presented a bearer credential rather than a session (FLR-T-2.5, FLR-T-2.6): a
 * per-project API token, or a D3 Auth access token minted for this server's `/mcp` resource.
 *
 * It is never an {@link AuthContext}: a bearer credential reaches only the routes that say they
 * accept one, so a leaked project token cannot change a password, mint another token or read
 * another project.
 */
export interface TokenPrincipal {
  /** `token`: a per-project API token. `oauth`: Claude's connector, signed in through D3 Auth. */
  readonly via: 'token' | 'oauth';
  /** The API token's row; null for an OAuth access token. */
  readonly tokenId: string | null;
  /** The token's name, or the D3 Auth client that obtained the access token. */
  readonly name: string;
  /** The person the credential acts for. */
  readonly accountId: string;
  /** The one project an API token is scoped to; null for OAuth, which reaches the account's projects. */
  readonly projectId: string | null;
  readonly scopes: ReadonlySet<TokenScopeName>;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
    token?: TokenPrincipal;
    /** Set by the ownership guard on every `:projectId` route, after it has checked the owner. */
    project?: Project;
  }
}

/** True when a bearer credential writes changesets rather than main (FLR-ADR-016). */
export function isAgent(token: TokenPrincipal): boolean {
  return token.scopes.has('agent');
}
