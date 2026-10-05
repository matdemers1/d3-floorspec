import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { HttpError } from '../http/errors.js';
import { resolveShare, type ResolvedShare } from './links.js';
import type { ShareLimits } from './limit.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `shareContext` on every `/api/share/:token` route, once the token resolved to a live link. */
    share?: ResolvedShare;
  }
}

/**
 * Headers every share response carries: no search engine indexes a shared house, no page a viewer
 * leaves for learns the link from `Referer`, and nothing between here and the browser keeps a copy
 * — a revoked link must stop working everywhere at once. The model overrides the cache rule with a
 * revalidated ETag, which still asks this server every time.
 */
export function privateShareHeaders(res: Response): void {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, no-store');
}

function tooMany(res: Response, seconds: number): HttpError {
  res.setHeader('Retry-After', String(seconds));
  return new HttpError(429, 'too many requests; wait a moment and try again');
}

/**
 * Resolve `:token` to a live link, or answer: 404 for a token that names nothing (counted against
 * the client's budget of misses, so tokens cannot be guessed at speed — not that 256 bits can be),
 * 410 with the reason for an expired or revoked one, 429 past the client's budget of reads.
 */
export function shareContext(db: Db, limits: ShareLimits): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    privateShareHeaders(res);
    const ip = req.ip ?? 'unknown';
    if (!limits.misses.allows(ip)) {
      next(tooMany(res, limits.misses.retryAfter(ip)));
      return;
    }
    if (!limits.reads.take(ip)) {
      next(tooMany(res, limits.reads.retryAfter(ip)));
      return;
    }
    resolveShare(db, String(req.params['token'] ?? ''))
      .then((resolution) => {
        if (resolution.status === 'missing') {
          limits.misses.take(ip);
          next(new HttpError(404, 'this link does not exist'));
          return;
        }
        if (resolution.status === 'gone') {
          next(new HttpError(410, resolution.reason === 'expired' ? 'this link has expired' : 'this link was revoked', { reason: resolution.reason }));
          return;
        }
        req.share = resolution.share;
        next();
      })
      .catch(next);
  };
}

/** The resolved link. Every share route runs `shareContext` first, so its absence is a bug, not a request. */
export function shareOf(req: Request): ResolvedShare {
  if (req.share === undefined) throw new HttpError(404, 'this link does not exist');
  return req.share;
}

/**
 * A comment or a share link written with the session cookie must come from this app's own pages
 * (FLR-T-9.6). The cookie is `SameSite=Lax`, so a cross-site POST carries none — the app's standing
 * defence — and these writes also refuse a browser that says the request is cross-site
 * (`Sec-Fetch-Site`, which a page's script cannot set), an `Origin` other than PUBLIC_URL's, and a
 * body that is not JSON (which no HTML form can send).
 */
export function sameOrigin(config: Pick<Config, 'PUBLIC_URL'>): RequestHandler {
  const allowed = new URL(config.PUBLIC_URL).origin;
  return (req, _res, next) => {
    const site = req.get('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      next(new HttpError(403, 'a request from another site is refused'));
      return;
    }
    const origin = req.get('origin');
    if (origin !== undefined && origin !== allowed) {
      next(new HttpError(403, 'a request from another site is refused'));
      return;
    }
    if (req.method !== 'DELETE' && !req.is('application/json')) {
      next(new HttpError(415, 'send the request body as JSON'));
      return;
    }
    next();
  };
}

/** A person's budget of comment writes. */
export function writeBudget(limits: ShareLimits): RequestHandler {
  return (req, res, next) => {
    const key = req.auth?.accountId ?? req.ip ?? 'unknown';
    if (!limits.writes.take(key)) {
      next(tooMany(res, limits.writes.retryAfter(key)));
      return;
    }
    next();
  };
}
