import type { NextFunction, Request, Response } from 'express';
import { isSecureOrigin, type Config } from '../config.js';
import type { Db } from '../db.js';
import '../http/context.js';
import * as sessions from './sessions.js';

/**
 * Attach an auth context when a live session cookie is presented. Never rejects: the route builder's
 * access guard decides what an anonymous request means, so a public route stays public.
 */
export function attachAuth(db: Db, config: Config) {
  const name = sessions.cookieName(isSecureOrigin(config));
  return (req: Request, _res: Response, next: NextFunction): void => {
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
