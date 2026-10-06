import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db, Tx } from '../db.js';
import type { TokenScope } from '../generated/prisma/enums.js';
import { hashToken } from '../auth/sessions.js';
import type { TokenPrincipal, TokenScopeName } from '../http/context.js';

/**
 * API tokens (FLR-T-2.5). The secret is `fls_` and 32 random bytes; only its SHA-256 is stored, and
 * it is shown once, at creation. A token reaches one project, or — with no project — every project
 * its account owns, now and later (FLR-T-2.11), so one MCP connection serves every house. Scopes:
 *
 *   - `read`  — describe, query, validate, render, export;
 *   - `write` — commit to `main` as the person who made the token;
 *   - `agent` — write named pending changesets on scratch heads, never `main` (FLR-ADR-016).
 *
 * `write` and `agent` are never on one token (the database refuses it): one secret cannot be both
 * the person's hand and the agent's.
 */

export const TOKEN_PREFIX = 'fls_';

/** What a person picks on the account screen; each is a fixed set of scopes. */
export const TOKEN_KINDS = {
  read: ['read'],
  write: ['read', 'write'],
  agent: ['read', 'agent'],
} as const satisfies Record<string, readonly TokenScope[]>;
export type TokenKind = keyof typeof TOKEN_KINDS;

export function kindOf(scopes: readonly TokenScope[]): TokenKind {
  if (scopes.includes('agent')) return 'agent';
  if (scopes.includes('write')) return 'write';
  return 'read';
}

export function mintSecret(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export interface CreatedToken {
  readonly id: string;
  readonly secret: string;
  readonly prefix: string;
}

export async function createToken(
  tx: Tx,
  input: { accountId: string; projectId: string | null; name: string; kind: TokenKind; expiresAt: Date | null },
): Promise<CreatedToken> {
  const secret = mintSecret();
  const prefix = secret.slice(0, TOKEN_PREFIX.length + 6);
  const row = await tx.apiToken.create({
    data: {
      accountId: input.accountId,
      projectId: input.projectId,
      name: input.name,
      tokenHash: hashToken(secret),
      prefix,
      scopes: [...TOKEN_KINDS[input.kind]],
      expiresAt: input.expiresAt,
    },
  });
  return { id: row.id, secret, prefix };
}

/**
 * Resolve a presented secret to the principal it acts as, or null. Revoked, expired, a disabled
 * account and a deleted project are all the same null: the request simply carries no credential.
 */
export async function resolveToken(db: Db, presented: string): Promise<TokenPrincipal | null> {
  if (!presented.startsWith(TOKEN_PREFIX) || presented.length > 200) return null;
  const tokenHash = hashToken(presented);
  const row = await db.apiToken.findUnique({
    where: { tokenHash },
    include: { account: { select: { disabledAt: true } }, project: { select: { deletedAt: true, ownerAccountId: true } } },
  });
  if (row === null) return null;
  // The lookup was by hash; comparing again in constant time costs nothing and closes the argument.
  if (!timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(tokenHash))) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) return null;
  if (row.account.disabledAt !== null) return null;
  // A project token dies with its project; an account-wide one reaches whatever the account owns,
  // which the ownership guard checks on every request.
  if (row.project !== null && (row.project.deletedAt !== null || row.project.ownerAccountId !== row.accountId)) return null;

  // Advisory, and never allowed to fail the request.
  void db.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);

  return {
    via: 'token',
    tokenId: row.id,
    name: row.name,
    accountId: row.accountId,
    projectId: row.projectId,
    scopes: new Set<TokenScopeName>(row.scopes),
  };
}
