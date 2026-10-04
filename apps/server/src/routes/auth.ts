import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { isSecureOrigin, type Config } from '../config.js';
import type { Db, Tx } from '../db.js';
import { Routes } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import { acceptInvite, peekInvite } from '../domain/invites.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/passwords.js';
import * as native from '../auth/native.js';
import * as sessions from '../auth/sessions.js';

/**
 * The account routes under `/auth`: first-run setup, sign-in and out, TOTP, and accepting an
 * invite. **There is no sign-up route** (FLR-REQ-009): the operator comes from first-run setup,
 * which works only while no account exists, and everybody else from an invite.
 */

const Email = z.string().trim().toLowerCase().max(320).pipe(z.email());
const Password = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `use at least ${String(MIN_PASSWORD_LENGTH)} characters`)
  .max(1024);
const DisplayName = z.string().trim().min(1).max(120);

const SetupBody = z.object({ email: Email, displayName: DisplayName, password: Password, setupToken: z.string().max(512).optional() });
const LoginBody = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  totpCode: z.string().max(16).optional(),
});
const CodeBody = z.object({ code: z.string().trim().min(6).max(10) });
const AcceptBody = z.object({ email: Email, displayName: DisplayName, password: Password });

/** A body that does not parse is a 400 naming each field, never a 500. */
export function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, 'the request body is not valid', {
      fields: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

function meta(req: Request) {
  return { ip: req.ip ?? 'unknown', userAgent: req.get('user-agent') };
}

export interface AuthRouteDeps {
  readonly db: Db;
  readonly config: Config;
  /** Whether the D3 Auth button should be offered: configured *and* reachable at boot. */
  readonly oidcAvailable: boolean;
}

export function authRoutes({ db, config, oidcAvailable }: AuthRouteDeps): Routes {
  const routes = new Routes(db);
  const secure = isSecureOrigin(config);

  /** Who am I. The editor calls this first to decide between setup, sign-in and the app. */
  routes.read(
    '/session',
    async (req, res) => {
      const accountId = req.auth?.accountId;
      if (accountId === undefined) {
        // The sign-in screen needs both answers, and is reached by exactly the people this branch
        // answers. Neither is a secret: whether a button renders, and whether this is a new install.
        const setupRequired = (await db.account.count()) === 0;
        res.status(401).json({
          authenticated: false,
          oidcAvailable,
          setupRequired,
          ...(setupRequired ? { setupTokenRequired: config.SETUP_TOKEN !== undefined } : {}),
        });
        return;
      }
      const account = await db.account.findUniqueOrThrow({
        where: { id: accountId },
        include: { credential: true, identities: { select: { iss: true, email: true, linkedAt: true } } },
      });
      res.json({
        authenticated: true,
        account: { id: account.id, email: account.email, displayName: account.displayName, role: account.role },
        hasPassword: account.credential !== null,
        totpEnrolled: (account.credential?.totpConfirmedAt ?? null) !== null,
        d3auth: account.identities[0] ?? null,
        oidcAvailable,
      });
    },
    { access: 'public' },
  );

  /**
   * First-run setup: create the operator. Works only while no account exists; after that it is a
   * 404, as if it had never been there. An advisory lock makes two simultaneous first runs one.
   */
  routes.mutate(
    'POST',
    '/setup',
    async (req, tx) => {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext('floorspec:first-run-setup'))`;
      if ((await tx.account.count()) > 0) throw new HttpError(404, 'not found');
      const body = parse(SetupBody, req.body);
      if (config.SETUP_TOKEN !== undefined && !sameSecret(body.setupToken ?? '', config.SETUP_TOKEN)) {
        throw new HttpError(403, 'The setup token is missing or wrong. It is SETUP_TOKEN in the server environment.');
      }
      const account = await tx.account.create({
        data: {
          email: body.email,
          displayName: body.displayName,
          role: 'operator',
          credential: { create: { passwordHash: await hashPassword(body.password, config.PEPPER) } },
        },
      });
      const session = await sessions.issue(tx, account.id, 'password', meta(req));
      return {
        reply: (res) => {
          sessions.setCookie(res, session.token, secure);
          res.status(201).json({ status: 'signed_in' });
        },
        audit: {
          action: 'account.setup',
          targetType: 'account',
          targetId: account.id,
          actorAccountId: account.id,
          detail: { role: 'operator' },
        },
      };
    },
    { access: 'public' },
  );

  routes.mutate(
    'POST',
    '/login',
    async (req, tx) => {
      const body = LoginBody.safeParse(req.body);
      if (!body.success) {
        return { reply: (res) => res.status(400).json({ error: 'email and password are required' }), audit: null };
      }
      const outcome = await native.login(tx, config, { ...body.data, ...meta(req) });
      switch (outcome.kind) {
        case 'throttled': {
          const seconds = Math.ceil(outcome.retryAfterMs / 1000);
          return {
            reply: (res) => {
              res.setHeader('Retry-After', String(seconds));
              res.status(429).json({ error: 'too many attempts', retryAfterSeconds: seconds });
            },
            audit: null,
          };
        }
        case 'rejected':
          // One message for every failure: wrong account, wrong password, wrong code.
          return { reply: (res) => res.status(401).json({ error: 'invalid credentials' }), audit: null };
        case 'totp_required':
          return { reply: (res) => res.json({ status: 'totp_required' }), audit: null };
        case 'session':
          return {
            reply: (res) => {
              sessions.setCookie(res, outcome.token, secure);
              res.json({ status: 'signed_in' });
            },
            audit: {
              action: 'auth.login',
              targetType: 'account',
              targetId: outcome.accountId,
              actorAccountId: outcome.accountId,
              detail: { method: 'password' },
            },
          };
      }
    },
    { access: 'public' },
  );

  /** Signing out must always appear to work: a cookie left behind is the worse failure. */
  routes.mutate(
    'POST',
    '/logout',
    async (req, tx) => {
      const auth = req.auth;
      if (auth !== undefined) await sessions.revoke(tx, auth.sessionId);
      return {
        reply: (res) => {
          sessions.clearCookie(res, secure);
          res.status(204).end();
        },
        audit:
          auth === undefined
            ? null
            : { action: 'auth.logout', targetType: 'session', targetId: auth.sessionId, detail: { method: auth.method } },
      };
    },
    { access: 'public' },
  );

  routes.mutate('POST', '/totp/enrol', async (req, tx) => {
    const accountId = accountOf(req);
    const started = await native.beginTotpEnrolment(tx, config, accountId);
    if (started === null) throw new HttpError(409, 'two-factor is already on, or this account has no password');
    return {
      // Shown once, and only to the account it belongs to.
      reply: (res) => res.json(started),
      audit: { action: 'auth.totp.enrol', targetType: 'account', targetId: accountId },
    };
  });

  routes.mutate('POST', '/totp/confirm', async (req, tx) => {
    const accountId = accountOf(req);
    const { code } = parse(CodeBody, req.body);
    if (!(await native.confirmTotpEnrolment(tx, config, accountId, code))) {
      return { reply: (res) => res.status(400).json({ error: 'that code did not match' }), audit: null };
    }
    return {
      reply: (res) => res.status(204).end(),
      audit: { action: 'auth.totp.enable', targetType: 'account', targetId: accountId },
    };
  });

  routes.mutate('POST', '/totp/disable', async (req, tx) => {
    const accountId = accountOf(req);
    const { code } = parse(CodeBody, req.body);
    if (!(await native.disableTotp(tx, config, accountId, code))) {
      return { reply: (res) => res.status(400).json({ error: 'that code did not match' }), audit: null };
    }
    return {
      reply: (res) => res.status(204).end(),
      audit: { action: 'auth.totp.disable', targetType: 'account', targetId: accountId },
    };
  });

  /** What the accept screen shows before anybody types: is this link usable, and for whom. */
  routes.read(
    '/invites/:token',
    async (req, res) => {
      const invite = await peekInvite(db, String(req.params['token']));
      if (invite === null) throw new HttpError(404, 'that invite is not usable — ask for a new one');
      res.json(invite);
    },
    { access: 'public' },
  );

  /** Spend an invite: the account is created, signed in, and the link is used up. */
  routes.mutate(
    'POST',
    '/invites/:token/accept',
    async (req, tx: Tx) => {
      const body = parse(AcceptBody, req.body);
      const account = await acceptInvite(tx, config, String(req.params['token']), body);
      const session = await sessions.issue(tx, account.id, 'password', meta(req));
      return {
        reply: (res) => {
          sessions.setCookie(res, session.token, secure);
          res.status(201).json({ status: 'signed_in' });
        },
        audit: {
          action: 'invite.accept',
          targetType: 'invite',
          targetId: account.inviteId,
          actorAccountId: account.id,
          detail: { accountId: account.id },
        },
      };
    },
    { access: 'public' },
  );

  return routes;
}

export function accountOf(req: Request): string {
  const id = req.auth?.accountId;
  if (id === undefined) throw new HttpError(401, 'sign in first');
  return id;
}

/** Constant-time comparison of two secrets, so a setup token cannot be guessed byte by byte. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
