import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db, Tx } from '../db.js';
import { HttpError } from '../http/errors.js';
import { hashPassword } from '../auth/passwords.js';
import { hashToken } from '../auth/sessions.js';

/**
 * Invites: the only way an account other than the operator comes to exist (FLR-REQ-009).
 *
 * The link carries a random token; only its SHA-256 is stored, so the invites table cannot be read
 * back into working links. Single-use, expiring, revocable.
 */

export interface CreatedInvite {
  readonly id: string;
  /** The whole link, shown once. */
  readonly url: string;
  readonly email: string | null;
  readonly expiresAt: Date;
}

export async function createInvite(
  tx: Tx,
  config: Config,
  createdById: string,
  email: string | null,
): Promise<CreatedInvite> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.INVITE_TTL_HOURS * 60 * 60 * 1000);
  const invite = await tx.invite.create({
    data: { tokenHash: hashToken(token), email, createdById, expiresAt },
  });
  return {
    id: invite.id,
    url: new URL(`/invite/${token}`, config.PUBLIC_URL).toString(),
    email,
    expiresAt,
  };
}

/** A usable invite, or null. Used, revoked, expired and unknown are all the same answer. */
async function usable(db: Db | Tx, token: string) {
  if (token.length < 16 || token.length > 128) return null;
  const invite = await db.invite.findUnique({ where: { tokenHash: hashToken(token) } });
  if (invite === null) return null;
  if (invite.acceptedAt !== null || invite.revokedAt !== null) return null;
  if (invite.expiresAt.getTime() <= Date.now()) return null;
  return invite;
}

export async function peekInvite(
  db: Db,
  token: string,
): Promise<{ email: string | null; expiresAt: Date } | null> {
  const invite = await usable(db, token);
  return invite === null ? null : { email: invite.email, expiresAt: invite.expiresAt };
}

export async function acceptInvite(
  tx: Tx,
  config: Config,
  token: string,
  body: { email: string; displayName: string; password: string },
): Promise<{ id: string; inviteId: string }> {
  const invite = await usable(tx, token);
  // One answer for every failure: telling them apart tells a guesser which guess was real.
  if (invite === null) throw new HttpError(404, 'that invite is not usable — ask for a new one');
  if (invite.email !== null && invite.email !== body.email) {
    throw new HttpError(400, 'this invite is for a different email address');
  }
  if ((await tx.account.count({ where: { email: body.email } })) > 0) {
    throw new HttpError(409, 'an account already uses that email address');
  }
  const account = await tx.account.create({
    data: {
      email: body.email,
      displayName: body.displayName,
      role: 'member',
      credential: { create: { passwordHash: await hashPassword(body.password, config.PEPPER) } },
    },
  });
  // Conditional on still being unused, so two simultaneous accepts cannot both spend one link.
  const { count } = await tx.invite.updateMany({
    where: { id: invite.id, acceptedAt: null, revokedAt: null },
    data: { acceptedAt: new Date(), acceptedAccountId: account.id },
  });
  if (count !== 1) throw new HttpError(404, 'that invite is not usable — ask for a new one');
  return { id: account.id, inviteId: invite.id };
}
