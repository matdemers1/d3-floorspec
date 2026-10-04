import type { NextFunction, Request, Response } from 'express';
import { isSecureOrigin, type Config } from '../config.js';
import type { Db } from '../db.js';
import '../http/context.js';
import * as sessions from './sessions.js';
import { resolveToken, TOKEN_PREFIX } from '../domain/tokens.js';
import { oauthPrincipal, type Verifier } from './resource-server.js';

/**
 * Attach who is asking. Never rejects: the route builder's access guard decides what an anonymous
 * request means, so a public route stays public.
 *
 * Two kinds of caller, never both on one request:
 *   - a **bearer credential** (`Authorization: Bearer …`) sets `req.token` — a per-project API token
 *     (`fls_…`), or a D3 Auth access token for `/mcp` (a JWT). A request that carries one is judged
 *     by it alone, and any cookie beside it is ignored: a bearer request is a program's, not a
 *     browser's.
 *   - a **session cookie** sets `req.auth`.
 */
export function attachAuth(db: Db, config: Config, verifier: Verifier | null = null) {
  const name = sessions.cookieName(isSecureOrigin(config));
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.get('authorization');
    if (header !== undefined && /^bearer\s+/i.test(header)) {
      const presented = header.replace(/^bearer\s+/i, '').trim();
      void (async () => {
        // Told apart by shape, not by trying both: an API token is `fls_`-prefixed, a JWT is three
        // dot-separated segments, and neither lookup ever sees the other's credential.
        const principal = presented.startsWith(TOKEN_PREFIX)
          ? await resolveToken(db, presented)
          : verifier !== null && presented.split('.').length === 3
            ? await oauthPrincipal(db, verifier, presented)
            : null;
        if (principal !== null) req.token = principal;
      })().then(() => {
        next();
      }, next);
      return;
    }
    const token = sessions.readCookie(req, name);
    if (token === null) {
      next();
      return;
    }
    void (async () => {
      const session = await sessions.resolve(db, token);
      if (session === null) return;
      // Read per request rather than baked into the session, so a role change lands on the next
      // request, not the next sign-in.
      const account = await db.account.findUnique({
        where: { id: session.accountId },
        select: { email: true, role: true },
      });
      if (account === null) return;
      req.auth = {
        accountId: session.accountId,
        email: account.email,
        role: account.role,
        sessionId: session.sessionId,
        method: session.method,
      };
    })().then(() => {
      next();
    }, next);
  };
}
