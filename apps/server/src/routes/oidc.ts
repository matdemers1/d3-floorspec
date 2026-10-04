import { isSecureOrigin, type Config } from '../config.js';
import type { Db } from '../db.js';
import { Routes } from '../http/routes.js';
import { logger } from '../logger.js';
import {
  CALLBACK_PATH,
  NotLinked,
  OidcError,
  resolveIdentity,
  TX_COOKIE,
  type OidcClient,
} from '../auth/oidc.js';
import * as sessions from '../auth/sessions.js';

/**
 * The D3 Auth routes, mounted **beside** the password routes. With no client — not configured, or
 * the issuer unreachable at boot — they still exist and answer 503; the password path is untouched.
 */
export function oidcRoutes(db: Db, config: Config, client: OidcClient | null): Routes {
  const routes = new Routes(db);
  const secure = isSecureOrigin(config);

  // The transaction cookie is scoped to the callback and lasts minutes. Lax is required: the
  // provider's redirect back is a top-level cross-site GET, which Strict would drop.
  const txCookie = (value: string, maxAgeSeconds: number) =>
    [
      `${TX_COOKIE}=${value}`,
      `Path=${CALLBACK_PATH}`,
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${String(maxAgeSeconds)}`,
      ...(secure ? ['Secure'] : []),
    ].join('; ');

  /** Start a sign-in, or — with `?link=1` from Account settings — a link to the signed-in account. */
  routes.read(
    '/start',
    async (req, res) => {
      if (client === null) {
        res.status(503).json({ error: 'Sign in with D3 Auth is not available' });
        return;
      }
      const linkTo = req.query['link'] === '1' ? req.auth?.accountId : undefined;
      const { url, tx } = await client.beginSignIn(linkTo);
      res.setHeader('Set-Cookie', txCookie(tx, 600));
      res.redirect(302, url);
    },
    { access: 'public' },
  );

  /**
   * The provider's redirect back. A GET that changes state — it links identities and issues
   * sessions — so it is declared with `mutate` and audited like any other change, refusals included.
   */
  routes.mutate(
    'GET',
    '/callback',
    async (req, tx) => {
      const clearTx = txCookie('', 0);
      if (client === null) {
        return {
          reply: (res) => {
            res.setHeader('Set-Cookie', clearTx);
            res.status(503).json({ error: 'Sign in with D3 Auth is not available' });
          },
          audit: null,
        };
      }

      const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
      const pending = sessions.readCookie(req, TX_COOKIE);
      const refuse = (message: string, reason: string, linking: boolean) => ({
        reply: (res: import('express').Response) => {
          res.setHeader('Set-Cookie', clearTx);
          // Back to the screen the person came from, with the reason: they are in a browser after a
          // redirect they did not type, and a page of JSON tells them nothing.
          const back = linking ? '/account' : '/signin';
          res.redirect(302, `${back}?${new URLSearchParams({ d3auth_error: message }).toString()}`);
        },
        audit: { action: 'auth.oidc.refused', targetType: 'identity', detail: { reason } },
      });

      if (pending === null) return refuse('No sign-in is in progress for this browser.', 'no_transaction', false);

      let completed;
      try {
        completed = await client.completeSignIn(new URL(req.originalUrl, config.PUBLIC_URL), pending, state);
      } catch (error) {
        if (error instanceof OidcError) return refuse(error.message, 'exchange', false);
        throw error;
      }

      const linking = completed.linkToAccountId !== undefined;
      let resolution;
      try {
        resolution = await resolveIdentity(tx, completed);
      } catch (error) {
        if (error instanceof OidcError) {
          logger.warn({ reason: error.message, iss: completed.iss }, 'D3 Auth sign-in refused');
          return refuse(error.message, error instanceof NotLinked ? 'not_linked' : 'refused', linking);
        }
        throw error;
      }

      // Linking from settings keeps the session the person already has; anything else signs in.
      const session =
        resolution.outcome === 'linked'
          ? null
          : await sessions.issue(tx, resolution.accountId, 'oidc', {
              ip: req.ip ?? 'unknown',
              userAgent: req.get('user-agent'),
            });
      return {
        reply: (res) => {
          res.setHeader('Set-Cookie', clearTx);
          if (session !== null) sessions.setCookie(res, session.token, secure);
          res.redirect(302, session === null ? '/account?d3auth=linked' : '/');
        },
        audit: {
          action: resolution.outcome === 'linked' ? 'identity.link' : 'auth.login',
          targetType: 'account',
          targetId: resolution.accountId,
          actorAccountId: resolution.accountId,
          detail: {
            method: 'oidc',
            iss: completed.iss,
            ...(resolution.outcome === 'linked' ? { linkedBy: resolution.by } : {}),
          },
        },
      };
    },
    { access: 'public' },
  );

  return routes;
}
