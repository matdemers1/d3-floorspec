import type { Request } from 'express';
import type { Tx } from '../db.js';
import { Prisma } from '../db.js';

/**
 * The audit row every mutating route writes (FLR-T-0.4): who, when, what, to what. Written in the
 * same transaction as the change by `Routes.mutate`, never by hand from a handler.
 */

export interface AuditEntry {
  /** Dotted: `project.create`, `auth.login`, `invite.revoke`. */
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly detail?: Record<string, unknown>;
  /**
   * Who did it, when the request itself does not say — a sign-in or first-run setup, where the
   * account only exists once the handler has run.
   */
  readonly actorAccountId?: string;
}

/** Field names never recorded, whatever they are attached to. */
const REDACTED = new Set([
  'password',
  'passwordHash',
  'totpSecret',
  'secret',
  'token',
  'tokenHash',
  'code',
  'clientSecret',
]);

export function scrub(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(scrub);
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED.has(key) ? '[redacted]' : scrub(inner);
  }
  return out;
}

/**
 * How the trail names whoever made the request: the person in a session, else the bearer credential
 * — `token:<id>` for a person's API token, `agent:<token id or D3 Auth client>` for an agent. A
 * credential's row still carries the account it acts for.
 */
export function actorOf(req: Request, accountId: string | null): string {
  const token = req.auth === undefined ? req.token : undefined;
  if (token !== undefined) {
    const who = token.tokenId ?? token.name;
    return token.scopes.has('agent') ? `agent:${who}` : `token:${who}`;
  }
  return accountId === null ? 'anonymous' : `account:${accountId}`;
}

export async function writeAudit(tx: Tx, req: Request, entry: AuditEntry): Promise<void> {
  const accountId = entry.actorAccountId ?? req.auth?.accountId ?? req.token?.accountId ?? null;
  await tx.auditLog.create({
    data: {
      actor: actorOf(req, accountId),
      actorAccountId: accountId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      // The route is recorded with every row, so the trail says how a change arrived as well as what
      // it was.
      detail: scrub({
        ...(entry.detail ?? {}),
        route: routeOf(req),
      }) as Prisma.InputJsonObject,
    },
  });
}

/** The declared route, spelled as the registry spells it: `POST /api/invites`, not `/api/invites/`. */
function routeOf(req: Request): string {
  const path = req.route === undefined ? '' : (req.route as { path: string }).path;
  const full = `${req.baseUrl}${path}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  return `${req.method} ${full}`;
}
