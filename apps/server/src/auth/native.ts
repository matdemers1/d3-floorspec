import type { Config } from '../config.js';
import type { Tx } from '../db.js';
import { hashPassword, needsRehash, verifyPassword } from './passwords.js';
import * as sessions from './sessions.js';
import * as throttle from './throttle.js';
import { decryptSecret, encryptSecret, generateSecret, provisioningUri, verifyCode } from './totp.js';

/**
 * The app-native login path, ported from Foreman (FLR-REQ-004). It must keep working when D3 Auth
 * is unreachable, which is why nothing in this file imports anything OIDC.
 *
 * The order is deliberate: **throttle, then hash**. Deciding the delay after a failed comparison
 * would mean every rejected guess had already cost 64 MiB of Argon2id.
 */

export type LoginOutcome =
  | { readonly kind: 'session'; readonly token: string; readonly accountId: string }
  | { readonly kind: 'totp_required' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'throttled'; readonly retryAfterMs: number };

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  /** Present on the second leg, once TOTP is enrolled. */
  readonly totpCode?: string | undefined;
  readonly ip: string;
  readonly userAgent?: string | undefined;
}

/**
 * A dummy hash, verified when no account matches, so a missing account and a wrong password take
 * the same time. Generated once per process from a value nobody knows.
 */
let decoyHash: Promise<string> | null = null;
function decoy(pepper: string): Promise<string> {
  decoyHash ??= hashPassword(`decoy:${String(Math.random())}`, pepper);
  return decoyHash;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function login(tx: Tx, config: Config, input: LoginInput): Promise<LoginOutcome> {
  const email = normaliseEmail(input.email);
  const keys = { account: email, ip: input.ip };

  const decision = await throttle.check(tx, keys);
  if (!decision.allowed) return { kind: 'throttled', retryAfterMs: decision.retryAfterMs };

  const account = await tx.account.findUnique({ where: { email }, include: { credential: true } });
  if (account === null || account.credential === null || account.disabledAt !== null) {
    await verifyPassword(await decoy(config.PEPPER), input.password, config.PEPPER);
    await throttle.recordFailure(tx, keys);
    return { kind: 'rejected' };
  }

  const credential = account.credential;
  if (!(await verifyPassword(credential.passwordHash, input.password, config.PEPPER))) {
    await throttle.recordFailure(tx, keys);
    return { kind: 'rejected' };
  }

  // Parameters strengthen over time; a correct password is the only chance to re-hash it.
  if (needsRehash(credential.passwordHash)) {
    await tx.credential.update({
      where: { accountId: account.id },
      data: { passwordHash: await hashPassword(input.password, config.PEPPER) },
    });
  }

  if (credential.totpConfirmedAt !== null && credential.totpSecret !== null) {
    if (input.totpCode === undefined || input.totpCode.length === 0) return { kind: 'totp_required' };
    const result = verifyCode(
      decryptSecret(credential.totpSecret, config.KEK),
      input.totpCode,
      email,
      credential.totpLastStep === null ? null : Number(credential.totpLastStep),
    );
    if (!result.valid) {
      await throttle.recordFailure(tx, keys);
      return { kind: 'rejected' };
    }
    // Burn the step so the same code cannot be replayed inside its window.
    await tx.credential.update({
      where: { accountId: account.id },
      data: { totpLastStep: BigInt(result.step ?? 0) },
    });
  }

  await throttle.clear(tx, keys);
  const session = await sessions.issue(tx, account.id, 'password', {
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return { kind: 'session', token: session.token, accountId: account.id };
}

/** Begin TOTP enrolment: a secret, stored encrypted but not in force until a code proves it. */
export async function beginTotpEnrolment(
  tx: Tx,
  config: Config,
  accountId: string,
): Promise<{ secret: string; uri: string } | null> {
  const account = await tx.account.findUniqueOrThrow({
    where: { id: accountId },
    include: { credential: true },
  });
  // An account that signs in only with D3 Auth has no password, and TOTP here guards the password.
  if (account.credential === null) return null;
  if (account.credential.totpConfirmedAt !== null) return null;
  const secret = generateSecret();
  await tx.credential.update({
    where: { accountId },
    data: { totpSecret: encryptSecret(secret, config.KEK), totpConfirmedAt: null },
  });
  return { secret, uri: provisioningUri(secret, account.email) };
}

/** Confirm enrolment. Until this succeeds, TOTP is not in force and cannot lock anyone out. */
export async function confirmTotpEnrolment(
  tx: Tx,
  config: Config,
  accountId: string,
  code: string,
): Promise<boolean> {
  const account = await tx.account.findUniqueOrThrow({
    where: { id: accountId },
    include: { credential: true },
  });
  const secret = account.credential?.totpSecret;
  if (secret === undefined || secret === null || account.credential?.totpConfirmedAt !== null) return false;
  const result = verifyCode(decryptSecret(secret, config.KEK), code, account.email, null);
  if (!result.valid) return false;
  await tx.credential.update({
    where: { accountId },
    data: { totpConfirmedAt: new Date(), totpLastStep: BigInt(result.step ?? 0) },
  });
  return true;
}

/**
 * Turn TOTP off. It takes a current code, not just a session: a stolen cookie must not be enough to
 * strip the second factor from the account it was stolen from.
 */
export async function disableTotp(
  tx: Tx,
  config: Config,
  accountId: string,
  code: string,
): Promise<boolean> {
  const account = await tx.account.findUniqueOrThrow({
    where: { id: accountId },
    include: { credential: true },
  });
  const credential = account.credential;
  if (credential === null || credential.totpSecret === null || credential.totpConfirmedAt === null) {
    return false;
  }
  const result = verifyCode(
    decryptSecret(credential.totpSecret, config.KEK),
    code,
    account.email,
    credential.totpLastStep === null ? null : Number(credential.totpLastStep),
  );
  if (!result.valid) return false;
  await tx.credential.update({
    where: { accountId },
    data: { totpSecret: null, totpConfirmedAt: null, totpLastStep: null },
  });
  return true;
}
