import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { TokenPrincipal } from '../http/context.js';

/**
 * D3 Floorspec as an OAuth 2.1 resource server for its MCP endpoint (FLR-T-2.6), after Foreman's
 * ADR-013.
 *
 * Claude's connector signs in through D3 Auth as a **public** client (PKCE, no secret — the
 * connector sends `client_secret_post`, which D3 Auth does not accept) and presents the access
 * token D3 Auth minted for the resource `<PUBLIC_URL>/mcp`. The one check that matters is the
 * audience: MCP servers MUST only accept tokens issued for themselves, or any token D3 Auth ever
 * issued — for Bindery, for Foreman — would open every house in here.
 *
 * The person behind the token must already have linked D3 Auth to their account (FLR-T-0.5): a
 * token provisions nothing and adopts nothing by email. And the connector is an agent: it reads,
 * and it writes changesets a person accepts, never main (FLR-ADR-016).
 */

export class TokenRejected extends Error {}

export interface ResourceToken {
  readonly iss: string;
  readonly sub: string;
  /** The client the token was issued to (`azp`, else `client_id`), for the op log. */
  readonly client: string | undefined;
}

export interface Verifier {
  verify(token: string): Promise<ResourceToken>;
}

/** The canonical URI of the MCP server (RFC 8707 §2), and the audience every token must carry. */
export function canonicalMcpUri(config: Pick<Config, 'PUBLIC_URL'>): string {
  return new URL('/mcp', config.PUBLIC_URL).toString();
}

/** A verifier over a key set. `keys` is injectable so the audience check can be tested offline. */
export function verifierFor(issuer: string, audience: string, keys: JWTVerifyGetKey): Verifier {
  return {
    async verify(token: string): Promise<ResourceToken> {
      let payload: Record<string, unknown>;
      try {
        // Issuer and audience are checked by the library as part of verification, not afterwards:
        // a check written after a successful verify is a check somebody can forget.
        payload = (await jwtVerify(token, keys, { issuer, audience })).payload;
      } catch (error) {
        throw new TokenRejected(error instanceof Error ? error.message : 'the token did not verify');
      }
      const sub = payload['sub'];
      if (typeof sub !== 'string' || sub.length === 0) throw new TokenRejected('the token carries no subject');
      const client = typeof payload['azp'] === 'string' ? payload['azp'] : typeof payload['client_id'] === 'string' ? payload['client_id'] : undefined;
      return { iss: issuer, sub, client };
    },
  };
}

/** Null when D3 Auth is not configured: the MCP endpoint then takes API tokens only. */
export function createVerifier(config: Config): Verifier | null {
  const issuer = config.D3AUTH_ISSUER;
  if (issuer === undefined) return null;
  // D3 Auth serves its key set beside its issuer; `createRemoteJWKSet` caches it and refetches on an
  // unknown `kid`, so a key rotation costs one fetch rather than a restart.
  const jwks = createRemoteJWKSet(new URL(config.D3AUTH_JWKS_URI ?? new URL('/oidc/jwks', issuer).toString()));
  return verifierFor(issuer, canonicalMcpUri(config), jwks);
}

/** A verified D3 Auth access token, resolved to the linked account; null for anything else. */
export async function oauthPrincipal(db: Db, verifier: Verifier, presented: string): Promise<TokenPrincipal | null> {
  let token: ResourceToken;
  try {
    token = await verifier.verify(presented);
  } catch {
    // Wrong audience, wrong issuer, expired, forged: one answer for all of them.
    return null;
  }
  const identity = await db.identity.findUnique({
    where: { iss_sub: { iss: token.iss, sub: token.sub } },
    select: { accountId: true, account: { select: { disabledAt: true } } },
  });
  if (identity === null || identity.account.disabledAt !== null) return null;
  return {
    via: 'oauth',
    tokenId: null,
    name: `d3auth:${token.client ?? 'connector'}`,
    accountId: identity.accountId,
    projectId: null,
    scopes: new Set(['read', 'agent']),
  };
}

/** The RFC 9728 document: where a client finds the authorization server for `/mcp`. */
export function protectedResourceMetadata(config: Config): Record<string, unknown> {
  return {
    resource: canonicalMcpUri(config),
    authorization_servers: config.D3AUTH_ISSUER === undefined ? [] : [config.D3AUTH_ISSUER],
    scopes_supported: ['openid', 'profile', 'email'],
    bearer_methods_supported: ['header'],
    resource_name: 'D3 Floorspec',
    resource_documentation: new URL('/', config.PUBLIC_URL).toString(),
  };
}

/** The challenge a 401 from `/mcp` carries, so a client that guessed nothing finds the metadata. */
export function wwwAuthenticate(config: Config, error?: string): string {
  const metadata = new URL('/.well-known/oauth-protected-resource/mcp', config.PUBLIC_URL).toString();
  const parts = [`resource_metadata="${metadata}"`, 'scope="openid profile email"'];
  if (error !== undefined) parts.push(`error="${error}"`);
  return `Bearer ${parts.join(', ')}`;
}
